//! Multi-account relay between kode desktops and their owners' phones.
//!
//! Unlike `kode-sync-server`, nothing here is persisted: session lists are the
//! desktop's last hello snapshot, history is fetched from the desktop on
//! demand, and the desktop uploads only while a phone is viewing it. Every
//! request is bound to the tenant named by its verified token's `sub`.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tower_http::trace::TraceLayer;

mod agent;
pub mod identity;
mod mobile;
pub mod palm;
pub mod palmx;
mod setup;
mod tenant;

#[cfg(test)]
mod tests;

use identity::{IdentityVerifier, VerifyError};
use tenant::Tenant;

pub const DEVICE_HEADER: &str = "X-Kode-Device";
const MAX_TEXT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct RelayTimings {
    /// Lifetime of a dispatched command before the desktop must reject it.
    pub command_ttl: Duration,
    /// How long a phone waits for a desktop setup/history reply.
    pub setup_timeout: Duration,
    /// Streaming stays on this long after the last REST call or socket close.
    pub viewer_lease: Duration,
    /// How long a list request waits for a freshly enabled desktop snapshot.
    pub snapshot_wait: Duration,
    /// Open sockets re-check their token this often; expiry closes them.
    pub reverify_interval: Duration,
    /// Command receipts stay visible in history this long after settling.
    pub receipt_ttl: Duration,
    /// Session-create idempotency receipts are kept this long.
    pub create_ttl: Duration,
    pub sweep_interval: Duration,
    /// Offline desktops are forgotten after this long without a connection.
    pub offline_device_ttl: Duration,
}

impl Default for RelayTimings {
    fn default() -> Self {
        Self {
            command_ttl: Duration::from_secs(30),
            setup_timeout: Duration::from_secs(50),
            viewer_lease: Duration::from_secs(60),
            snapshot_wait: Duration::from_secs(5),
            reverify_interval: Duration::from_secs(300),
            receipt_ttl: Duration::from_secs(300),
            create_ttl: Duration::from_secs(600),
            sweep_interval: Duration::from_secs(5),
            offline_device_ttl: Duration::from_secs(24 * 3600),
        }
    }
}

#[derive(Clone)]
pub struct RelayState {
    inner: Arc<Inner>,
}

struct Inner {
    verifier: Arc<dyn IdentityVerifier>,
    /// Published by healthz so clients sign in where the relay verifies.
    issuer: Option<String>,
    /// PalmX palm-scan sign-in; absent when the relay has no PalmX keys.
    palmx: Option<palmx::Palmx>,
    /// Kode's own 1:N palm sign-in through the H5 SDK.
    palm: Option<palm::Palm>,
    timings: RelayTimings,
    tenants: Mutex<HashMap<String, Arc<Mutex<Tenant>>>>,
}

/// An authenticated request. `tenant` is the only state it can reach.
pub(crate) struct Caller {
    pub(crate) user_id: String,
    pub(crate) token: String,
    pub(crate) tenant: Arc<Mutex<Tenant>>,
}

impl RelayState {
    pub fn new(verifier: Arc<dyn IdentityVerifier>, timings: RelayTimings) -> Self {
        Self {
            inner: Arc::new(Inner {
                verifier,
                issuer: None,
                palmx: None,
                palm: None,
                timings,
                tenants: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Must be called before the state is shared with the router.
    pub fn with_issuer(mut self, issuer: impl Into<String>) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("configure the relay before sharing its state")
            .issuer = Some(issuer.into());
        self
    }

    /// Must be called before the state is shared with the router.
    pub fn with_palmx(mut self, palmx: palmx::Palmx) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("configure the relay before sharing its state")
            .palmx = Some(palmx);
        self
    }

    /// Must be called before the state is shared with the router.
    pub fn with_palm(mut self, palm: palm::Palm) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("configure the relay before sharing its state")
            .palm = Some(palm);
        self
    }

    pub(crate) fn palm(&self) -> Option<&palm::Palm> {
        self.inner.palm.as_ref()
    }

    pub(crate) fn palmx(&self) -> Option<&palmx::Palmx> {
        self.inner.palmx.as_ref()
    }

    pub(crate) fn timings(&self) -> &RelayTimings {
        &self.inner.timings
    }

    pub(crate) async fn authenticate(&self, headers: &HeaderMap) -> Result<Caller, ApiError> {
        let token = bearer(headers).ok_or(ApiError::Unauthorized)?;
        let identity = self.verify(&token).await?;
        let tenant = self
            .inner
            .tenants
            .lock()
            .entry(identity.user_id.clone())
            .or_default()
            .clone();
        Ok(Caller {
            user_id: identity.user_id,
            token,
            tenant,
        })
    }

    pub(crate) async fn verify(&self, token: &str) -> Result<identity::Identity, ApiError> {
        self.inner
            .verifier
            .verify(token)
            .await
            .map_err(|error| match error {
                VerifyError::Invalid => ApiError::Unauthorized,
                VerifyError::Unavailable => ApiError::Unavailable,
            })
    }

    /// Expires leases, command receipts and long-offline desktops.
    pub fn spawn_sweeper(&self) -> tokio::task::JoinHandle<()> {
        let state = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(state.inner.timings.sweep_interval);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                state.sweep(now_ms());
            }
        })
    }

    pub(crate) fn sweep(&self, now: u64) {
        let timings = &self.inner.timings;
        let receipt_ttl = timings.receipt_ttl.as_millis() as u64;
        let create_ttl = timings.create_ttl.as_millis() as u64;
        let offline_ttl = timings.offline_device_ttl.as_millis() as u64;
        let mut tenants = self.inner.tenants.lock();
        tenants.retain(|_, shared| {
            // A request that just authenticated holds this Arc and may be
            // about to add a device; dropping the entry now would strand
            // that device in a tenant no later request can reach.
            let in_use = Arc::strong_count(shared) > 1;
            let mut tenant = shared.lock();
            tenant.devices.retain(|_, device| {
                device.apply_stream_gate(now);
                let bus = device.bus.clone();
                for receipt in device.commands.values_mut() {
                    if matches!(receipt.status.as_str(), "dispatched" | "accepted")
                        && receipt.expires_at < now
                    {
                        receipt.status = "expired".into();
                        receipt.updated_ms = now;
                        receipt.envelope.ts = now;
                        receipt.envelope.payload =
                            json!({"command_id": receipt.envelope.payload["command_id"], "status": "expired", "error": "command expired"});
                        let _ = bus.send(receipt.envelope.clone());
                    }
                }
                device
                    .commands
                    .retain(|_, receipt| receipt.updated_ms + receipt_ttl > now);
                let commands = &device.commands;
                device.command_keys.retain(|_, id| commands.contains_key(id));
                device
                    .creates
                    .retain(|_, receipt| receipt.created_ms + create_ttl > now);
                device.agent.is_some()
                    || device.ws_viewers > 0
                    || device.last_seen_ms + offline_ttl > now
            });
            in_use || !tenant.devices.is_empty()
        });
    }

    #[cfg(test)]
    pub(crate) fn tenant_count(&self) -> usize {
        self.inner.tenants.lock().len()
    }
}

pub fn build_router(state: RelayState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/healthz", get(healthz))
        .route("/api/v1/agent/ws", get(agent::upgrade))
        .route("/api/v1/account/devices", get(mobile::devices))
        .route("/api/v1/account/logins", get(palmx::linked))
        .route("/palm/capture", get(palm::capture))
        .route("/api/v1/palm", get(palm::status).delete(palm::forget))
        .route("/api/v1/palm/enroll_token", post(palm::enroll_token))
        .route("/api/v1/auth/palm", post(palm::sign_in))
        .route("/api/v1/auth/palm/register", post(palm::register_start))
        .route(
            "/api/v1/auth/palm/register/finish",
            post(palm::register_finish),
        )
        .route("/api/v1/auth/palm/handoff", post(palm::handoff_start))
        .route("/api/v1/auth/palm/handoff/:id", get(palm::handoff_poll))
        .route(
            "/api/v1/auth/palm/handoff/:id/approve",
            post(palm::handoff_approve),
        )
        .route("/api/v1/auth/palmx", post(palmx::sign_in))
        .route(
            "/api/v1/auth/palmx/bind",
            post(palmx::bind).delete(palmx::unbind),
        )
        // Phones call this when forgetting a QR binding; account endpoints
        // have nothing to revoke server-side, so accept it as a no-op.
        .route("/api/v1/bindings/current", delete(mobile::forget))
        .route(
            "/api/v1/sessions",
            get(mobile::list_sessions).post(setup::create),
        )
        .route("/api/v1/backends", get(setup::backends))
        .route("/api/v1/backends/:key/models", get(setup::models))
        .route("/api/v1/fs/list", get(setup::directories))
        .route(
            "/api/v1/sessions/:id",
            get(mobile::get_session).delete(mobile::delete_session),
        )
        .route("/api/v1/sessions/:id/history", get(setup::history))
        .route("/api/v1/sessions/:id/input", post(mobile::post_input))
        .route(
            "/api/v1/sessions/:id/interrupt",
            post(mobile::post_interrupt),
        )
        .route("/api/v1/sessions/:id/answer", post(mobile::post_answer))
        .route(
            "/api/v1/sessions/:id/plan_response",
            post(mobile::post_plan_response),
        )
        .route("/api/v1/sessions/:id/mode", post(mobile::post_mode))
        .route("/api/v1/sessions/:id/model", post(mobile::post_model))
        .route("/ws", get(mobile::ws_upgrade))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz(axum::extract::State(state): axum::extract::State<RelayState>) -> Json<Value> {
    // Clients show only the sign-in methods listed here, in this order, and
    // ignore ids they do not know, so new methods need no client release.
    let mut login_methods = Vec::new();
    if let Some(palm) = state.palm() {
        login_methods.push(json!({"id": "palm", "app_id": palm.app_id, "sdk_url": palm.sdk_url}));
    }
    if let Some(palmx) = state.palmx() {
        login_methods
            .push(json!({"id": "palmx", "app_id": palmx.app_id, "base_url": palmx.base_url}));
    }
    login_methods.push(json!({"id": "email"}));
    Json(json!({
        "status": "ok",
        "server_kind": "kode-relay",
        "issuer": state.inner.issuer,
        "login_methods": login_methods,
        "version": env!("CARGO_PKG_VERSION"),
        "deployment_id": std::env::var("KODE_RELAY_DEPLOYMENT_ID").ok(),
    }))
}

#[derive(Debug)]
pub(crate) enum ApiError {
    BadRequest(String),
    Unauthorized,
    NotFound(String),
    Conflict(String),
    TooManyRequests,
    BadGateway(String),
    /// A sign-in proof (e.g. a palm scan) that does not prove an account.
    SignInRejected(String),
    Unavailable,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error, detail) = match self {
            Self::BadRequest(v) => (StatusCode::BAD_REQUEST, "bad_request", v),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "invalid token".into(),
            ),
            Self::NotFound(v) => (StatusCode::NOT_FOUND, "not_found", v),
            Self::Conflict(v) => (StatusCode::CONFLICT, "conflict", v),
            Self::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "too many sign-in attempts; retry in a minute".into(),
            ),
            Self::BadGateway(v) => (StatusCode::BAD_GATEWAY, "upstream", v),
            Self::SignInRejected(v) => (StatusCode::UNAUTHORIZED, "sign_in_rejected", v),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "identity_unavailable",
                "account service is unreachable; retry shortly".into(),
            ),
        };
        (status, Json(json!({ "error": error, "detail": detail }))).into_response()
    }
}

pub(crate) fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Device ids come from desktops; keep them short and URL/header safe.
pub(crate) fn valid_device_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 128
        && raw
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

pub(crate) fn device_from_headers(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get(DEVICE_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| valid_device_id(value))
        .map(str::to_string)
        .ok_or_else(|| ApiError::BadRequest(format!("{DEVICE_HEADER} header is required")))
}

/// The signing-in client's own CloudBase device id (`x-device-id`).
///
/// Each phone or desktop keeps one stable id. When every sign-in used the
/// same id, a new sign-in revoked the previous session's refresh token even
/// with MaxDevice above 1. Clients that predate the header get a fresh id
/// per sign-in, which never collides with another device.
pub(crate) fn client_device_id(headers: &HeaderMap) -> String {
    headers
        .get("x-device-id")
        .and_then(|value| value.to_str().ok())
        .filter(|id| {
            (8..=64).contains(&id.len())
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

pub(crate) fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .map(str::to_string)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
