//! Kode's own 1:N palm sign-in through Palm's H5 SDK.
//!
//! Enrolment registers the palm under the Kode account id itself, so a 1:N
//! match *is* the account: no mapping table. Clients run the SDK in a page
//! the relay serves (`/palm/capture`, an HTTPS origin for every host) and
//! hand back only the SDK's `sessionId`. The relay never trusts the
//! client-reported user id; it reads the session with its api_key and signs
//! the CloudBase custom-login ticket for the user Palm matched.
//!
//! Sign-up needs no other account: the relay mints a fresh account id,
//! hands out an SDK token that can only enrol that id, and creates the
//! CloudBase user once Palm confirms a registration for it. The SDK rejects
//! a palm already in the library (10103/10104), so one palm is one account.
//!
//! Palm sessions stay readable for two hours and cannot be told apart from
//! 1:1 compares, so each one is claimed once in `kode_palm_sessions` and
//! must be a positive search result.

use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap},
    response::{Html, IntoResponse, Response},
    Json,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    palmx::{BoxFuture, CloudServices, PalmxServices, TokenSet},
    ApiError, RelayState,
};

const CAPTURE_HTML: &str = include_str!("palm_capture.html");
/// Palm business code: the session is unknown or past its two hours.
const PALM_SESSION_MISSING: i64 = 2080024;
/// Palm business code: the user has no enrolled palm.
const PALM_USER_EMPTY: i64 = 2080009;
const HANDOFF_TTL: Duration = Duration::from_secs(120);
const REGISTRATION_TTL: Duration = Duration::from_secs(600);
/// Sign-ups per minute across all clients; each one costs library capacity.
const REGISTRATIONS_PER_MINUTE: usize = 10;
const ENROLL_TOKEN_TTL_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PalmError {
    /// The session is unknown, expired, not a positive 1:N match, or used.
    Rejected(&'static str),
    Upstream(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PalmSession {
    pub user_id: String,
    /// `Some(is_match)` for search/compare sessions, `None` otherwise.
    pub search_match: Option<bool>,
    pub registration: bool,
}

pub trait PalmServices: Send + Sync + 'static {
    fn session<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<PalmSession, PalmError>>;
    /// Records a session as used; `false` if it was used before.
    fn claim<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<bool, PalmError>>;
    fn user_token<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<String, PalmError>>;
    /// Enrolled palm directions (1 left, 2 right); empty when none.
    fn enrolled<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<Vec<u8>, PalmError>>;
    fn forget<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<(), PalmError>>;
    /// CloudBase tokens for `uid`, as a session of the client `device_id`.
    fn sign_in<'a>(
        &'a self,
        uid: &'a str,
        device_id: &'a str,
    ) -> BoxFuture<'a, Result<TokenSet, PalmError>>;
}

struct Handoff {
    secret_hash: [u8; 32],
    expires: tokio::time::Instant,
    /// The waiting desktop's device id: the session is the desktop's, not
    /// the approving phone's.
    device_id: String,
    tokens: Option<TokenSet>,
}

struct Registration {
    user_id: String,
    secret_hash: [u8; 32],
    expires: tokio::time::Instant,
}

pub struct Palm {
    pub app_id: String,
    /// The H5 SDK loader script the capture page loads.
    pub sdk_url: String,
    services: Arc<dyn PalmServices>,
    handoffs: Mutex<HashMap<String, Handoff>>,
    registrations: Mutex<HashMap<String, Registration>>,
    recent: Mutex<std::collections::VecDeque<tokio::time::Instant>>,
    recent_signups: Mutex<std::collections::VecDeque<tokio::time::Instant>>,
}

impl Palm {
    pub fn new(app_id: String, sdk_url: String, services: Arc<dyn PalmServices>) -> Self {
        Self {
            app_id,
            sdk_url,
            services,
            handoffs: Mutex::new(HashMap::new()),
            registrations: Mutex::new(HashMap::new()),
            recent: Mutex::new(Default::default()),
            recent_signups: Mutex::new(Default::default()),
        }
    }

    /// Verification calls per minute across all clients.
    fn admit(&self) -> Result<(), ApiError> {
        within_rate(&self.recent, 120)
    }

    /// The account a capture session proves, consuming the session.
    async fn verify(&self, session_id: &str) -> Result<String, ApiError> {
        if session_id.is_empty() || session_id.len() > 128 {
            return Err(ApiError::BadRequest("session_id is required".into()));
        }
        self.admit()?;
        let session = self.services.session(session_id).await.map_err(map)?;
        if session.registration
            || session.search_match != Some(true)
            || !valid_user_id(&session.user_id)
        {
            return Err(map(PalmError::Rejected(
                "this palm scan did not match an enrolled account",
            )));
        }
        if !self.services.claim(session_id).await.map_err(map)? {
            return Err(ApiError::Conflict(
                "this palm scan was already used; scan again".into(),
            ));
        }
        Ok(session.user_id)
    }

    async fn sign_in_session(&self, session_id: &str, device_id: &str) -> Result<TokenSet, ApiError> {
        let uid = self.verify(session_id).await?;
        let tokens = self.services.sign_in(&uid, device_id).await.map_err(map)?;
        tracing::info!(sub = %tokens.sub, "palm sign-in");
        Ok(tokens)
    }
}

fn within_rate(
    window: &Mutex<std::collections::VecDeque<tokio::time::Instant>>,
    per_minute: usize,
) -> Result<(), ApiError> {
    let now = tokio::time::Instant::now();
    let mut recent = window.lock();
    while recent
        .front()
        .is_some_and(|at| now.duration_since(*at) > Duration::from_secs(60))
    {
        recent.pop_front();
    }
    if recent.len() >= per_minute {
        return Err(ApiError::TooManyRequests);
    }
    recent.push_back(now);
    Ok(())
}

/// Palm user ids: 1-64 of `[A-Za-z0-9_-]`. CloudBase subs (digits, `px_…`)
/// fit as-is.
fn valid_user_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn map(error: PalmError) -> ApiError {
    match error {
        PalmError::Rejected(detail) => ApiError::SignInRejected(detail.into()),
        PalmError::Upstream(detail) => {
            tracing::warn!(%detail, "palm upstream failure");
            ApiError::BadGateway("palm sign-in is unavailable; retry shortly".into())
        }
    }
}

fn palm(state: &RelayState) -> Result<&Palm, ApiError> {
    state
        .palm()
        .ok_or_else(|| ApiError::NotFound("palm sign-in is not enabled on this relay".into()))
}

fn tokens_json(tokens: &TokenSet) -> Value {
    json!({
        "token_type": "Bearer",
        "access_token": tokens.access_token,
        "refresh_token": tokens.refresh_token,
        "expires_in": tokens.expires_in,
        "sub": tokens.sub,
        "provider": "palm",
    })
}

/// `GET /palm/capture`: the page hosts load to run the H5 SDK.
pub(crate) async fn capture(State(state): State<RelayState>) -> Result<Response, ApiError> {
    let palm = palm(&state)?;
    let origin = url_origin(&palm.sdk_url);
    let csp = format!(
        "default-src 'none'; script-src 'unsafe-inline' {origin}; frame-src {origin}; \
         connect-src {origin}; style-src 'unsafe-inline'; img-src data: {origin}"
    );
    // Clients fetch this page and load it locally (CloudBase test domains
    // interpose a notice page on browser navigations), so the policy must
    // travel inside the document too.
    let html = CAPTURE_HTML
        .replace("__KODE_PALM_LOADER__", &palm.sdk_url)
        .replace("__KODE_PALM_CSP__", &csp);
    Ok((
        [
            (header::CONTENT_SECURITY_POLICY, csp),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Html(html),
    )
        .into_response())
}

fn url_origin(url: &str) -> String {
    let rest = url.splitn(4, '/').collect::<Vec<_>>();
    if rest.len() >= 3 {
        format!("{}//{}", rest[0], rest[2])
    } else {
        url.to_string()
    }
}

#[derive(Deserialize)]
pub(crate) struct SessionRequest {
    session_id: String,
}

/// `POST /api/v1/auth/palm`: sign in with a capture session.
pub(crate) async fn sign_in(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(req): Json<SessionRequest>,
) -> Result<Json<Value>, ApiError> {
    let device_id = crate::client_device_id(&headers);
    let tokens = palm(&state)?.sign_in_session(&req.session_id, &device_id).await?;
    Ok(Json(tokens_json(&tokens)))
}

/// `POST /api/v1/auth/palm/register`: starts a palm-only sign-up. The
/// account id is the relay's, never the client's.
pub(crate) async fn register_start(
    State(state): State<RelayState>,
) -> Result<Json<Value>, ApiError> {
    let palm = palm(&state)?;
    within_rate(&palm.recent_signups, REGISTRATIONS_PER_MINUTE)?;
    let user_id = format!("pl_{}", &uuid::Uuid::new_v4().simple().to_string()[..28]);
    let token = palm.services.user_token(&user_id).await.map_err(map)?;
    let id = random_id();
    let secret = random_id();
    let now = tokio::time::Instant::now();
    {
        let mut registrations = palm.registrations.lock();
        registrations.retain(|_, r| r.expires > now);
        registrations.insert(
            id.clone(),
            Registration {
                user_id: user_id.clone(),
                secret_hash: digest(&secret),
                expires: now + REGISTRATION_TTL,
            },
        );
    }
    Ok(Json(json!({
        "registration_id": id,
        "secret": secret,
        "user_id": user_id,
        "token": token,
        "app_id": palm.app_id,
        "expires_in": REGISTRATION_TTL.as_secs(),
    })))
}

#[derive(Deserialize)]
pub(crate) struct RegisterFinish {
    registration_id: String,
    secret: String,
    session_id: String,
}

/// `POST /api/v1/auth/palm/register/finish`: Palm confirmed the enrolment
/// for the minted id; create the account and sign it in.
pub(crate) async fn register_finish(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(req): Json<RegisterFinish>,
) -> Result<Json<Value>, ApiError> {
    let palm = palm(&state)?;
    let expired = || ApiError::NotFound("this sign-up expired; start again".into());
    let user_id = {
        let registrations = palm.registrations.lock();
        let registration = registrations
            .get(&req.registration_id)
            .filter(|r| r.expires > tokio::time::Instant::now())
            .ok_or_else(expired)?;
        if registration.secret_hash != digest(&req.secret) {
            return Err(expired());
        }
        registration.user_id.clone()
    };
    if req.session_id.is_empty() || req.session_id.len() > 128 {
        return Err(ApiError::BadRequest("session_id is required".into()));
    }
    palm.admit()?;
    let session = palm.services.session(&req.session_id).await.map_err(map)?;
    if !session.registration || session.user_id != user_id {
        return Err(map(PalmError::Rejected(
            "this palm scan did not enrol the new account",
        )));
    }
    if !palm.services.claim(&req.session_id).await.map_err(map)? {
        return Err(ApiError::Conflict("this palm scan was already used".into()));
    }
    palm.registrations.lock().remove(&req.registration_id);
    let device_id = crate::client_device_id(&headers);
    let tokens = palm.services.sign_in(&user_id, &device_id).await.map_err(map)?;
    tracing::info!(sub = %tokens.sub, "palm sign-up");
    Ok(Json(tokens_json(&tokens)))
}

/// `POST /api/v1/palm/enroll_token`: a short-lived SDK token that can only
/// enrol the caller's own account.
pub(crate) async fn enroll_token(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let palm = palm(&state)?;
    if !valid_user_id(&caller.user_id) {
        return Err(ApiError::BadRequest(
            "this account id cannot hold a palm".into(),
        ));
    }
    let token = palm
        .services
        .user_token(&caller.user_id)
        .await
        .map_err(map)?;
    Ok(Json(
        json!({ "token": token, "user_id": caller.user_id, "app_id": palm.app_id }),
    ))
}

/// `GET /api/v1/palm`.
pub(crate) async fn status(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let sides = palm(&state)?
        .services
        .enrolled(&caller.user_id)
        .await
        .map_err(map)?;
    Ok(Json(
        json!({ "enrolled": !sides.is_empty(), "sides": sides }),
    ))
}

/// `DELETE /api/v1/palm`.
pub(crate) async fn forget(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    palm(&state)?
        .services
        .forget(&caller.user_id)
        .await
        .map_err(map)?;
    Ok(Json(json!({ "enrolled": false, "sides": [] })))
}

fn digest(secret: &str) -> [u8; 32] {
    Sha256::digest(secret.as_bytes()).into()
}

fn random_id() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// `POST /api/v1/auth/palm/handoff`: a desktop without a usable camera asks
/// a phone to scan for it. The desktop keeps `secret`; the QR carries only
/// the id.
pub(crate) async fn handoff_start(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let palm = palm(&state)?;
    let id = random_id();
    let secret = random_id();
    let now = tokio::time::Instant::now();
    let mut handoffs = palm.handoffs.lock();
    handoffs.retain(|_, h| h.expires > now);
    if handoffs.len() >= 1000 {
        return Err(ApiError::TooManyRequests);
    }
    handoffs.insert(
        id.clone(),
        Handoff {
            secret_hash: digest(&secret),
            expires: now + HANDOFF_TTL,
            device_id: crate::client_device_id(&headers),
            tokens: None,
        },
    );
    Ok(Json(
        json!({ "handoff_id": id, "secret": secret, "expires_in": HANDOFF_TTL.as_secs() }),
    ))
}

#[derive(Deserialize)]
pub(crate) struct HandoffPoll {
    secret: String,
}

/// `GET /api/v1/auth/palm/handoff/:id?secret=`: tokens are released once.
pub(crate) async fn handoff_poll(
    State(state): State<RelayState>,
    Path(id): Path<String>,
    Query(query): Query<HandoffPoll>,
) -> Result<Json<Value>, ApiError> {
    let palm = palm(&state)?;
    let mut handoffs = palm.handoffs.lock();
    let now = tokio::time::Instant::now();
    let Some(handoff) = handoffs.get(&id).filter(|h| h.expires > now) else {
        handoffs.remove(&id);
        return Err(ApiError::NotFound(
            "this sign-in request expired; start again".into(),
        ));
    };
    if handoff.secret_hash != digest(&query.secret) {
        return Err(ApiError::NotFound(
            "this sign-in request expired; start again".into(),
        ));
    }
    match handoff.tokens.clone() {
        Some(tokens) => {
            handoffs.remove(&id);
            Ok(Json(
                json!({ "state": "approved", "tokens": tokens_json(&tokens) }),
            ))
        }
        None => Ok(Json(json!({ "state": "pending" }))),
    }
}

/// `POST /api/v1/auth/palm/handoff/:id/approve {session_id}`: the phone's
/// palm scan signs the waiting desktop into the matched account.
pub(crate) async fn handoff_approve(
    State(state): State<RelayState>,
    Path(id): Path<String>,
    Json(req): Json<SessionRequest>,
) -> Result<Json<Value>, ApiError> {
    let palm = palm(&state)?;
    let live = |handoffs: &HashMap<String, Handoff>| {
        handoffs
            .get(&id)
            .is_some_and(|h| h.expires > tokio::time::Instant::now() && h.tokens.is_none())
    };
    let device_id = {
        let handoffs = palm.handoffs.lock();
        if !live(&handoffs) {
            return Err(ApiError::NotFound(
                "this sign-in request expired; start again".into(),
            ));
        }
        handoffs[&id].device_id.clone()
    };
    let tokens = palm.sign_in_session(&req.session_id, &device_id).await?;
    let mut handoffs = palm.handoffs.lock();
    if !live(&handoffs) {
        return Err(ApiError::NotFound(
            "this sign-in request expired; start again".into(),
        ));
    }
    if let Some(handoff) = handoffs.get_mut(&id) {
        handoff.tokens = Some(tokens);
    }
    Ok(Json(json!({ "state": "approved" })))
}

/// Palm OpenAPI answers HTTP 200 with a business `code`.
async fn palm_call(
    services: &CloudServices,
    path: &str,
    body: Value,
) -> Result<Value, (i64, String)> {
    let response = services
        .http
        .post(format!("{}{path}", services.palmx_base))
        .bearer_auth(&services.palmx_api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| (-1, e.to_string()))?;
    let body: Value = response.json().await.map_err(|e| (-1, e.to_string()))?;
    match body["code"].as_i64() {
        Some(0) => Ok(body["data"].clone()),
        code => Err((
            code.unwrap_or(-1),
            body["message"].as_str().unwrap_or_default().to_string(),
        )),
    }
}

fn upstream(path: &str) -> impl Fn((i64, String)) -> PalmError + '_ {
    move |(code, message)| PalmError::Upstream(format!("{path}: {code} {message}"))
}

impl PalmServices for CloudServices {
    fn session<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<PalmSession, PalmError>> {
        Box::pin(async move {
            let data = match palm_call(
                self,
                "/palm/openai/get_session_result",
                json!({"SessionId": session_id}),
            )
            .await
            {
                Ok(data) => data,
                Err((PALM_SESSION_MISSING, _)) => {
                    return Err(PalmError::Rejected("this palm scan expired; scan again"))
                }
                Err(error) => return Err(upstream("get_session_result")(error)),
            };
            let search = &data["SearchResult"];
            Ok(PalmSession {
                user_id: data["UserId"].as_str().unwrap_or_default().to_string(),
                search_match: search
                    .is_object()
                    .then(|| search["IsMatch"].as_bool().unwrap_or(false)),
                registration: data["RegisterResult"].is_object(),
            })
        })
    }

    fn claim<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<bool, PalmError>> {
        Box::pin(async move {
            let response = self
                .http
                .post(format!("{}/v1/rdb/rest/kode_palm_sessions", self.issuer))
                .bearer_auth(&self.service_key)
                .json(&json!({"session_id": session_id}))
                .send()
                .await
                .map_err(|e| PalmError::Upstream(format!("claim: {e}")))?;
            match response.status().as_u16() {
                200..=299 => Ok(true),
                409 => Ok(false),
                status => Err(PalmError::Upstream(format!("claim: {status}"))),
            }
        })
    }

    fn user_token<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<String, PalmError>> {
        Box::pin(async move {
            let path = "/palm/openai/x/oauth/sdk/usertoken/create";
            let data = palm_call(
                self,
                path,
                json!({"UserId": user_id, "TtlSeconds": ENROLL_TOKEN_TTL_SECS}),
            )
            .await
            .map_err(upstream(path))?;
            data["Token"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| PalmError::Upstream("usertoken/create returned no token".into()))
        })
    }

    fn enrolled<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<Vec<u8>, PalmError>> {
        Box::pin(async move {
            match palm_call(self, "/palm/openai/get_palm", json!({"UserId": user_id})).await {
                Ok(data) => Ok([("LeftPalm", 1u8), ("RightPalm", 2u8)]
                    .into_iter()
                    .filter(|(key, _)| data[*key].is_object())
                    .map(|(_, side)| side)
                    .collect()),
                Err((PALM_USER_EMPTY, _)) => Ok(Vec::new()),
                Err(error) => Err(upstream("get_palm")(error)),
            }
        })
    }

    fn forget<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<(), PalmError>> {
        Box::pin(async move {
            match palm_call(
                self,
                "/palm/openai/delete_palm",
                json!({"UserId": user_id, "PalmDirectionList": [1, 2]}),
            )
            .await
            {
                Ok(_) | Err((PALM_USER_EMPTY, _)) => Ok(()),
                Err(error) => Err(upstream("delete_palm")(error)),
            }
        })
    }

    fn sign_in<'a>(
        &'a self,
        uid: &'a str,
        device_id: &'a str,
    ) -> BoxFuture<'a, Result<TokenSet, PalmError>> {
        Box::pin(async move {
            PalmxServices::sign_in(self, uid, device_id)
                .await
                .map_err(|error| PalmError::Upstream(format!("custom sign-in: {error:?}")))
        })
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use std::collections::{HashMap, HashSet};

    use super::*;

    #[derive(Default)]
    pub struct FakePalm {
        pub sessions: Mutex<HashMap<String, PalmSession>>,
        pub claimed: Mutex<HashSet<String>>,
        pub enrolled: Mutex<HashMap<String, Vec<u8>>>,
        pub tokens_for: Mutex<Vec<String>>,
        /// `x-device-id` of every sign-in, in order.
        pub devices: Mutex<Vec<String>>,
    }

    impl FakePalm {
        pub fn enrol(&self, session: &str, user: &str) {
            self.sessions.lock().insert(
                session.into(),
                PalmSession {
                    user_id: user.into(),
                    search_match: None,
                    registration: true,
                },
            );
        }

        pub fn scan(&self, session: &str, user: &str) {
            self.sessions.lock().insert(
                session.into(),
                PalmSession {
                    user_id: user.into(),
                    search_match: Some(true),
                    registration: false,
                },
            );
        }
    }

    impl PalmServices for FakePalm {
        fn session<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<PalmSession, PalmError>> {
            let found = self
                .sessions
                .lock()
                .get(id)
                .cloned()
                .ok_or(PalmError::Rejected("expired"));
            Box::pin(async move { found })
        }
        fn claim<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool, PalmError>> {
            let fresh = self.claimed.lock().insert(id.into());
            Box::pin(async move { Ok(fresh) })
        }
        fn user_token<'a>(&'a self, user: &'a str) -> BoxFuture<'a, Result<String, PalmError>> {
            self.tokens_for.lock().push(user.into());
            Box::pin(async move { Ok(format!("sut_{user}")) })
        }
        fn enrolled<'a>(&'a self, user: &'a str) -> BoxFuture<'a, Result<Vec<u8>, PalmError>> {
            let sides = self.enrolled.lock().get(user).cloned().unwrap_or_default();
            Box::pin(async move { Ok(sides) })
        }
        fn forget<'a>(&'a self, user: &'a str) -> BoxFuture<'a, Result<(), PalmError>> {
            self.enrolled.lock().remove(user);
            Box::pin(async move { Ok(()) })
        }
        fn sign_in<'a>(
            &'a self,
            uid: &'a str,
            device_id: &'a str,
        ) -> BoxFuture<'a, Result<TokenSet, PalmError>> {
            self.devices.lock().push(device_id.into());
            Box::pin(async move {
                Ok(TokenSet {
                    access_token: format!("tok-{uid}"),
                    refresh_token: "r".into(),
                    expires_in: 7200,
                    sub: uid.into(),
                })
            })
        }
    }
}
