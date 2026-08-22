//! Centralized kode session mirror and online command router.
//!
//! The desktop is the only executor. It opens one outbound WebSocket, mirrors
//! session metadata/events after a mobile binding exists, and receives short-
//! lived commands. Mobile clients never connect to a desktop LAN address.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

const PAIRING_TTL_MS: u64 = 2 * 60 * 1000;
const COMMAND_TTL_MS: u64 = 30 * 1000;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const DEFAULT_SCOPES: [&str; 3] = ["sessions.read", "sessions.content.read", "sessions.send"];

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub database_path: PathBuf,
    pub public_url: String,
}

#[derive(Clone)]
pub struct ServerState {
    inner: Arc<Inner>,
}

struct Inner {
    db: parking_lot::Mutex<Connection>,
    public_url: String,
    agents: parking_lot::Mutex<HashMap<String, AgentConnection>>,
    mobile_buses: parking_lot::Mutex<HashMap<String, broadcast::Sender<CloudEnvelope>>>,
}

#[derive(Clone)]
struct AgentConnection {
    connection_id: String,
    tx: mpsc::UnboundedSender<ServerFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudEnvelope {
    pub protocol_version: String,
    pub schema_version: u32,
    pub session_id: i64,
    pub ts: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

impl CloudEnvelope {
    fn new(session_id: i64, kind: impl Into<String>, payload: Value) -> Self {
        Self {
            protocol_version: "v1".into(),
            schema_version: 1,
            session_id,
            ts: now_ms(),
            kind: kind.into(),
            payload,
        }
    }
}

#[derive(Debug)]
enum ApiError {
    BadRequest(String),
    Unauthorized,
    Forbidden(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
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
            Self::Forbidden(v) => (StatusCode::FORBIDDEN, "forbidden", v),
            Self::NotFound(v) => (StatusCode::NOT_FOUND, "not_found", v),
            Self::Conflict(v) => (StatusCode::CONFLICT, "conflict", v),
            Self::Internal(v) => (StatusCode::INTERNAL_SERVER_ERROR, "internal", v),
        };
        (status, Json(json!({ "error": error, "detail": detail }))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(value: rusqlite::Error) -> Self {
        tracing::error!(error = %value, "database operation failed");
        Self::Internal("database operation failed".into())
    }
}

impl ServerState {
    pub fn open(config: ServerConfig) -> anyhow::Result<Self> {
        if let Some(parent) = config.database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(&config.database_path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS devices(
               id TEXT PRIMARY KEY,
               installation_id TEXT NOT NULL UNIQUE,
               name TEXT NOT NULL,
               token_hash TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               last_seen_at INTEGER NOT NULL,
               revoked_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS pairings(
               id TEXT PRIMARY KEY,
               device_id TEXT NOT NULL REFERENCES devices(id),
               secret_hash TEXT NOT NULL,
               expires_at INTEGER NOT NULL,
               claimed_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS bindings(
               id TEXT PRIMARY KEY,
               device_id TEXT NOT NULL REFERENCES devices(id),
               mobile_name TEXT NOT NULL,
               token_hash TEXT NOT NULL UNIQUE,
               scopes_json TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               revoked_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS sessions(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               device_id TEXT NOT NULL REFERENCES devices(id),
               boot_id TEXT NOT NULL,
               local_id INTEGER NOT NULL,
               dto_json TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               UNIQUE(device_id, boot_id, local_id)
             );
             CREATE INDEX IF NOT EXISTS sessions_device_updated
               ON sessions(device_id, updated_at DESC);
             CREATE TABLE IF NOT EXISTS events(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               device_id TEXT NOT NULL REFERENCES devices(id),
               cloud_session_id INTEGER NOT NULL REFERENCES sessions(id),
               event_key TEXT NOT NULL UNIQUE,
               ts INTEGER NOT NULL,
               kind TEXT NOT NULL,
               envelope_json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS events_session_ts
               ON events(cloud_session_id, ts, id);
             CREATE TABLE IF NOT EXISTS commands(
               id TEXT PRIMARY KEY,
               binding_id TEXT NOT NULL REFERENCES bindings(id),
               device_id TEXT NOT NULL REFERENCES devices(id),
               cloud_session_id INTEGER NOT NULL REFERENCES sessions(id),
               local_session_id INTEGER NOT NULL,
               idempotency_key TEXT NOT NULL,
               kind TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               status TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               expires_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               error TEXT,
               UNIQUE(binding_id, idempotency_key)
             );",
        )?;
        Ok(Self {
            inner: Arc::new(Inner {
                db: parking_lot::Mutex::new(db),
                public_url: normalize_server_url(&config.public_url)?,
                agents: parking_lot::Mutex::new(HashMap::new()),
                mobile_buses: parking_lot::Mutex::new(HashMap::new()),
            }),
        })
    }

    fn mobile_bus(&self, device_id: &str) -> broadcast::Sender<CloudEnvelope> {
        let mut buses = self.inner.mobile_buses.lock();
        buses
            .entry(device_id.to_string())
            .or_insert_with(|| broadcast::channel(512).0)
            .clone()
    }

    fn publish(&self, device_id: &str, env: CloudEnvelope) {
        let _ = self.mobile_bus(device_id).send(env);
    }

    fn binding_count(&self, device_id: &str) -> Result<u64, ApiError> {
        let db = self.inner.db.lock();
        let count = db.query_row(
            "SELECT COUNT(*) FROM bindings WHERE device_id=?1 AND revoked_at IS NULL",
            [device_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(count.max(0) as u64)
    }

    fn device_authorized(&self, device_id: &str, token: &str) -> Result<bool, ApiError> {
        let db = self.inner.db.lock();
        let expected = db
            .query_row(
                "SELECT token_hash FROM devices WHERE id=?1 AND revoked_at IS NULL",
                [device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(expected.is_some_and(|v| constant_eq(&v, &token_hash(token))))
    }

    fn mobile_auth(&self, token: &str, required_scope: &str) -> Result<BindingAuth, ApiError> {
        let hash = token_hash(token);
        let db = self.inner.db.lock();
        let row = db
            .query_row(
                "SELECT id, device_id, scopes_json FROM bindings
                 WHERE token_hash=?1 AND revoked_at IS NULL",
                [hash],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((binding_id, device_id, scopes_json)) = row else {
            return Err(ApiError::Unauthorized);
        };
        let scopes: Vec<String> = serde_json::from_str(&scopes_json)
            .map_err(|_| ApiError::Internal("invalid binding scopes".into()))?;
        if !scopes.iter().any(|scope| scope == required_scope) {
            return Err(ApiError::Forbidden(format!(
                "missing scope {required_scope}"
            )));
        }
        Ok(BindingAuth {
            binding_id,
            device_id,
            scopes,
        })
    }
}

pub fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        // DevCloud/AIO reserves the generic /healthz path and may answer it
        // itself. Keep a namespaced alias so deployment verification can prove
        // that the public ingress reaches this exact sync-server process.
        .route("/api/v1/healthz", get(healthz))
        .route("/api/v1/devices/register", post(register_device))
        .route("/api/v1/devices/:id/pairings", post(create_pairing))
        .route("/api/v1/pairings/:id/claim", post(claim_pairing))
        .route("/api/v1/agent/ws", get(agent_ws_upgrade))
        .route("/api/v1/bindings/current", delete(revoke_current_binding))
        .route("/api/v1/sessions", get(list_sessions))
        .route("/api/v1/sessions/:id", get(get_session))
        .route("/api/v1/sessions/:id/history", get(get_history))
        .route("/api/v1/sessions/:id/input", post(post_input))
        .route("/api/v1/sessions/:id/answer", post(post_answer))
        .route(
            "/api/v1/sessions/:id/plan_response",
            post(post_plan_response),
        )
        .route("/api/v1/sessions/:id/mode", post(post_mode))
        .route("/ws", get(mobile_ws_upgrade))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn healthz() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "deployment_id": std::env::var("KODE_SYNC_DEPLOYMENT_ID").ok(),
    }))
}

#[derive(Deserialize)]
struct RegisterDeviceReq {
    installation_id: String,
    name: String,
    device_token: Option<String>,
}

#[derive(Serialize)]
struct RegisterDeviceResp {
    device_id: String,
    device_token: String,
}

async fn register_device(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Json(req): Json<RegisterDeviceReq>,
) -> Result<Json<RegisterDeviceResp>, ApiError> {
    if req.installation_id.trim().is_empty() || req.name.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "installation_id and name are required".into(),
        ));
    }
    let db = state.inner.db.lock();
    let existing = db
        .query_row(
            "SELECT id, token_hash FROM devices WHERE installation_id=?1 AND revoked_at IS NULL",
            [req.installation_id.trim()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((device_id, expected)) = existing {
        let Some(provided) = req.device_token else {
            return Err(ApiError::Unauthorized);
        };
        if !constant_eq(&expected, &token_hash(&provided)) {
            return Err(ApiError::Unauthorized);
        }
        db.execute(
            "UPDATE devices SET name=?1, last_seen_at=?2 WHERE id=?3",
            params![req.name.trim(), now_ms() as i64, device_id],
        )?;
        return Ok(Json(RegisterDeviceResp {
            device_id,
            device_token: provided,
        }));
    }
    let device_id = format!("dev_{}", Uuid::new_v4().simple());
    let device_token = random_token("kdev");
    db.execute(
        "INSERT INTO devices(id, installation_id, name, token_hash, created_at, last_seen_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?5)",
        params![
            device_id,
            req.installation_id.trim(),
            req.name.trim(),
            token_hash(&device_token),
            now_ms() as i64
        ],
    )?;
    Ok(Json(RegisterDeviceResp {
        device_id,
        device_token,
    }))
}

#[derive(Deserialize)]
struct PairingCreateReq {
    #[serde(default)]
    scopes: Vec<String>,
}

#[derive(Debug, Serialize)]
struct PairingResp {
    pairing_id: String,
    secret: String,
    uri: String,
    expires_at: u64,
}

async fn create_pairing(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<PairingCreateReq>,
) -> Result<Json<PairingResp>, ApiError> {
    let token = bearer(&headers).ok_or(ApiError::Unauthorized)?;
    if !state.device_authorized(&device_id, &token)? {
        return Err(ApiError::Unauthorized);
    }
    let scopes = if req.scopes.is_empty() {
        DEFAULT_SCOPES.iter().map(|v| (*v).to_string()).collect()
    } else {
        validate_scopes(&req.scopes)?
    };
    let pairing_id = format!("pair_{}", Uuid::new_v4().simple());
    let secret = random_token("kp");
    let expires_at = now_ms() + PAIRING_TTL_MS;
    {
        let db = state.inner.db.lock();
        db.execute(
            "INSERT INTO pairings(id, device_id, secret_hash, expires_at) VALUES(?1, ?2, ?3, ?4)",
            params![
                pairing_id,
                device_id,
                token_hash(&secret),
                expires_at as i64
            ],
        )?;
    }
    let scopes_json = serde_json::to_string(&scopes).unwrap_or_else(|_| "[]".into());
    let uri = format!(
        "kode://cloud-pair?server={}&pairing_id={}&secret={}&scopes={}",
        url::form_urlencoded::byte_serialize(state.inner.public_url.as_bytes()).collect::<String>(),
        pairing_id,
        url::form_urlencoded::byte_serialize(secret.as_bytes()).collect::<String>(),
        url::form_urlencoded::byte_serialize(scopes_json.as_bytes()).collect::<String>()
    );
    Ok(Json(PairingResp {
        pairing_id,
        secret,
        uri,
        expires_at,
    }))
}

#[derive(Deserialize)]
struct ClaimPairingReq {
    secret: String,
    mobile_name: String,
}

#[derive(Serialize)]
struct ClaimPairingResp {
    server_url: String,
    device_id: String,
    device_name: String,
    access_token: String,
    scopes: Vec<String>,
}

async fn claim_pairing(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(pairing_id): Path<String>,
    Json(req): Json<ClaimPairingReq>,
) -> Result<Json<ClaimPairingResp>, ApiError> {
    if req.secret.is_empty() || req.mobile_name.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "secret and mobile_name are required".into(),
        ));
    }
    let access_token = random_token("kmob");
    let scopes: Vec<String> = DEFAULT_SCOPES.iter().map(|v| (*v).to_string()).collect();
    let scopes_json = serde_json::to_string(&scopes)
        .map_err(|_| ApiError::Internal("scope serialization failed".into()))?;
    let binding_id = format!("bind_{}", Uuid::new_v4().simple());
    let (device_id, device_name) = {
        let mut db = state.inner.db.lock();
        let tx = db.transaction()?;
        let row = tx
            .query_row(
                "SELECT p.device_id, d.name, p.secret_hash, p.expires_at, p.claimed_at
                 FROM pairings p JOIN devices d ON d.id=p.device_id
                 WHERE p.id=?1 AND d.revoked_at IS NULL",
                [pairing_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((device_id, device_name, expected, expires_at, claimed_at)) = row else {
            return Err(ApiError::NotFound("pairing not found".into()));
        };
        if claimed_at.is_some() {
            return Err(ApiError::Conflict("pairing already claimed".into()));
        }
        if expires_at < now_ms() as i64 {
            return Err(ApiError::Conflict("pairing expired".into()));
        }
        if !constant_eq(&expected, &token_hash(&req.secret)) {
            return Err(ApiError::Unauthorized);
        }
        tx.execute(
            "UPDATE pairings SET claimed_at=?1 WHERE id=?2 AND claimed_at IS NULL",
            params![now_ms() as i64, pairing_id],
        )?;
        tx.execute(
            "INSERT INTO bindings(id, device_id, mobile_name, token_hash, scopes_json, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                binding_id,
                device_id,
                req.mobile_name.trim(),
                token_hash(&access_token),
                scopes_json,
                now_ms() as i64
            ],
        )?;
        tx.commit()?;
        (device_id, device_name)
    };
    if let Some(agent) = state.inner.agents.lock().get(&device_id).cloned() {
        let _ = agent.tx.send(ServerFrame::PairingBound {
            binding_count: state.binding_count(&device_id)?,
        });
    }
    Ok(Json(ClaimPairingResp {
        server_url: state.inner.public_url.clone(),
        device_id,
        device_name,
        access_token,
        scopes,
    }))
}

async fn revoke_current_binding(
    axum::extract::State(state): axum::extract::State<ServerState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers).ok_or(ApiError::Unauthorized)?;
    let auth = state.mobile_auth(&token, "sessions.read")?;
    {
        let db = state.inner.db.lock();
        db.execute(
            "UPDATE bindings SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL",
            params![now_ms() as i64, auth.binding_id],
        )?;
    }
    let binding_count = state.binding_count(&auth.device_id)?;
    if let Some(agent) = state.inner.agents.lock().get(&auth.device_id).cloned() {
        let _ = agent.tx.send(ServerFrame::BindingChanged {
            sync_enabled: binding_count > 0,
            binding_count,
        });
    }
    state.publish(
        &auth.device_id,
        CloudEnvelope::new(0, "binding.revoked", json!({"binding_id": auth.binding_id})),
    );
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AgentWsQuery {
    device_id: String,
}

async fn agent_ws_upgrade(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Query(query): Query<AgentWsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let token = bearer(&headers).ok_or(ApiError::Unauthorized)?;
    if !state.device_authorized(&query.device_id, &token)? {
        return Err(ApiError::Unauthorized);
    }
    if state.inner.agents.lock().contains_key(&query.device_id) {
        return Err(ApiError::Conflict(
            "another desktop process is already connected for this device".into(),
        ));
    }
    Ok(ws
        .on_upgrade(move |socket| agent_socket(socket, state, query.device_id))
        .into_response())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AgentFrame {
    #[serde(rename = "hello")]
    Hello {
        boot_id: String,
        sessions: Vec<AgentSession>,
    },
    #[serde(rename = "event")]
    Event {
        boot_id: String,
        local_session_id: u64,
        event: AgentEnvelope,
    },
    #[serde(rename = "command.result")]
    CommandResult {
        command_id: String,
        status: String,
        error: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Deserialize)]
struct AgentSession {
    local_id: u64,
    dto: Value,
}

#[derive(Debug, Deserialize, Serialize)]
struct AgentEnvelope {
    #[serde(default = "default_protocol")]
    protocol_version: String,
    #[serde(default = "default_schema")]
    schema_version: u32,
    session_id: u64,
    ts: u64,
    #[serde(rename = "type")]
    kind: String,
    payload: Value,
}

fn default_protocol() -> String {
    "v1".into()
}

fn default_schema() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
enum ServerFrame {
    #[serde(rename = "server.hello")]
    Hello {
        sync_enabled: bool,
        binding_count: u64,
    },
    #[serde(rename = "pairing.bound")]
    PairingBound { binding_count: u64 },
    #[serde(rename = "binding.changed")]
    BindingChanged {
        sync_enabled: bool,
        binding_count: u64,
    },
    #[serde(rename = "command")]
    Command {
        command_id: String,
        local_session_id: u64,
        kind: String,
        payload: Value,
        expires_at: u64,
    },
    #[serde(rename = "pong")]
    Pong,
}

async fn agent_socket(socket: WebSocket, state: ServerState, device_id: String) {
    let connection_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerFrame>();
    {
        let mut agents = state.inner.agents.lock();
        if agents.contains_key(&device_id) {
            return;
        }
        agents.insert(
            device_id.clone(),
            AgentConnection {
                connection_id: connection_id.clone(),
                tx: tx.clone(),
            },
        );
    }
    let binding_count = state.binding_count(&device_id).unwrap_or(0);
    let _ = tx.send(ServerFrame::Hello {
        sync_enabled: binding_count > 0,
        binding_count,
    });
    if binding_count > 0 {
        if let Ok(pending) = pending_commands(&state, &device_id) {
            for frame in pending {
                let _ = tx.send(frame);
            }
        }
    }

    let (mut sink, mut source) = socket.split();
    loop {
        tokio::select! {
            outbound = rx.recv() => {
                let Some(outbound) = outbound else { break; };
                let Ok(raw) = serde_json::to_string(&outbound) else { continue; };
                if sink.send(Message::Text(raw)).await.is_err() { break; }
            }
            inbound = source.next() => {
                let Some(Ok(inbound)) = inbound else { break; };
                match inbound {
                    Message::Text(raw) => match serde_json::from_str::<AgentFrame>(&raw) {
                        Ok(frame) => {
                            if let Err(error) = handle_agent_frame(&state, &device_id, frame, &tx) {
                                tracing::warn!(%device_id, ?error, "agent frame rejected");
                            }
                        }
                        Err(error) => tracing::warn!(%device_id, %error, "invalid agent frame"),
                    },
                    Message::Ping(value) => {
                        let _ = sink.send(Message::Pong(value)).await;
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }
    let mut agents = state.inner.agents.lock();
    if agents
        .get(&device_id)
        .is_some_and(|current| current.connection_id == connection_id)
    {
        agents.remove(&device_id);
    }
}

fn handle_agent_frame(
    state: &ServerState,
    device_id: &str,
    frame: AgentFrame,
    tx: &mpsc::UnboundedSender<ServerFrame>,
) -> Result<(), ApiError> {
    match frame {
        AgentFrame::Hello { boot_id, sessions } => {
            if state.binding_count(device_id)? == 0 {
                return Ok(());
            }
            sync_session_snapshot(state, device_id, &boot_id, sessions)?;
            for command in pending_commands(state, device_id)? {
                let _ = tx.send(command);
            }
        }
        AgentFrame::Event {
            boot_id,
            local_session_id,
            event,
        } => {
            if state.binding_count(device_id)? == 0 {
                return Ok(());
            }
            persist_agent_event(state, device_id, &boot_id, local_session_id, event)?;
        }
        AgentFrame::CommandResult {
            command_id,
            status,
            error,
        } => update_command_result(state, device_id, &command_id, &status, error.as_deref())?,
        AgentFrame::Ping => {
            let _ = tx.send(ServerFrame::Pong);
        }
    }
    Ok(())
}

fn sync_session_snapshot(
    state: &ServerState,
    device_id: &str,
    boot_id: &str,
    sessions: Vec<AgentSession>,
) -> Result<(), ApiError> {
    let mut created = Vec::new();
    let mut updated = Vec::new();
    {
        let mut db = state.inner.db.lock();
        let tx = db.transaction()?;
        // A hello snapshot is authoritative for this device. Mark every
        // previously known session exited inside the transaction, then the
        // following upserts restore the sessions that are still present.
        // This also handles a session disappearing during the same boot.
        tx.execute(
            "UPDATE sessions SET dto_json=json_set(dto_json, '$.status', 'exited'), updated_at=?1
             WHERE device_id=?2 AND json_extract(dto_json, '$.status')<>'exited'",
            params![now_ms() as i64, device_id],
        )?;
        for session in sessions {
            let (cloud_id, was_created, dto) =
                upsert_session_tx(&tx, device_id, boot_id, session.local_id, session.dto)?;
            if was_created {
                created.push((cloud_id, dto));
            } else {
                // Hello snapshots are authoritative. Existing mobile clients
                // may still hold a stale/empty title from before reconnect, so
                // publish the complete refreshed DTO instead of silently
                // updating SQLite only.
                updated.push((cloud_id, dto));
            }
        }
        tx.commit()?;
    }
    for (cloud_id, dto) in created {
        state.publish(
            device_id,
            CloudEnvelope::new(cloud_id, "session.created", dto),
        );
    }
    for (cloud_id, dto) in updated {
        state.publish(
            device_id,
            CloudEnvelope::new(cloud_id, "session.updated", dto),
        );
    }
    Ok(())
}

fn upsert_session_tx(
    tx: &Transaction<'_>,
    device_id: &str,
    boot_id: &str,
    local_id: u64,
    mut dto: Value,
) -> Result<(i64, bool, Value), ApiError> {
    let existing = tx
        .query_row(
            "SELECT id FROM sessions WHERE device_id=?1 AND boot_id=?2 AND local_id=?3",
            params![device_id, boot_id, local_id as i64],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(cloud_id) = existing {
        dto["id"] = json!(cloud_id);
        tx.execute(
            "UPDATE sessions SET dto_json=?1, updated_at=?2 WHERE id=?3",
            params![dto.to_string(), now_ms() as i64, cloud_id],
        )?;
        return Ok((cloud_id, false, dto));
    }
    dto["id"] = json!(0);
    tx.execute(
        "INSERT INTO sessions(device_id, boot_id, local_id, dto_json, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![
            device_id,
            boot_id,
            local_id as i64,
            dto.to_string(),
            now_ms() as i64
        ],
    )?;
    let cloud_id = tx.last_insert_rowid();
    dto["id"] = json!(cloud_id);
    tx.execute(
        "UPDATE sessions SET dto_json=?1 WHERE id=?2",
        params![dto.to_string(), cloud_id],
    )?;
    Ok((cloud_id, true, dto))
}

fn persist_agent_event(
    state: &ServerState,
    device_id: &str,
    boot_id: &str,
    local_session_id: u64,
    event: AgentEnvelope,
) -> Result<(), ApiError> {
    // Raw PTY traffic is intentionally local-only. Mobile consumes semantic
    // messages/tool events; persisting terminal frames bloats history and can
    // hide useful content behind the page limit. Keep this guard server-side
    // for compatibility with older desktop agents.
    if matches!(event.kind.as_str(), "pty_bytes" | "shell.pty_bytes") {
        return Ok(());
    }
    let (cloud_id, envelope, inserted) = {
        let db = state.inner.db.lock();
        let cloud_id = db
            .query_row(
                "SELECT id FROM sessions WHERE device_id=?1 AND boot_id=?2 AND local_id=?3",
                params![device_id, boot_id, local_session_id as i64],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or_else(|| ApiError::Conflict("session snapshot required before events".into()))?;
        let envelope = CloudEnvelope {
            protocol_version: event.protocol_version,
            schema_version: event.schema_version,
            session_id: cloud_id,
            ts: event.ts,
            kind: event.kind,
            payload: event.payload,
        };
        let event_key = event_key(device_id, boot_id, local_session_id, &envelope);
        let inserted = db.execute(
            "INSERT OR IGNORE INTO events(device_id, cloud_session_id, event_key, ts, kind, envelope_json)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                device_id,
                cloud_id,
                event_key,
                envelope.ts as i64,
                envelope.kind,
                serde_json::to_string(&envelope)
                    .map_err(|_| ApiError::Internal("event serialization failed".into()))?
            ],
        )?;
        if inserted > 0 {
            patch_session_from_event(&db, cloud_id, &envelope)?;
        }
        (cloud_id, envelope, inserted > 0)
    };
    if inserted {
        let _ = cloud_id;
        state.publish(device_id, envelope);
    }
    Ok(())
}

fn patch_session_from_event(
    db: &Connection,
    cloud_id: i64,
    envelope: &CloudEnvelope,
) -> Result<(), ApiError> {
    let dto_raw = db.query_row(
        "SELECT dto_json FROM sessions WHERE id=?1",
        [cloud_id],
        |row| row.get::<_, String>(0),
    )?;
    let mut dto: Value = serde_json::from_str(&dto_raw)
        .map_err(|_| ApiError::Internal("invalid session snapshot".into()))?;
    match envelope.kind.as_str() {
        "meta" => {
            // Meta events are sparse updates. The desktop serializes absent
            // Option values as JSON null, so null means "unchanged" rather
            // than "clear the value from the session snapshot".
            if let Some(v) = envelope.payload.get("title").filter(|v| !v.is_null()) {
                dto["title"] = v.clone();
            }
            if let Some(v) = envelope.payload.get("model").filter(|v| !v.is_null()) {
                dto["model"] = v.clone();
            }
            if let Some(v) = envelope.payload.get("context_pct").filter(|v| !v.is_null()) {
                dto["context_pct"] = v.clone();
            }
            if let Some(v) = envelope.payload.get("cost_usd").filter(|v| !v.is_null()) {
                dto["cost_usd"] = v.clone();
            }
            if dto.get("tokens").is_none() {
                dto["tokens"] = json!({"total":0,"input":0,"output":0,"cached":0});
            }
            for (source, target) in [
                ("tokens", "total"),
                ("input_tokens", "input"),
                ("output_tokens", "output"),
                ("cached_tokens", "cached"),
            ] {
                if let Some(v) = envelope.payload.get(source).filter(|v| !v.is_null()) {
                    dto["tokens"][target] = v.clone();
                }
            }
        }
        "session.status" => {
            if let Some(v) = envelope.payload.get("status") {
                dto["status"] = v.clone();
            }
        }
        "session.exited" => dto["status"] = json!("exited"),
        _ => return Ok(()),
    }
    db.execute(
        "UPDATE sessions SET dto_json=?1, updated_at=?2 WHERE id=?3",
        params![dto.to_string(), now_ms() as i64, cloud_id],
    )?;
    Ok(())
}

#[derive(Debug)]
struct BindingAuth {
    binding_id: String,
    device_id: String,
    scopes: Vec<String>,
}

async fn list_sessions(
    axum::extract::State(state): axum::extract::State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let auth = mobile_auth_from_headers(&state, &headers, "sessions.read")?;
    let db = state.inner.db.lock();
    let mut stmt = db.prepare(
        "SELECT dto_json FROM sessions
         WHERE device_id=?1 AND COALESCE(json_extract(dto_json, '$.status'), 'starting')<>'exited'
         ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([auth.device_id], |row| row.get::<_, String>(0))?;
    let mut sessions = Vec::new();
    for row in rows {
        let raw = row?;
        let dto = serde_json::from_str::<Value>(&raw)
            .map_err(|_| ApiError::Internal("invalid session snapshot".into()))?;
        sessions.push(dto);
    }
    Ok(Json(json!({ "sessions": sessions })))
}

async fn get_session(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let auth = mobile_auth_from_headers(&state, &headers, "sessions.read")?;
    let db = state.inner.db.lock();
    let raw = db
        .query_row(
            "SELECT dto_json FROM sessions
             WHERE id=?1 AND device_id=?2
               AND COALESCE(json_extract(dto_json, '$.status'), 'starting')<>'exited'",
            params![session_id, auth.device_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| ApiError::NotFound(format!("session {session_id}")))?;
    let dto = serde_json::from_str::<Value>(&raw)
        .map_err(|_| ApiError::Internal("invalid session snapshot".into()))?;
    Ok(Json(dto))
}

#[derive(Deserialize)]
struct HistoryQuery {
    from: Option<u64>,
    limit: Option<usize>,
}

async fn get_history(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(session_id): Path<i64>,
    Query(query): Query<HistoryQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let auth = mobile_auth_from_headers(&state, &headers, "sessions.content.read")?;
    let limit = query.limit.unwrap_or(1000).clamp(1, 2000) as i64;
    let db = state.inner.db.lock();
    let owns = db
        .query_row(
            "SELECT 1 FROM sessions WHERE id=?1 AND device_id=?2",
            params![session_id, auth.device_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !owns {
        return Err(ApiError::NotFound(format!("session {session_id}")));
    }
    let from = query.from.unwrap_or(0) as i64;
    let sql = if from == 0 {
        // Initial mobile load wants the newest semantic window, but the
        // response remains chronological for rendering.
        "SELECT envelope_json FROM (
           SELECT id, ts, envelope_json FROM events
           WHERE cloud_session_id=?1 AND kind NOT IN ('pty_bytes','shell.pty_bytes')
           ORDER BY ts DESC, id DESC LIMIT ?3
         ) ORDER BY ts, id"
    } else {
        "SELECT envelope_json FROM events
         WHERE cloud_session_id=?1 AND ts>=?2
           AND kind NOT IN ('pty_bytes','shell.pty_bytes')
         ORDER BY ts, id LIMIT ?3"
    };
    let mut stmt = db.prepare(sql)?;
    let rows = stmt.query_map(params![session_id, from, limit], |row| {
        row.get::<_, String>(0)
    })?;
    let mut events = Vec::new();
    for row in rows {
        let raw = row?;
        events.push(
            serde_json::from_str::<Value>(&raw)
                .map_err(|_| ApiError::Internal("invalid stored event".into()))?,
        );
    }
    Ok(Json(json!({ "events": events })))
}

#[derive(Deserialize)]
struct InputReq {
    text: String,
}

async fn post_input(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
    Json(req): Json<InputReq>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if req.text.trim_end_matches(['\r', '\n']).is_empty() {
        return Err(ApiError::BadRequest("message text is empty".into()));
    }
    if req.text.len() > MAX_TEXT_BYTES {
        return Err(ApiError::BadRequest(format!(
            "message exceeds {MAX_TEXT_BYTES} bytes"
        )));
    }
    dispatch_mobile_command(
        &state,
        session_id,
        &headers,
        "input",
        json!({"text": req.text}),
    )
}

async fn post_answer(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let choice = payload
        .get("choice_index")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::BadRequest("choice_index is required".into()))?;
    if choice > 8 {
        return Err(ApiError::BadRequest(
            "choice_index must be between 0 and 8".into(),
        ));
    }
    dispatch_mobile_command(&state, session_id, &headers, "answer", payload)
}

async fn post_plan_response(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if payload.get("accept").and_then(Value::as_bool).is_none() {
        return Err(ApiError::BadRequest("accept is required".into()));
    }
    dispatch_mobile_command(&state, session_id, &headers, "plan_response", payload)
}

async fn post_mode(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mode = payload
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("mode is required".into()))?;
    if !matches!(
        mode,
        "default" | "acceptEdits" | "bypassPermissions" | "plan"
    ) {
        return Err(ApiError::BadRequest("unsupported mode".into()));
    }
    let requested_mode = mode.to_string();
    let (status, Json(mut response)) =
        dispatch_mobile_command(&state, session_id, &headers, "mode", payload)?;
    response["mode"] = json!(requested_mode);
    Ok((status, Json(response)))
}

fn dispatch_mobile_command(
    state: &ServerState,
    session_id: i64,
    headers: &HeaderMap,
    kind: &str,
    payload: Value,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let auth = mobile_auth_from_headers(state, headers, "sessions.send")?;
    let idempotency_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let agent = state
        .inner
        .agents
        .lock()
        .get(&auth.device_id)
        .cloned()
        .ok_or_else(|| ApiError::Conflict("desktop is offline; message was not queued".into()))?;
    let now = now_ms();
    let expires_at = now + COMMAND_TTL_MS;
    let (command_id, local_session_id, existing_status) = {
        let db = state.inner.db.lock();
        if let Some(existing) = db
            .query_row(
                "SELECT id, status, local_session_id FROM commands
                 WHERE binding_id=?1 AND idempotency_key=?2",
                params![auth.binding_id, idempotency_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?
        {
            (existing.0, existing.2 as u64, Some(existing.1))
        } else {
            let local_id = db
                .query_row(
                    "SELECT local_id FROM sessions
                     WHERE id=?1 AND device_id=?2
                       AND COALESCE(json_extract(dto_json, '$.status'), 'starting')<>'exited'",
                    params![session_id, auth.device_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| ApiError::NotFound(format!("session {session_id}")))?;
            let command_id = format!("cmd_{}", Uuid::new_v4().simple());
            db.execute(
                "INSERT INTO commands(id, binding_id, device_id, cloud_session_id,
                  local_session_id, idempotency_key, kind, payload_json, status,
                  created_at, expires_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'dispatched', ?9, ?10, ?9)",
                params![
                    command_id,
                    auth.binding_id,
                    auth.device_id,
                    session_id,
                    local_id,
                    idempotency_key,
                    kind,
                    payload.to_string(),
                    now as i64,
                    expires_at as i64
                ],
            )?;
            (command_id, local_id as u64, None)
        }
    };
    if let Some(status) = existing_status {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "command_id": command_id, "status": status, "deduplicated": true })),
        ));
    }
    let frame = ServerFrame::Command {
        command_id: command_id.clone(),
        local_session_id,
        kind: kind.into(),
        payload,
        expires_at,
    };
    if agent.tx.send(frame).is_err() {
        update_command_result(
            state,
            &auth.device_id,
            &command_id,
            "failed",
            Some("desktop connection closed"),
        )?;
        return Err(ApiError::Conflict(
            "desktop disconnected; message was not queued".into(),
        ));
    }
    state.publish(
        &auth.device_id,
        CloudEnvelope::new(
            session_id,
            "command.status",
            json!({ "command_id": command_id.clone(), "status": "dispatched", "error": null }),
        ),
    );
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "command_id": command_id, "status": "dispatched", "expires_at": expires_at })),
    ))
}

fn pending_commands(state: &ServerState, device_id: &str) -> Result<Vec<ServerFrame>, ApiError> {
    let db = state.inner.db.lock();
    db.execute(
        "UPDATE commands SET status='expired', updated_at=?1, error='command expired'
         WHERE device_id=?2 AND status IN ('dispatched','accepted') AND expires_at<?1",
        params![now_ms() as i64, device_id],
    )?;
    let mut stmt = db.prepare(
        "SELECT id, local_session_id, kind, payload_json, expires_at FROM commands
         WHERE device_id=?1 AND status='dispatched' AND expires_at>=?2 ORDER BY created_at",
    )?;
    let rows = stmt.query_map(params![device_id, now_ms() as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    let mut frames = Vec::new();
    for row in rows {
        let (command_id, local_session_id, kind, payload, expires_at) = row?;
        frames.push(ServerFrame::Command {
            command_id,
            local_session_id: local_session_id as u64,
            kind,
            payload: serde_json::from_str(&payload)
                .map_err(|_| ApiError::Internal("invalid command payload".into()))?,
            expires_at: expires_at as u64,
        });
    }
    Ok(frames)
}

fn update_command_result(
    state: &ServerState,
    device_id: &str,
    command_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), ApiError> {
    if !matches!(status, "accepted" | "executed" | "failed" | "expired") {
        return Err(ApiError::BadRequest("invalid command status".into()));
    }
    let cloud_session_id = {
        let db = state.inner.db.lock();
        let cloud_id = db
            .query_row(
                "SELECT cloud_session_id FROM commands WHERE id=?1 AND device_id=?2",
                params![command_id, device_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or_else(|| ApiError::NotFound("command not found".into()))?;
        db.execute(
            "UPDATE commands SET status=?1, updated_at=?2, error=?3 WHERE id=?4 AND device_id=?5",
            params![status, now_ms() as i64, error, command_id, device_id],
        )?;
        cloud_id
    };
    state.publish(
        device_id,
        CloudEnvelope::new(
            cloud_session_id,
            "command.status",
            json!({ "command_id": command_id, "status": status, "error": error }),
        ),
    );
    Ok(())
}

async fn mobile_ws_upgrade(
    axum::extract::State(state): axum::extract::State<ServerState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let token = bearer(&headers).ok_or(ApiError::Unauthorized)?;
    let auth = state.mobile_auth(&token, "sessions.content.read")?;
    Ok(ws
        .on_upgrade(move |socket| mobile_socket(socket, state, auth))
        .into_response())
}

async fn mobile_socket(socket: WebSocket, state: ServerState, auth: BindingAuth) {
    let mut events = state.mobile_bus(&auth.device_id).subscribe();
    let (mut sink, mut source) = socket.split();
    let hello = CloudEnvelope::new(
        0,
        "connection.hello",
        json!({
            "server_kind": "kode-sync-server",
            "device_id": auth.device_id,
            "scopes": auth.scopes,
            "desktop_online": state.inner.agents.lock().contains_key(&auth.device_id),
        }),
    );
    if let Ok(raw) = serde_json::to_string(&hello) {
        if sink.send(Message::Text(raw)).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    let revoke_this_socket = event.kind == "binding.revoked"
                        && event.payload.get("binding_id").and_then(Value::as_str)
                            == Some(auth.binding_id.as_str());
                    let Ok(raw) = serde_json::to_string(&event) else { continue; };
                    if sink.send(Message::Text(raw)).await.is_err() { break; }
                    if revoke_this_socket { break; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            inbound = source.next() => {
                let Some(Ok(inbound)) = inbound else { break; };
                match inbound {
                    Message::Text(raw) if raw.contains("\"type\":\"ping\"") => {
                        let pong = CloudEnvelope::new(0, "pong", json!({}));
                        if let Ok(raw) = serde_json::to_string(&pong) {
                            let _ = sink.send(Message::Text(raw)).await;
                        }
                    }
                    Message::Ping(value) => { let _ = sink.send(Message::Pong(value)).await; }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }
}

fn mobile_auth_from_headers(
    state: &ServerState,
    headers: &HeaderMap,
    scope: &str,
) -> Result<BindingAuth, ApiError> {
    let token = bearer(headers).ok_or(ApiError::Unauthorized)?;
    state.mobile_auth(&token, scope)
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)
}

fn validate_scopes(scopes: &[String]) -> Result<Vec<String>, ApiError> {
    let mut result = Vec::new();
    for scope in scopes {
        if !DEFAULT_SCOPES.contains(&scope.as_str()) {
            return Err(ApiError::BadRequest(format!("unsupported scope {scope}")));
        }
        if !result.contains(scope) {
            result.push(scope.clone());
        }
    }
    Ok(result)
}

fn normalize_server_url(raw: &str) -> anyhow::Result<String> {
    let parsed = url::Url::parse(raw.trim())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        anyhow::bail!("KODE_SYNC_PUBLIC_URL must use http or https");
    }
    if parsed.host_str().is_none() {
        anyhow::bail!("KODE_SYNC_PUBLIC_URL must include a host");
    }
    Ok(raw.trim().trim_end_matches('/').to_string())
}

fn random_token(prefix: &str) -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    format!(
        "{prefix}_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn token_hash(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex_digest(&digest)
}

fn event_key(
    device_id: &str,
    boot_id: &str,
    local_session_id: u64,
    event: &CloudEnvelope,
) -> String {
    let mut hash = Sha256::new();
    hash.update(device_id.as_bytes());
    hash.update([0]);
    hash.update(boot_id.as_bytes());
    hash.update(local_session_id.to_le_bytes());
    hash.update(event.ts.to_le_bytes());
    hash.update(event.kind.as_bytes());
    hash.update(event.payload.to_string().as_bytes());
    hex_digest(&hash.finalize())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn constant_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0_u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue};

    fn state() -> (tempfile::TempDir, ServerState) {
        let dir = tempfile::tempdir().unwrap();
        let state = ServerState::open(ServerConfig {
            database_path: dir.path().join("sync.db"),
            public_url: "https://sync.example.test".into(),
        })
        .unwrap();
        (dir, state)
    }

    #[test]
    fn token_hash_is_stable_and_tokens_have_entropy() {
        assert_eq!(token_hash("same"), token_hash("same"));
        assert_ne!(random_token("test"), random_token("test"));
        assert!(random_token("test").starts_with("test_"));
    }

    #[test]
    fn snapshot_allocates_cloud_ids_and_deduplicates_events() {
        let (_dir, state) = state();
        {
            let db = state.inner.db.lock();
            db.execute(
                "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
                 VALUES('d','i','desktop','x',1,1)",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO bindings(id,device_id,mobile_name,token_hash,scopes_json,created_at)
                 VALUES('b','d','phone','y','[\"sessions.read\"]',1)",
                [],
            )
            .unwrap();
        }
        sync_session_snapshot(
            &state,
            "d",
            "boot",
            vec![AgentSession {
                local_id: 7,
                dto: json!({"id":7,"backend_key":"codex","title":"t","model":"m","status":"idle","tokens":{}}),
            }],
        )
        .unwrap();
        let event = || AgentEnvelope {
            protocol_version: "v1".into(),
            schema_version: 1,
            session_id: 7,
            ts: 10,
            kind: "message".into(),
            payload: json!({"role":"user","text":"hi"}),
        };
        persist_agent_event(&state, "d", "boot", 7, event()).unwrap();
        persist_agent_event(&state, "d", "boot", 7, event()).unwrap();
        persist_agent_event(
            &state,
            "d",
            "boot",
            7,
            AgentEnvelope {
                kind: "pty_bytes".into(),
                ..event()
            },
        )
        .unwrap();
        let db = state.inner.db.lock();
        let cloud_id: i64 = db
            .query_row("SELECT id FROM sessions", [], |row| row.get(0))
            .unwrap();
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .unwrap();
        assert!(cloud_id > 0);
        assert_eq!(count, 1);
        drop(db);

        sync_session_snapshot(&state, "d", "boot", vec![]).unwrap();
        let status: String = state
            .inner
            .db
            .lock()
            .query_row(
                "SELECT json_extract(dto_json, '$.status') FROM sessions WHERE id=?1",
                [cloud_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "exited");
    }

    #[test]
    fn existing_snapshot_publishes_complete_session_update() {
        let (_dir, state) = state();
        state
            .inner
            .db
            .lock()
            .execute(
                "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
                 VALUES('d','i','desktop','x',1,1)",
                [],
            )
            .unwrap();
        let mut mobile = state.mobile_bus("d").subscribe();

        sync_session_snapshot(
            &state,
            "d",
            "boot",
            vec![AgentSession {
                local_id: 7,
                dto: json!({
                    "id": 7,
                    "backend_key": "codex",
                    "title": "",
                    "model": "auto",
                    "status": "idle",
                    "tokens": {}
                }),
            }],
        )
        .unwrap();
        assert_eq!(mobile.try_recv().unwrap().kind, "session.created");

        sync_session_snapshot(
            &state,
            "d",
            "boot",
            vec![AgentSession {
                local_id: 7,
                dto: json!({
                    "id": 7,
                    "backend_key": "codex",
                    "title": "修复 mobile title",
                    "model": "gpt-test",
                    "status": "busy",
                    "tokens": {"total": 42}
                }),
            }],
        )
        .unwrap();

        let update = mobile.try_recv().unwrap();
        assert_eq!(update.kind, "session.updated");
        assert_eq!(update.payload["title"], "修复 mobile title");
        assert_eq!(update.payload["id"], update.session_id);
        assert_eq!(update.payload["tokens"]["total"], 42);
    }

    #[test]
    fn null_meta_fields_do_not_clear_session_snapshot_values() {
        let (_dir, state) = state();
        state
            .inner
            .db
            .lock()
            .execute(
                "INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at)
                 VALUES('d','i','desktop','x',1,1)",
                [],
            )
            .unwrap();
        sync_session_snapshot(
            &state,
            "d",
            "boot",
            vec![AgentSession {
                local_id: 7,
                dto: json!({
                    "id": 7,
                    "backend_key": "codex",
                    "title": "分析下 t3 问题",
                    "model": "gpt-5.6",
                    "status": "busy",
                    "context_pct": 23.5,
                    "cost_usd": 1.25,
                    "tokens": {"total": 100, "input": 80, "output": 20, "cached": 10}
                }),
            }],
        )
        .unwrap();

        persist_agent_event(
            &state,
            "d",
            "boot",
            7,
            AgentEnvelope {
                protocol_version: "v1".into(),
                schema_version: 1,
                session_id: 7,
                ts: 10,
                kind: "meta".into(),
                payload: json!({
                    "title": null,
                    "model": null,
                    "context_pct": null,
                    "cost_usd": null,
                    "tokens": 120,
                    "input_tokens": null,
                    "output_tokens": null,
                    "cached_tokens": null
                }),
            },
        )
        .unwrap();

        let dto_raw: String = state
            .inner
            .db
            .lock()
            .query_row("SELECT dto_json FROM sessions", [], |row| row.get(0))
            .unwrap();
        let dto: Value = serde_json::from_str(&dto_raw).unwrap();
        assert_eq!(dto["title"], "分析下 t3 问题");
        assert_eq!(dto["model"], "gpt-5.6");
        assert_eq!(dto["context_pct"], 23.5);
        assert_eq!(dto["cost_usd"], 1.25);
        assert_eq!(dto["tokens"]["total"], 120);
        assert_eq!(dto["tokens"]["input"], 80);
        assert_eq!(dto["tokens"]["output"], 20);
        assert_eq!(dto["tokens"]["cached"], 10);
    }

    #[tokio::test]
    async fn pairing_enables_sync_and_routes_message_to_online_desktop() {
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let origin = format!("http://{addr}");
        let state = ServerState::open(ServerConfig {
            database_path: dir.path().join("sync.db"),
            public_url: origin.clone(),
        })
        .unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        let client = reqwest::Client::new();

        let registration: Value = client
            .post(format!("{origin}/api/v1/devices/register"))
            .json(&json!({"installation_id":"install-1","name":"Test Mac"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let device_id = registration["device_id"].as_str().unwrap();
        let device_token = registration["device_token"].as_str().unwrap();

        let mut agent_request = format!("ws://{addr}/api/v1/agent/ws?device_id={device_id}")
            .into_client_request()
            .unwrap();
        agent_request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {device_token}")).unwrap(),
        );
        let (mut agent, _) = tokio_tungstenite::connect_async(agent_request)
            .await
            .unwrap();
        let hello: Value =
            serde_json::from_str(agent.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(hello["sync_enabled"], false);

        let mut duplicate_agent_request =
            format!("ws://{addr}/api/v1/agent/ws?device_id={device_id}")
                .into_client_request()
                .unwrap();
        duplicate_agent_request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {device_token}")).unwrap(),
        );
        let duplicate_error = tokio_tungstenite::connect_async(duplicate_agent_request)
            .await
            .expect_err("duplicate desktop agent must be rejected");
        assert!(duplicate_error.to_string().contains("409"));

        let pairing: Value = client
            .post(format!("{origin}/api/v1/devices/{device_id}/pairings"))
            .bearer_auth(device_token)
            .json(&json!({"scopes":[]}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let pairing_id = pairing["pairing_id"].as_str().unwrap();
        let secret = pairing["secret"].as_str().unwrap();
        let claim: Value = client
            .post(format!("{origin}/api/v1/pairings/{pairing_id}/claim"))
            .json(&json!({"secret":secret,"mobile_name":"Test Phone"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let mobile_token = claim["access_token"].as_str().unwrap();
        let bound: Value =
            serde_json::from_str(agent.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(bound["type"], "pairing.bound");

        let mut mobile_request = format!("ws://{addr}/ws").into_client_request().unwrap();
        mobile_request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {mobile_token}")).unwrap(),
        );
        let (mut mobile, _) = tokio_tungstenite::connect_async(mobile_request)
            .await
            .unwrap();
        let mobile_hello: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(2), mobile.next())
                .await
                .expect("mobile hello timeout")
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(mobile_hello["type"], "connection.hello");

        agent
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type":"hello",
                    "boot_id":"boot-1",
                    "sessions":[{
                        "local_id":9,
                        "dto":{
                            "id":9,"backend_key":"codex","title":"route test",
                            "model":"gpt-test","status":"idle","cwd":"/tmp/project",
                            "session_uuid":"session-1","tokens":{}
                        }
                    }]
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let created: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(2), mobile.next())
                .await
                .expect("session.created timeout")
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(created["type"], "session.created");
        tokio::time::sleep(Duration::from_millis(25)).await;
        let sessions: Value = client
            .get(format!("{origin}/api/v1/sessions"))
            .bearer_auth(mobile_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let cloud_session_id = sessions["sessions"][0]["id"].as_i64().unwrap();

        let send = client
            .post(format!("{origin}/api/v1/sessions/{cloud_session_id}/input"))
            .bearer_auth(mobile_token)
            .header("Idempotency-Key", "mobile-send-1")
            .json(&json!({"text":"hello from phone\n"}))
            .send()
            .await
            .unwrap();
        assert_eq!(send.status(), StatusCode::ACCEPTED);
        let command: Value =
            serde_json::from_str(agent.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(command["type"], "command");
        assert_eq!(command["local_session_id"], 9);
        assert_eq!(command["payload"]["text"], "hello from phone\n");
        let dispatched: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(2), mobile.next())
                .await
                .expect("command.status timeout")
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(dispatched["type"], "command.status");
        assert_eq!(dispatched["payload"]["status"], "dispatched");

        agent
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type":"event","boot_id":"boot-1","local_session_id":9,
                    "event":{
                        "protocol_version":"v1","schema_version":1,"session_id":9,
                        "ts":42,"type":"message",
                        "payload":{"role":"user","text":"hello from phone"}
                    }
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let mirrored: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(2), mobile.next())
                .await
                .expect("mirrored event timeout")
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(mirrored["type"], "message");
        assert_eq!(mirrored["payload"]["text"], "hello from phone");
        tokio::time::sleep(Duration::from_millis(25)).await;
        let history: Value = client
            .get(format!(
                "{origin}/api/v1/sessions/{cloud_session_id}/history"
            ))
            .bearer_auth(mobile_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(history["events"][0]["session_id"], cloud_session_id);
        assert_eq!(history["events"][0]["payload"]["text"], "hello from phone");

        agent
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type":"event","boot_id":"boot-1","local_session_id":9,
                    "event":{
                        "protocol_version":"v1","schema_version":1,"session_id":9,
                        "ts":43,"type":"session.exited","payload":{"exit_code":0}
                    }
                })
                .to_string(),
            ))
            .await
            .unwrap();
        let exited: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(2), mobile.next())
                .await
                .expect("session.exited timeout")
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(exited["type"], "session.exited");
        let sessions_after_exit: Value = client
            .get(format!("{origin}/api/v1/sessions"))
            .bearer_auth(mobile_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(sessions_after_exit["sessions"], json!([]));

        let revoked = client
            .delete(format!("{origin}/api/v1/bindings/current"))
            .bearer_auth(mobile_token)
            .send()
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
        let changed: Value =
            serde_json::from_str(agent.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(changed["type"], "binding.changed");
        assert_eq!(changed["sync_enabled"], false);
        let mobile_revoked: Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(2), mobile.next())
                .await
                .expect("binding.revoked timeout")
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(mobile_revoked["type"], "binding.revoked");

        let _ = agent.close(None).await;
        server.abort();
    }
}
