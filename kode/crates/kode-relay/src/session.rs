//! Relay-issued account sessions, one per signed-in device.
//!
//! CloudBase keeps a single session per custom-login user: every sign-in
//! revokes the previous refresh token, whatever the device id. So the
//! provider only proves who signed in; the relay then issues its own
//! session for that device and every later refresh goes to the relay.
//!
//! - Access tokens are HS256 JWTs (`iss` = [`ISSUER`], `sid` = session) that
//!   live an hour and verify without a lookup. Session state is re-read at
//!   most every [`STATE_TTL`], so a revoked session stops within a minute.
//! - Refresh tokens are `kr1.<sid>.<mac>` with `mac = HMAC(secret, sid,
//!   salt, generation)`. The store keeps no token, only the generation, so
//!   a leaked table cannot mint tokens. Each refresh bumps the generation.
//! - A refresh with the previous generation inside [`REUSE_GRACE`] returns
//!   the current token again, so two processes refreshing together both
//!   succeed. Any older token is a replay: the session is revoked.

use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use base64::Engine;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    identity::Identity,
    now_ms,
    palmx::{eq, BoxFuture},
    ApiError, RelayState,
};

/// `iss` of relay access tokens; never a URL, so it cannot collide with a
/// provider issuer.
pub const ISSUER: &str = "kode-relay";
const REFRESH_PREFIX: &str = "kr1";
const ACCESS_TTL: Duration = Duration::from_secs(3600);
const REFRESH_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const REUSE_GRACE: Duration = Duration::from_secs(60);
/// How long a verified session's state is trusted before it is re-read.
const STATE_TTL: Duration = Duration::from_secs(60);
/// Replays are recognised this many generations back; older garbage is
/// just an invalid token.
const REPLAY_WINDOW: u64 = 16;
/// Clients that want relay sessions say so; older clients keep getting the
/// provider's tokens so their refresh path still works.
pub const SESSION_HEADER: &str = "x-kode-session";
pub const DEVICE_NAME_HEADER: &str = "x-kode-device-name";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRow {
    pub session_id: String,
    pub user_id: String,
    pub device_id: String,
    pub device_name: String,
    /// How the device signed in: `palm`, `palmx`, `email`.
    pub method: String,
    pub salt: String,
    pub generation: i64,
    pub rotated_at: i64,
    pub created_at: i64,
    pub last_used_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub revoked_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Profile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub picture: String,
    #[serde(default)]
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    Unavailable(String),
}

pub trait SessionStore: Send + Sync + 'static {
    fn insert<'a>(&'a self, row: &'a SessionRow) -> BoxFuture<'a, Result<(), StoreError>>;
    fn get<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<Option<SessionRow>, StoreError>>;
    /// Moves `session_id` from `from` to `from + 1`; `false` when another
    /// refresh got there first.
    fn advance<'a>(
        &'a self,
        session_id: &'a str,
        from: i64,
        now: i64,
        expires_at: i64,
    ) -> BoxFuture<'a, Result<bool, StoreError>>;
    fn revoke<'a>(&'a self, session_id: &'a str, now: i64) -> BoxFuture<'a, Result<(), StoreError>>;
    /// Live sessions of `user_id`.
    fn list<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<Vec<SessionRow>, StoreError>>;
    fn profile<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<Option<Profile>, StoreError>>;
    fn save_profile<'a>(
        &'a self,
        user_id: &'a str,
        profile: &'a Profile,
    ) -> BoxFuture<'a, Result<(), StoreError>>;
}

pub struct Sessions {
    secret: Vec<u8>,
    encoding: EncodingKey,
    decoding: DecodingKey,
    store: Arc<dyn SessionStore>,
    /// session id → (revoked, read at).
    states: Mutex<HashMap<String, (bool, tokio::time::Instant)>>,
}

#[derive(Serialize, Deserialize)]
struct AccessClaims {
    iss: String,
    sub: String,
    sid: String,
    iat: u64,
    exp: u64,
}

/// What a sign-in or refresh returns to the client.
#[derive(Debug, Clone)]
pub struct Issued {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub session: SessionRow,
}

impl Sessions {
    /// `secret` must be at least 32 bytes; it signs access tokens and
    /// derives refresh tokens.
    pub fn new(secret: &[u8], store: Arc<dyn SessionStore>) -> anyhow::Result<Self> {
        if secret.len() < 32 {
            anyhow::bail!("the session secret must be at least 32 bytes");
        }
        Ok(Self {
            secret: secret.to_vec(),
            encoding: EncodingKey::from_secret(secret),
            decoding: DecodingKey::from_secret(secret),
            store,
            states: Mutex::new(HashMap::new()),
        })
    }

    /// Starts a session for a device that just proved `user_id`.
    pub(crate) async fn start(
        &self,
        user_id: &str,
        device_id: &str,
        device_name: &str,
        method: &str,
    ) -> Result<Issued, ApiError> {
        let now = now_ms() as i64;
        let row = SessionRow {
            session_id: uuid::Uuid::new_v4().simple().to_string(),
            user_id: user_id.into(),
            device_id: device_id.into(),
            device_name: device_name.into(),
            method: method.into(),
            salt: uuid::Uuid::new_v4().simple().to_string(),
            generation: 0,
            rotated_at: now,
            created_at: now,
            last_used_at: now,
            expires_at: now + REFRESH_TTL.as_millis() as i64,
            revoked_at: None,
        };
        self.store.insert(&row).await.map_err(unavailable)?;
        tracing::info!(user = %user_id, session = %row.session_id, %method, "session started");
        self.issue(row)
    }

    /// Exchanges a refresh token for a new pair.
    pub(crate) async fn refresh(&self, token: &str) -> Result<Issued, ApiError> {
        let (session_id, mac) = parse_refresh(token).ok_or(ApiError::Unauthorized)?;
        let now = now_ms() as i64;
        for _ in 0..3 {
            let row = self
                .store
                .get(session_id)
                .await
                .map_err(unavailable)?
                .filter(|row| row.revoked_at.is_none() && row.expires_at > now)
                .ok_or(ApiError::Unauthorized)?;
            if self.matches(&row, row.generation, mac) {
                let expires_at = now + REFRESH_TTL.as_millis() as i64;
                if !self
                    .store
                    .advance(session_id, row.generation, now, expires_at)
                    .await
                    .map_err(unavailable)?
                {
                    continue;
                }
                return self.issue(SessionRow {
                    generation: row.generation + 1,
                    rotated_at: now,
                    last_used_at: now,
                    expires_at,
                    ..row
                });
            }
            if row.generation > 0
                && self.matches(&row, row.generation - 1, mac)
                && now - row.rotated_at <= REUSE_GRACE.as_millis() as i64
            {
                return self.issue(row);
            }
            let replayed = (2..=REPLAY_WINDOW as i64)
                .map(|back| row.generation - back + 1)
                .filter(|generation| *generation >= 0)
                .chain((row.generation > 0).then_some(row.generation - 1))
                .any(|generation| self.matches(&row, generation, mac));
            if replayed {
                tracing::warn!(user = %row.user_id, session = %session_id, "refresh token replayed; session revoked");
                self.revoke(session_id).await?;
            }
            return Err(ApiError::Unauthorized);
        }
        Err(ApiError::Unavailable)
    }

    pub(crate) async fn revoke(&self, session_id: &str) -> Result<(), ApiError> {
        self.store
            .revoke(session_id, now_ms() as i64)
            .await
            .map_err(unavailable)?;
        self.states
            .lock()
            .insert(session_id.into(), (true, tokio::time::Instant::now()));
        Ok(())
    }

    /// Verifies a relay access token. `None` when the token is not one of
    /// ours, so the caller can try the provider.
    pub(crate) async fn verify(&self, token: &str) -> Option<Result<Identity, ApiError>> {
        let header = jsonwebtoken::decode_header(token).ok()?;
        if header.alg != Algorithm::HS256 {
            return None;
        }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&[ISSUER]);
        validation.set_required_spec_claims(&["exp", "iss", "sub"]);
        validation.validate_aud = false;
        validation.leeway = 30;
        let claims = match decode::<AccessClaims>(token, &self.decoding, &validation) {
            Ok(data) => data.claims,
            Err(_) => return Some(Err(ApiError::Unauthorized)),
        };
        Some(match self.live(&claims.sid).await {
            Ok(true) => Ok(Identity {
                user_id: claims.sub,
                expires_at: Some(claims.exp),
                session_id: Some(claims.sid),
                name: None,
            }),
            Ok(false) => Err(ApiError::Unauthorized),
            Err(error) => Err(error),
        })
    }

    async fn live(&self, session_id: &str) -> Result<bool, ApiError> {
        if let Some((revoked, at)) = self.states.lock().get(session_id) {
            if at.elapsed() < STATE_TTL {
                return Ok(!revoked);
            }
        }
        let now = now_ms() as i64;
        let live = self
            .store
            .get(session_id)
            .await
            .map_err(unavailable)?
            .is_some_and(|row| row.revoked_at.is_none() && row.expires_at > now);
        let mut states = self.states.lock();
        states.retain(|_, (_, at)| at.elapsed() < STATE_TTL);
        states.insert(session_id.into(), (!live, tokio::time::Instant::now()));
        Ok(live)
    }

    fn issue(&self, session: SessionRow) -> Result<Issued, ApiError> {
        let now = now_ms() / 1000;
        let claims = AccessClaims {
            iss: ISSUER.into(),
            sub: session.user_id.clone(),
            sid: session.session_id.clone(),
            iat: now,
            exp: now + ACCESS_TTL.as_secs(),
        };
        let access_token = encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
            .map_err(|_| ApiError::Unavailable)?;
        let refresh_token = format!(
            "{REFRESH_PREFIX}.{}.{}",
            session.session_id,
            self.mac(&session, session.generation)
        );
        Ok(Issued {
            access_token,
            refresh_token,
            expires_in: ACCESS_TTL.as_secs(),
            session,
        })
    }

    fn mac(&self, row: &SessionRow, generation: i64) -> String {
        let message = format!("{}.{}.{generation}", row.session_id, row.salt);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hmac_sha256(&self.secret, message.as_bytes()))
    }

    fn matches(&self, row: &SessionRow, generation: i64, mac: &str) -> bool {
        constant_time_eq(self.mac(row, generation).as_bytes(), mac.as_bytes())
    }
}

fn parse_refresh(token: &str) -> Option<(&str, &str)> {
    let mut parts = token.splitn(3, '.');
    (parts.next()? == REFRESH_PREFIX).then_some(())?;
    let session_id = parts.next().filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let mac = parts.next().filter(|mac| !mac.is_empty() && mac.len() <= 64)?;
    Some((session_id, mac))
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|b| b ^ byte);
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(message).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn unavailable(error: StoreError) -> ApiError {
    let StoreError::Unavailable(detail) = error;
    tracing::warn!(%detail, "session store unavailable");
    ApiError::Unavailable
}

/// The device name a client sent, percent-decoded (names may be non-ASCII).
pub(crate) fn device_name(headers: &HeaderMap) -> String {
    headers
        .get(DEVICE_NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(percent_decode)
        .map(|name| name.trim().chars().take(80).collect::<String>())
        .filter(|name| !name.is_empty())
        .unwrap_or_default()
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
        match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(hi), Some(lo)) => {
                out.push(hi << 4 | lo);
                i += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether the signing-in client asked for a relay session.
pub(crate) fn wants_session(headers: &HeaderMap) -> bool {
    headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("relay"))
}

/// The token response of every sign-in and refresh.
pub(crate) fn issued_json(issued: &Issued, provider: &str, profile: &Profile) -> Value {
    json!({
        "token_type": "Bearer",
        "token_issuer": "relay",
        "access_token": issued.access_token,
        "refresh_token": issued.refresh_token,
        "expires_in": issued.expires_in,
        "sub": issued.session.user_id,
        "session_id": issued.session.session_id,
        "provider": provider,
        "profile": profile,
    })
}

fn sessions(state: &RelayState) -> Result<&Sessions, ApiError> {
    state
        .sessions()
        .ok_or_else(|| ApiError::NotFound("this relay does not issue sessions".into()))
}

/// The profile of `user_id`, seeded from what the provider knows the first
/// time the account signs in through the relay.
pub(crate) async fn profile_for(
    sessions: &Sessions,
    user_id: &str,
    seed: impl FnOnce() -> Profile,
) -> Result<Profile, ApiError> {
    if let Some(profile) = sessions.store.profile(user_id).await.map_err(unavailable)? {
        return Ok(profile);
    }
    let profile = seed();
    sessions
        .store
        .save_profile(user_id, &profile)
        .await
        .map_err(unavailable)?;
    Ok(profile)
}

/// Who is signing in, captured from the request that started the sign-in.
/// A palm handoff is the waiting desktop's, not the approving phone's.
#[derive(Debug, Clone)]
pub(crate) struct SignInDevice {
    pub(crate) wants_session: bool,
    pub(crate) device_id: String,
    pub(crate) device_name: String,
}

impl SignInDevice {
    pub(crate) fn from_headers(headers: &HeaderMap) -> Self {
        Self {
            wants_session: wants_session(headers),
            device_id: crate::client_device_id(headers),
            device_name: device_name(headers),
        }
    }
}

/// Signs a device in after the provider proved `tokens.sub`: a relay
/// session when the client asked for one, else the provider tokens as the
/// pre-session clients expect them.
pub(crate) async fn finish_sign_in(
    state: &RelayState,
    device: &SignInDevice,
    tokens: &crate::palmx::TokenSet,
    method: &str,
) -> Result<Value, ApiError> {
    let Some(sessions) = state.sessions().filter(|_| device.wants_session) else {
        return Ok(json!({
            "token_type": "Bearer",
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "expires_in": tokens.expires_in,
            "sub": tokens.sub,
            "provider": method,
        }));
    };
    let issued = sessions
        .start(&tokens.sub, &device.device_id, &device.device_name, method)
        .await?;
    // CloudBase puts the account's display name in its access token.
    let name = state
        .verify_provider(&tokens.access_token)
        .await
        .ok()
        .and_then(|identity| identity.name)
        .unwrap_or_default();
    let profile = profile_for(sessions, &tokens.sub, || Profile { name, ..Profile::default() }).await?;
    Ok(issued_json(&issued, method, &profile))
}

#[derive(Deserialize)]
pub(crate) struct ExchangeRequest {
    /// A provider access token, e.g. from email sign-in or a pre-relay
    /// session being migrated.
    provider_token: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

/// `POST /api/v1/auth/session`: turns a valid provider access token into a
/// relay session for the calling device.
pub(crate) async fn exchange(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(req): Json<ExchangeRequest>,
) -> Result<Json<Value>, ApiError> {
    let sessions = sessions(&state)?;
    let identity = state.verify_provider(&req.provider_token).await?;
    let method = req
        .method
        .filter(|m| matches!(m.as_str(), "email" | "palm" | "palmx"))
        .unwrap_or_else(|| "email".into());
    let issued = sessions
        .start(
            &identity.user_id,
            &crate::client_device_id(&headers),
            &device_name(&headers),
            &method,
        )
        .await?;
    let seed = Profile {
        name: identity.name.unwrap_or_default(),
        picture: String::new(),
        email: req.email.unwrap_or_default().chars().take(254).collect(),
    };
    let profile = profile_for(sessions, &identity.user_id, || seed).await?;
    Ok(Json(issued_json(&issued, &method, &profile)))
}

#[derive(Deserialize)]
pub(crate) struct RefreshRequest {
    refresh_token: String,
}

/// `POST /api/v1/auth/token`.
pub(crate) async fn refresh(
    State(state): State<RelayState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<Value>, ApiError> {
    let sessions = sessions(&state)?;
    let issued = sessions.refresh(&req.refresh_token).await?;
    let profile = profile_for(sessions, &issued.session.user_id, Profile::default).await?;
    let method = issued.session.method.clone();
    Ok(Json(issued_json(&issued, &method, &profile)))
}

/// `POST /api/v1/auth/signout`: ends the caller's own session.
pub(crate) async fn sign_out(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    if let (Some(sessions), Some(session_id)) = (state.sessions(), caller.session_id.as_deref()) {
        sessions.revoke(session_id).await?;
    }
    Ok(Json(json!({ "signed_out": true })))
}

/// `GET /api/v1/account/sessions`: every device signed in to the account.
pub(crate) async fn list(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let sessions = sessions(&state)?;
    let mut rows = sessions
        .store
        .list(&caller.user_id)
        .await
        .map_err(unavailable)?;
    rows.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "session_id": row.session_id,
                "device_id": row.device_id,
                "device_name": row.device_name,
                "method": row.method,
                "created_at": row.created_at,
                "last_used_at": row.last_used_at,
                "current": caller.session_id.as_deref() == Some(row.session_id.as_str()),
            })
        })
        .collect();
    Ok(Json(json!({ "sessions": items })))
}

/// `DELETE /api/v1/account/sessions/:id`: signs another device out.
pub(crate) async fn remove(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let sessions = sessions(&state)?;
    let owned = sessions
        .store
        .get(&session_id)
        .await
        .map_err(unavailable)?
        .is_some_and(|row| row.user_id == caller.user_id);
    if !owned {
        return Err(ApiError::NotFound("session".into()));
    }
    sessions.revoke(&session_id).await?;
    Ok(Json(json!({ "removed": true })))
}

/// `GET /api/v1/account/profile`.
pub(crate) async fn get_profile(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let sessions = sessions(&state)?;
    let profile = profile_for(sessions, &caller.user_id, Profile::default).await?;
    Ok(Json(json!({ "user_id": caller.user_id, "profile": profile })))
}

#[derive(Deserialize)]
pub(crate) struct ProfileUpdate {
    name: String,
}

/// `PATCH /api/v1/account/profile {name}`.
pub(crate) async fn set_profile(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(req): Json<ProfileUpdate>,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let sessions = sessions(&state)?;
    let name: String = req.name.trim().chars().take(40).collect();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let mut profile = profile_for(sessions, &caller.user_id, Profile::default).await?;
    profile.name = name;
    sessions
        .store
        .save_profile(&caller.user_id, &profile)
        .await
        .map_err(unavailable)?;
    Ok(Json(json!({ "user_id": caller.user_id, "profile": profile })))
}

/// In-process store for tests and local runs; sessions end with the process.
#[derive(Default)]
pub struct MemoryStore {
    rows: Mutex<HashMap<String, SessionRow>>,
    profiles: Mutex<HashMap<String, Profile>>,
}

impl SessionStore for MemoryStore {
    fn insert<'a>(&'a self, row: &'a SessionRow) -> BoxFuture<'a, Result<(), StoreError>> {
        self.rows.lock().insert(row.session_id.clone(), row.clone());
        Box::pin(async { Ok(()) })
    }

    fn get<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<Option<SessionRow>, StoreError>> {
        let row = self.rows.lock().get(session_id).cloned();
        Box::pin(async move { Ok(row) })
    }

    fn advance<'a>(
        &'a self,
        session_id: &'a str,
        from: i64,
        now: i64,
        expires_at: i64,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        let mut rows = self.rows.lock();
        let advanced = match rows.get_mut(session_id) {
            Some(row) if row.generation == from => {
                row.generation += 1;
                row.rotated_at = now;
                row.last_used_at = now;
                row.expires_at = expires_at;
                true
            }
            _ => false,
        };
        Box::pin(async move { Ok(advanced) })
    }

    fn revoke<'a>(&'a self, session_id: &'a str, now: i64) -> BoxFuture<'a, Result<(), StoreError>> {
        if let Some(row) = self.rows.lock().get_mut(session_id) {
            row.revoked_at.get_or_insert(now);
        }
        Box::pin(async { Ok(()) })
    }

    fn list<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<Vec<SessionRow>, StoreError>> {
        let now = now_ms() as i64;
        let rows = self
            .rows
            .lock()
            .values()
            .filter(|row| row.user_id == user_id && row.revoked_at.is_none() && row.expires_at > now)
            .cloned()
            .collect();
        Box::pin(async move { Ok(rows) })
    }

    fn profile<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<Option<Profile>, StoreError>> {
        let profile = self.profiles.lock().get(user_id).cloned();
        Box::pin(async move { Ok(profile) })
    }

    fn save_profile<'a>(
        &'a self,
        user_id: &'a str,
        profile: &'a Profile,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        self.profiles.lock().insert(user_id.into(), profile.clone());
        Box::pin(async { Ok(()) })
    }
}

/// CloudBase PostgreSQL through its REST API with the service key. Tables
/// (RLS on, no policies, so only the service key reaches them):
///
/// ```sql
/// create table kode_relay_sessions (
///   session_id text primary key, user_id text not null, device_id text not null,
///   device_name text not null default '', method text not null default '',
///   salt text not null, generation bigint not null default 0,
///   rotated_at bigint not null, created_at bigint not null,
///   last_used_at bigint not null, expires_at bigint not null, revoked_at bigint);
/// create index kode_relay_sessions_user on kode_relay_sessions (user_id);
/// create table kode_relay_profiles (
///   user_id text primary key, name text not null default '',
///   picture text not null default '', email text not null default '');
/// ```
pub struct RestStore {
    http: reqwest::Client,
    base: String,
    service_key: String,
}

impl RestStore {
    pub fn new(issuer: &str, service_key: String) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(10))
                .build()?,
            base: format!("{}/v1/rdb/rest", issuer.trim_end_matches('/')),
            service_key,
        })
    }

    async fn send(&self, request: reqwest::RequestBuilder, what: &str) -> Result<Value, StoreError> {
        let response = request
            .bearer_auth(&self.service_key)
            .header("Prefer", "return=representation")
            .send()
            .await
            .map_err(|e| StoreError::Unavailable(format!("{what}: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(StoreError::Unavailable(format!(
                "{what}: {status} {}",
                body.chars().take(200).collect::<String>()
            )));
        }
        Ok(response.json().await.unwrap_or(Value::Array(Vec::new())))
    }

    fn rows<T: for<'de> Deserialize<'de>>(value: Value, what: &str) -> Result<Vec<T>, StoreError> {
        serde_json::from_value(value).map_err(|e| StoreError::Unavailable(format!("{what}: {e}")))
    }
}

impl SessionStore for RestStore {
    fn insert<'a>(&'a self, row: &'a SessionRow) -> BoxFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            self.send(
                self.http.post(format!("{}/kode_relay_sessions", self.base)).json(row),
                "insert session",
            )
            .await
            .map(|_| ())
        })
    }

    fn get<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<Option<SessionRow>, StoreError>> {
        Box::pin(async move {
            let value = self
                .send(
                    self.http.get(format!(
                        "{}/kode_relay_sessions?{}",
                        self.base,
                        eq("session_id", session_id)
                    )),
                    "read session",
                )
                .await?;
            Ok(Self::rows::<SessionRow>(value, "read session")?.into_iter().next())
        })
    }

    fn advance<'a>(
        &'a self,
        session_id: &'a str,
        from: i64,
        now: i64,
        expires_at: i64,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        Box::pin(async move {
            let value = self
                .send(
                    self.http
                        .patch(format!(
                            "{}/kode_relay_sessions?{}&generation=eq.{from}&revoked_at=is.null",
                            self.base,
                            eq("session_id", session_id)
                        ))
                        .json(&json!({
                            "generation": from + 1,
                            "rotated_at": now,
                            "last_used_at": now,
                            "expires_at": expires_at,
                        })),
                    "rotate session",
                )
                .await?;
            Ok(value.as_array().is_some_and(|rows| !rows.is_empty()))
        })
    }

    fn revoke<'a>(&'a self, session_id: &'a str, now: i64) -> BoxFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            self.send(
                self.http
                    .patch(format!(
                        "{}/kode_relay_sessions?{}&revoked_at=is.null",
                        self.base,
                        eq("session_id", session_id)
                    ))
                    .json(&json!({ "revoked_at": now })),
                "revoke session",
            )
            .await
            .map(|_| ())
        })
    }

    fn list<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<Vec<SessionRow>, StoreError>> {
        Box::pin(async move {
            let value = self
                .send(
                    self.http.get(format!(
                        "{}/kode_relay_sessions?{}&revoked_at=is.null&expires_at=gt.{}",
                        self.base,
                        eq("user_id", user_id),
                        now_ms()
                    )),
                    "list sessions",
                )
                .await?;
            Self::rows(value, "list sessions")
        })
    }

    fn profile<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, Result<Option<Profile>, StoreError>> {
        Box::pin(async move {
            let value = self
                .send(
                    self.http.get(format!(
                        "{}/kode_relay_profiles?{}&select=name,picture,email",
                        self.base,
                        eq("user_id", user_id)
                    )),
                    "read profile",
                )
                .await?;
            Ok(Self::rows::<Profile>(value, "read profile")?.into_iter().next())
        })
    }

    fn save_profile<'a>(
        &'a self,
        user_id: &'a str,
        profile: &'a Profile,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        Box::pin(async move {
            self.send(
                self.http
                    .post(format!("{}/kode_relay_profiles?on_conflict=user_id", self.base))
                    .header("Prefer", "resolution=merge-duplicates")
                    .json(&json!({
                        "user_id": user_id,
                        "name": profile.name,
                        "picture": profile.picture,
                        "email": profile.email,
                    })),
                "save profile",
            )
            .await
            .map(|_| ())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions() -> Sessions {
        Sessions::new(&[7u8; 32], Arc::new(MemoryStore::default())).unwrap()
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn device_names_are_percent_decoded() {
        let mut headers = HeaderMap::new();
        headers.insert(DEVICE_NAME_HEADER, "%E9%BB%91%E9%92%9B%E6%9C%BA".parse().unwrap());
        assert_eq!(device_name(&headers), "黑钛机");
    }

    #[tokio::test]
    async fn devices_of_one_account_keep_independent_sessions() {
        let sessions = sessions();
        let desktop = sessions.start("alice", "desktop-1", "Mac", "palm").await.unwrap();
        let phone = sessions.start("alice", "phone-1", "iPhone", "palm").await.unwrap();
        let desktop = sessions.refresh(&desktop.refresh_token).await.unwrap();
        let phone = sessions.refresh(&phone.refresh_token).await.unwrap();
        for issued in [&desktop, &phone] {
            let identity = sessions.verify(&issued.access_token).await.unwrap().unwrap();
            assert_eq!(identity.user_id, "alice");
        }
        assert_eq!(sessions.store.list("alice").await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_concurrent_refresh_gets_the_same_token_and_a_late_replay_revokes() {
        let sessions = sessions();
        let first = sessions.start("alice", "d", "", "palm").await.unwrap();
        let a = sessions.refresh(&first.refresh_token).await.unwrap();
        // The other process presents the same token within the grace window.
        let b = sessions.refresh(&first.refresh_token).await.unwrap();
        assert_eq!(a.refresh_token, b.refresh_token);
        let next = sessions.refresh(&a.refresh_token).await.unwrap();
        // Two generations back is a replay, not a race.
        assert!(sessions.refresh(&first.refresh_token).await.is_err());
        assert!(sessions.refresh(&next.refresh_token).await.is_err(), "replay revokes the session");
        sessions.states.lock().clear();
        assert!(matches!(sessions.verify(&next.access_token).await, Some(Err(_))));
    }

    #[tokio::test]
    async fn forged_and_foreign_tokens_are_rejected() {
        let sessions = sessions();
        let issued = sessions.start("alice", "d", "", "palm").await.unwrap();
        let other = Sessions::new(&[9u8; 32], Arc::new(MemoryStore::default())).unwrap();
        assert!(matches!(other.verify(&issued.access_token).await, Some(Err(_))));
        let forged = format!("{}x", issued.refresh_token);
        assert!(sessions.refresh(&forged).await.is_err());
        assert!(sessions.refresh("kr1.zz.zz").await.is_err());
        assert!(sessions.verify("not-a-jwt").await.is_none(), "non-relay tokens fall through");
    }

    #[tokio::test]
    async fn revoked_sessions_stop_refreshing_and_verifying() {
        let sessions = sessions();
        let issued = sessions.start("alice", "d", "", "palm").await.unwrap();
        sessions.revoke(&issued.session.session_id).await.unwrap();
        assert!(sessions.refresh(&issued.refresh_token).await.is_err());
        assert!(matches!(sessions.verify(&issued.access_token).await, Some(Err(_))));
    }
}
