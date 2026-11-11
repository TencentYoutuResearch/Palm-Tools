//! PalmX palm-scan sign-in.
//!
//! The client runs PalmX's QR flow itself (no secret involved) and hands the
//! relay the authorization `code` plus its PKCE `code_verifier`. Only the
//! relay holds the PalmX API key and the CloudBase custom-login key:
//!
//! 1. exchange the code at PalmX for the user's `OpenId`;
//! 2. pick the CloudBase user: the account the OpenId was bound to, or a
//!    deterministic `px_…` id for an unbound palm;
//! 3. sign a CloudBase custom-login ticket for that user and return the
//!    provider's own access/refresh tokens.
//!
//! The rest of the relay is unchanged: those tokens verify against the same
//! JWKS and their `sub` is the tenant. Bindings live in the CloudBase table
//! `kode_palmx_bindings`, reachable only with the server API key.

use std::{collections::VecDeque, future::Future, pin::Pin, sync::Arc, time::Duration};

use axum::{extract::State, http::HeaderMap, Json};
use base64::Engine;
use parking_lot::Mutex;
use rsa::{
    pkcs1::DecodeRsaPrivateKey,
    pkcs1v15::SigningKey,
    pkcs8::DecodePrivateKey,
    signature::{SignatureEncoding, Signer},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{now_ms, ApiError, RelayState};

/// Unbound palms get CloudBase user ids in their own namespace. CloudBase
/// assigns numeric ids to every other sign-in method, so these never collide.
const PALMX_UID_PREFIX: &str = "px_";
/// Exchanges per minute across all clients. Codes are single-use at PalmX;
/// this only stops a flood from burning the relay's API quota.
const EXCHANGES_PER_MINUTE: usize = 60;
/// PalmX business code for an expired, unknown or already-used authorization.
const PALMX_INVALID_CODE: i64 = 2090007;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PalmxError {
    /// PalmX rejected the code or verifier.
    InvalidCode,
    /// The OpenId is bound to another account.
    AlreadyBound,
    /// PalmX, CloudBase or the binding table did not answer usefully.
    Upstream(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub sub: String,
}

/// Everything the PalmX flow needs from the outside world.
pub trait PalmxServices: Send + Sync + 'static {
    /// PalmX code + verifier → OpenId.
    fn exchange<'a>(
        &'a self,
        code: &'a str,
        verifier: &'a str,
    ) -> BoxFuture<'a, Result<String, PalmxError>>;
    /// CloudBase tokens for `uid` via a signed custom-login ticket, as a
    /// session of the client device `device_id`.
    fn sign_in<'a>(
        &'a self,
        uid: &'a str,
        device_id: &'a str,
    ) -> BoxFuture<'a, Result<TokenSet, PalmxError>>;
    fn bound_user<'a>(
        &'a self,
        open_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, PalmxError>>;
    fn user_binding<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<bool, PalmxError>>;
    /// Fails with `AlreadyBound` when the OpenId or the user is taken.
    fn bind<'a>(
        &'a self,
        open_id: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, Result<(), PalmxError>>;
    fn unbind<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<(), PalmxError>>;
}

pub struct Palmx {
    pub app_id: String,
    pub base_url: String,
    services: Arc<dyn PalmxServices>,
    recent: Mutex<VecDeque<tokio::time::Instant>>,
}

impl Palmx {
    pub fn new(app_id: String, base_url: String, services: Arc<dyn PalmxServices>) -> Self {
        Self {
            app_id,
            base_url: base_url.trim_end_matches('/').to_string(),
            services,
            recent: Mutex::new(VecDeque::new()),
        }
    }

    pub(crate) fn admit(&self) -> Result<(), ApiError> {
        let now = tokio::time::Instant::now();
        let mut recent = self.recent.lock();
        while recent
            .front()
            .is_some_and(|at| now.duration_since(*at) > Duration::from_secs(60))
        {
            recent.pop_front();
        }
        if recent.len() >= EXCHANGES_PER_MINUTE {
            return Err(ApiError::TooManyRequests);
        }
        recent.push_back(now);
        Ok(())
    }

    async fn open_id(&self, req: &CodeRequest) -> Result<String, ApiError> {
        if req.code.is_empty()
            || req.code.len() > 256
            || req.code_verifier.len() < 43
            || req.code_verifier.len() > 128
        {
            return Err(ApiError::BadRequest(
                "code and code_verifier are required".into(),
            ));
        }
        self.admit()?;
        self.services
            .exchange(&req.code, &req.code_verifier)
            .await
            .map_err(upstream)
    }
}

/// Deterministic CloudBase user id for a palm with no binding.
pub fn derived_uid(open_id: &str) -> String {
    let digest = Sha256::digest(format!("palmx:{open_id}").as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{PALMX_UID_PREFIX}{}", &hex[..28])
}

fn upstream(error: PalmxError) -> ApiError {
    match error {
        PalmxError::InvalidCode => ApiError::BadRequest(
            "the PalmX authorization expired or was already used; scan again".into(),
        ),
        PalmxError::AlreadyBound => {
            ApiError::Conflict("this palm is already linked to another Kode account".into())
        }
        PalmxError::Upstream(detail) => {
            tracing::warn!(%detail, "palmx upstream failure");
            ApiError::BadGateway("PalmX sign-in is unavailable; retry shortly".into())
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct CodeRequest {
    code: String,
    code_verifier: String,
}

fn palmx(state: &RelayState) -> Result<&Palmx, ApiError> {
    state
        .palmx()
        .ok_or_else(|| ApiError::NotFound("PalmX sign-in is not enabled on this relay".into()))
}

/// `POST /api/v1/auth/palmx`: sign in with a confirmed PalmX authorization.
pub(crate) async fn sign_in(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(req): Json<CodeRequest>,
) -> Result<Json<Value>, ApiError> {
    let palmx = palmx(&state)?;
    let open_id = palmx.open_id(&req).await?;
    let uid = match palmx
        .services
        .bound_user(&open_id)
        .await
        .map_err(upstream)?
    {
        Some(user_id) => user_id,
        None => derived_uid(&open_id),
    };
    let device_id = crate::client_device_id(&headers);
    let tokens = palmx.services.sign_in(&uid, &device_id).await.map_err(upstream)?;
    tracing::info!(sub = %tokens.sub, "palmx sign-in");
    Ok(Json(json!({
        "token_type": "Bearer",
        "access_token": tokens.access_token,
        "refresh_token": tokens.refresh_token,
        "expires_in": tokens.expires_in,
        "sub": tokens.sub,
        "provider": "palmx",
    })))
}

/// `POST /api/v1/auth/palmx/bind`: link the scanned palm to the caller's
/// account so later palm sign-ins land in it.
pub(crate) async fn bind(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(req): Json<CodeRequest>,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let palmx = palmx(&state)?;
    if caller.user_id.starts_with(PALMX_UID_PREFIX) {
        return Err(ApiError::BadRequest(
            "this account already signs in with PalmX".into(),
        ));
    }
    let open_id = palmx.open_id(&req).await?;
    match palmx
        .services
        .bound_user(&open_id)
        .await
        .map_err(upstream)?
    {
        Some(user_id) if user_id == caller.user_id => {}
        Some(_) => return Err(upstream(PalmxError::AlreadyBound)),
        None => palmx
            .services
            .bind(&open_id, &caller.user_id)
            .await
            .map_err(upstream)?,
    }
    tracing::info!(user = %caller.user_id, "palmx bound");
    Ok(Json(json!({ "linked": ["palmx"] })))
}

/// `DELETE /api/v1/auth/palmx/bind`.
pub(crate) async fn unbind(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    palmx(&state)?
        .services
        .unbind(&caller.user_id)
        .await
        .map_err(upstream)?;
    Ok(Json(json!({ "linked": [] })))
}

/// `GET /api/v1/account/logins`: sign-in methods linked to this account
/// beyond the one used to create it.
pub(crate) async fn linked(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let mut linked = Vec::new();
    if caller.user_id.starts_with(PALMX_UID_PREFIX) {
        linked.push("palmx");
    } else if let Some(palmx) = state.palmx() {
        if palmx
            .services
            .user_binding(&caller.user_id)
            .await
            .map_err(upstream)?
        {
            linked.push("palmx");
        }
    }
    Ok(Json(json!({ "linked": linked })))
}

/// Production wiring: PalmX's token API, CloudBase custom login, and the
/// binding table through CloudBase's PostgreSQL REST API.
pub struct CloudServices {
    pub(crate) http: reqwest::Client,
    pub(crate) palmx_base: String,
    pub(crate) palmx_api_key: String,
    pub(crate) issuer: String,
    env_id: String,
    key_id: String,
    signer: SigningKey<Sha256>,
    pub(crate) service_key: String,
}

/// The JSON CloudBase issues with a custom-login key.
#[derive(Deserialize)]
pub struct CustomLoginKey {
    pub env_id: String,
    pub private_key_id: String,
    pub private_key: String,
}

impl CloudServices {
    pub fn new(
        palmx_base: &str,
        palmx_api_key: String,
        issuer: &str,
        key: CustomLoginKey,
        service_key: String,
    ) -> anyhow::Result<Self> {
        // CloudBase issues 1024-bit custom-login keys, below what ring will
        // sign with, so the ticket is signed with the rsa crate.
        let private = rsa::RsaPrivateKey::from_pkcs1_pem(&key.private_key)
            .or_else(|_| rsa::RsaPrivateKey::from_pkcs8_pem(&key.private_key))
            .map_err(|error| anyhow::anyhow!("invalid custom-login private key: {error}"))?;
        Ok(Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()?,
            palmx_base: palmx_base.trim_end_matches('/').to_string(),
            palmx_api_key,
            issuer: issuer.trim_end_matches('/').to_string(),
            env_id: key.env_id,
            key_id: key.private_key_id,
            signer: SigningKey::<Sha256>::new(private),
            service_key,
        })
    }

    /// `<key id>/@@/<RS256 JWT>`, matching the CloudBase admin SDK. Times
    /// in the payload are epoch milliseconds.
    fn ticket(&self, uid: &str) -> String {
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let now = now_ms();
        let header = b64(br#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = b64(json!({
            "alg": "RS256",
            "env": self.env_id,
            "iat": now,
            "exp": now + 10 * 60 * 1000,
            "uid": uid,
            "refresh": 3600 * 1000,
            "expire": now + 7 * 24 * 3600 * 1000,
        })
        .to_string()
        .as_bytes());
        let signing_input = format!("{header}.{payload}");
        let signature = self.signer.sign(signing_input.as_bytes()).to_vec();
        format!("{}/@@/{signing_input}.{}", self.key_id, b64(&signature))
    }

    fn table(&self) -> String {
        format!("{}/v1/rdb/rest/kode_palmx_bindings", self.issuer)
    }

    async fn rows(&self, filter: &str) -> Result<Vec<Value>, PalmxError> {
        let response = self
            .http
            .get(format!("{}?{filter}&select=open_id,user_id", self.table()))
            .bearer_auth(&self.service_key)
            .send()
            .await
            .map_err(|e| PalmxError::Upstream(format!("bindings: {e}")))?;
        if !response.status().is_success() {
            return Err(PalmxError::Upstream(format!(
                "bindings: {}",
                response.status()
            )));
        }
        response
            .json()
            .await
            .map_err(|e| PalmxError::Upstream(format!("bindings: {e}")))
    }
}

/// Filter values in PostgREST query strings must be URL-encoded.
pub(crate) fn eq(column: &str, value: &str) -> String {
    let encoded: String = url_encode(value);
    format!("{column}=eq.{encoded}")
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

impl PalmxServices for CloudServices {
    fn exchange<'a>(
        &'a self,
        code: &'a str,
        verifier: &'a str,
    ) -> BoxFuture<'a, Result<String, PalmxError>> {
        Box::pin(async move {
            let response = self
                .http
                .post(format!("{}/palm/openai/x/oauth/token", self.palmx_base))
                .bearer_auth(&self.palmx_api_key)
                .json(&json!({"GrantType": "authorization_code", "Code": code, "CodeVerifier": verifier}))
                .send()
                .await
                .map_err(|e| PalmxError::Upstream(format!("palmx token: {e}")))?;
            let status = response.status();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            if let Some(open_id) = body["data"]["OpenId"].as_str().filter(|id| !id.is_empty()) {
                return Ok(open_id.to_string());
            }
            // PalmX answers HTTP 200 with a business code. Only an invalid or
            // reused code is the user's to fix; anything else (e.g. 2060203,
            // a rejected API key) is ours and must not ask them to rescan.
            if body["code"].as_i64() == Some(PALMX_INVALID_CODE) {
                return Err(PalmxError::InvalidCode);
            }
            tracing::warn!(%status, code = ?body["code"], message = ?body["message"], "palmx token exchange failed");
            Err(PalmxError::Upstream(format!(
                "palmx token: {status} code {}",
                body["code"]
            )))
        })
    }

    fn sign_in<'a>(
        &'a self,
        uid: &'a str,
        device_id: &'a str,
    ) -> BoxFuture<'a, Result<TokenSet, PalmxError>> {
        Box::pin(async move {
            let response = self
                .http
                .post(format!("{}/auth/v1/signin/custom", self.issuer))
                .header("x-device-id", device_id)
                .json(&json!({"provider_id": "custom", "ticket": self.ticket(uid)}))
                .send()
                .await
                .map_err(|e| PalmxError::Upstream(format!("custom sign-in: {e}")))?;
            let status = response.status();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            match serde_json::from_value::<TokenSet>(body.clone()) {
                Ok(tokens) if tokens.sub == uid => Ok(tokens),
                Ok(tokens) => Err(PalmxError::Upstream(format!(
                    "custom sign-in returned sub {} for {uid}",
                    tokens.sub
                ))),
                Err(_) => Err(PalmxError::Upstream(format!(
                    "custom sign-in: {status} {}",
                    body["error_description"].as_str().unwrap_or_default()
                ))),
            }
        })
    }

    fn bound_user<'a>(
        &'a self,
        open_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, PalmxError>> {
        Box::pin(async move {
            Ok(self
                .rows(&eq("open_id", open_id))
                .await?
                .first()
                .and_then(|row| row["user_id"].as_str())
                .map(str::to_string))
        })
    }

    fn user_binding<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<bool, PalmxError>> {
        Box::pin(async move { Ok(!self.rows(&eq("user_id", user_id)).await?.is_empty()) })
    }

    fn bind<'a>(
        &'a self,
        open_id: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, Result<(), PalmxError>> {
        Box::pin(async move {
            let response = self
                .http
                .post(self.table())
                .bearer_auth(&self.service_key)
                .json(&json!({"open_id": open_id, "user_id": user_id}))
                .send()
                .await
                .map_err(|e| PalmxError::Upstream(format!("bind: {e}")))?;
            match response.status().as_u16() {
                200..=299 => Ok(()),
                409 => Err(PalmxError::AlreadyBound),
                status => Err(PalmxError::Upstream(format!("bind: {status}"))),
            }
        })
    }

    fn unbind<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<(), PalmxError>> {
        Box::pin(async move {
            let response = self
                .http
                .delete(format!("{}?{}", self.table(), eq("user_id", user_id)))
                .bearer_auth(&self.service_key)
                .send()
                .await
                .map_err(|e| PalmxError::Upstream(format!("unbind: {e}")))?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(PalmxError::Upstream(format!(
                    "unbind: {}",
                    response.status()
                )))
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use std::collections::HashMap;

    use super::*;

    /// In-memory PalmX + CloudBase. Codes map to OpenIds and are single-use.
    #[derive(Default)]
    pub struct FakeServices {
        pub codes: Mutex<HashMap<String, String>>,
        pub bindings: Mutex<HashMap<String, String>>,
        pub signed: Mutex<Vec<String>>,
    }

    impl FakeServices {
        pub fn issue(&self, code: &str, open_id: &str) {
            self.codes.lock().insert(code.into(), open_id.into());
        }
    }

    impl PalmxServices for FakeServices {
        fn exchange<'a>(
            &'a self,
            code: &'a str,
            _verifier: &'a str,
        ) -> BoxFuture<'a, Result<String, PalmxError>> {
            let result = self
                .codes
                .lock()
                .remove(code)
                .ok_or(PalmxError::InvalidCode);
            Box::pin(async move { result })
        }
        fn sign_in<'a>(
            &'a self,
            uid: &'a str,
            _device_id: &'a str,
        ) -> BoxFuture<'a, Result<TokenSet, PalmxError>> {
            self.signed.lock().push(uid.into());
            Box::pin(async move {
                Ok(TokenSet {
                    access_token: format!("tok-{uid}"),
                    refresh_token: "refresh".into(),
                    expires_in: 7200,
                    sub: uid.into(),
                })
            })
        }
        fn bound_user<'a>(
            &'a self,
            open_id: &'a str,
        ) -> BoxFuture<'a, Result<Option<String>, PalmxError>> {
            let found = self.bindings.lock().get(open_id).cloned();
            Box::pin(async move { Ok(found) })
        }
        fn user_binding<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<bool, PalmxError>> {
            let found = self.bindings.lock().values().any(|u| u == user_id);
            Box::pin(async move { Ok(found) })
        }
        fn bind<'a>(
            &'a self,
            open_id: &'a str,
            user_id: &'a str,
        ) -> BoxFuture<'a, Result<(), PalmxError>> {
            let mut bindings = self.bindings.lock();
            let result =
                if bindings.contains_key(open_id) || bindings.values().any(|u| u == user_id) {
                    Err(PalmxError::AlreadyBound)
                } else {
                    bindings.insert(open_id.into(), user_id.into());
                    Ok(())
                };
            Box::pin(async move { result })
        }
        fn unbind<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<(), PalmxError>> {
            self.bindings.lock().retain(|_, u| u != user_id);
            Box::pin(async move { Ok(()) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_uids_are_stable_namespaced_and_within_cloudbase_limits() {
        let uid = derived_uid("open-123");
        assert_eq!(uid, derived_uid("open-123"));
        assert_ne!(uid, derived_uid("open-124"));
        assert!(uid.starts_with(PALMX_UID_PREFIX));
        assert!(
            (4..=32).contains(&uid.len()),
            "CloudBase customUserId is 4-32 chars"
        );
        assert!(uid.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'));
    }

    #[test]
    fn tickets_match_the_admin_sdk_format() {
        let pem = include_str!("../tests/fixtures/test-rsa.pem");
        let services = CloudServices::new(
            "https://palm.example.com",
            "key".into(),
            "https://env.example.com",
            CustomLoginKey {
                env_id: "env-1".into(),
                private_key_id: "kid-1".into(),
                private_key: pem.into(),
            },
            "service".into(),
        )
        .expect("services");
        let ticket = services.ticket("px_abcd");
        let (kid, jwt) = ticket.split_once("/@@/").expect("kid separator");
        assert_eq!(kid, "kid-1");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let payload: Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(parts[1])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["uid"], "px_abcd");
        assert_eq!(payload["env"], "env-1");
        assert!(payload["exp"].as_u64().unwrap() > payload["iat"].as_u64().unwrap());
    }

    #[test]
    fn filters_are_url_encoded() {
        assert_eq!(eq("open_id", "a b&c=d"), "open_id=eq.a%20b%26c%3Dd");
    }
}

/// Signs a real ticket against a live CloudBase env. Opt-in only:
/// `KODE_RELAY_LIVE_KEY_FILE=<custom-login JSON> KODE_RELAY_LIVE_ISSUER=<issuer>
///  cargo test -p kode-relay live_custom_login -- --ignored`
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_custom_login_returns_the_requested_uid() {
        let key_file = std::env::var("KODE_RELAY_LIVE_KEY_FILE").expect("KODE_RELAY_LIVE_KEY_FILE");
        let issuer = std::env::var("KODE_RELAY_LIVE_ISSUER").expect("KODE_RELAY_LIVE_ISSUER");
        let key: CustomLoginKey =
            serde_json::from_str(&std::fs::read_to_string(key_file).unwrap()).unwrap();
        let services = CloudServices::new(
            "https://palm.example.com",
            "unused".into(),
            &issuer,
            key,
            "unused".into(),
        )
        .unwrap();
        let tokens = services
            .sign_in("px_kodelivetest0001", "kode-live-test-device")
            .await
            .expect("custom sign-in");
        assert_eq!(tokens.sub, "px_kodelivetest0001");
        assert!(!tokens.refresh_token.is_empty());
    }
}
