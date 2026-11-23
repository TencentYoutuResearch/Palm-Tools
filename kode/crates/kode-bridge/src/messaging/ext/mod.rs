//! Extension API `kode.api/v1` (`/api/ext/v1`). Extensions call it with a
//! scoped token minted by their host; the admin token never leaves Kode.
//! Sessions run in the GUI runtime and are reached through the existing
//! runtime mailbox. Turn events are derived from the durable runtime log and
//! pushed over SSE, so no extension polls.
mod projector;
mod store;
#[cfg(test)]
mod tests;

use super::{model::valid_id, Hub};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    convert::Infallible,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const API_VERSION: u32 = 1;

/// Capabilities an extension manifest may request for this API. Hosts reject
/// unknown names so a typo never silently grants nothing.
pub const CAPABILITIES: &[&str] = &[
    "sessions.read",
    "sessions.create",
    "sessions.input",
    "sessions.interrupt",
    "events.subscribe",
    "bots.read",
];

const FEATURES: &[&str] = &[
    "sessions",
    "initial_input",
    "turn_lifecycle",
    "events.stream",
];
const MAX_LABELS: usize = 16;
const MAX_META_BYTES: usize = 16 * 1024;
const FINAL_MESSAGE_CHARS: usize = 16_000;
const INITIAL_INPUT_TIMEOUT: Duration = Duration::from_secs(90);

pub struct Gateway {
    store: store::Store,
    latest: tokio::sync::watch::Sender<u64>,
    stopped: AtomicBool,
    wake: tokio::sync::Notify,
    grace: Duration,
}

impl Gateway {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        Ok(Self::with_store(
            store::Store::open(path)?,
            projector::COMPLETION_GRACE,
        ))
    }

    fn with_store(store: store::Store, grace: Duration) -> Self {
        let (latest, _) = tokio::sync::watch::channel(store.latest_seq());
        Self {
            store,
            latest,
            stopped: AtomicBool::new(false),
            wake: Default::default(),
            grace,
        }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        self.wake.notify_waiters();
    }

    fn append(&self, session: u64, kind: &str, payload: Value) -> anyhow::Result<()> {
        let event = self.store.append(session, kind, &payload)?;
        self.latest.send_replace(event.seq);
        Ok(())
    }
}

struct Error(StatusCode, String);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Self(StatusCode::BAD_REQUEST, e.to_string())
    }
}
type Result<T> = std::result::Result<T, Error>;

fn bearer(headers: &HeaderMap) -> Result<&str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "unauthorized".into()))
}

fn ctx(hub: &Hub) -> Result<Arc<crate::Ctx>> {
    hub.ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))
}

fn admin(hub: &Hub, headers: &HeaderMap) -> Result<()> {
    let token = bearer(headers)?;
    if crate::constant_eq(token, &ctx(hub)?.token) {
        Ok(())
    } else {
        Err(Error(
            StatusCode::FORBIDDEN,
            "administrator required".into(),
        ))
    }
}

struct Caller {
    extension: String,
    capabilities: Vec<String>,
}
impl Caller {
    fn require(&self, capability: &str) -> Result<()> {
        if self.capabilities.iter().any(|c| c == capability) {
            Ok(())
        } else {
            Err(Error(
                StatusCode::FORBIDDEN,
                format!("capability {capability} not granted"),
            ))
        }
    }
}

fn caller(hub: &Hub, headers: &HeaderMap) -> Result<Caller> {
    let grant = hub
        .ext
        .store
        .principal(bearer(headers)?)?
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "unauthorized".into()))?;
    Ok(Caller {
        extension: grant.extension,
        capabilities: grant.capabilities,
    })
}

/// The caller's own session, or 404 so foreign ids reveal nothing.
fn owned(hub: &Hub, caller: &Caller, id: u64) -> Result<store::Owned> {
    hub.ext
        .store
        .owner(id)?
        .filter(|o| o.extension == caller.extension)
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown session".into()))
}

fn request_id(extension: &str, key: &str, suffix: &str) -> String {
    format!(
        "ext.{}{suffix}",
        &store::digest(&format!("{extension}\n{key}"))[..48]
    )
}

pub(super) fn router(hub: Arc<Hub>) -> Router {
    Router::new()
        .route("/api/v1/messaging/extensions/grants", post(grant))
        .route(
            "/api/v1/messaging/extensions/grants/:extension",
            delete(revoke),
        )
        .route("/api/ext/v1/hello", get(hello))
        .route("/api/ext/v1/sessions", get(list).post(create))
        .route("/api/ext/v1/sessions/:id", get(read))
        .route("/api/ext/v1/sessions/:id/input", post(input))
        .route("/api/ext/v1/sessions/:id/interrupt", post(interrupt))
        .route("/api/ext/v1/sessions/:id/meta", post(update_meta))
        .route("/api/ext/v1/bots", get(list_bots))
        .route("/api/ext/v1/events", get(events))
        .route("/api/ext/v1/events/stream", get(stream))
        .with_state(hub)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRequest {
    extension_id: String,
    capabilities: Vec<String>,
}
async fn grant(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(req): Json<GrantRequest>,
) -> Result<Json<Value>> {
    admin(&hub, &h)?;
    if !valid_id(&req.extension_id) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid extension id".into(),
        ));
    }
    if let Some(unknown) = req
        .capabilities
        .iter()
        .find(|c| !CAPABILITIES.contains(&c.as_str()))
    {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            format!("unknown capability {unknown}"),
        ));
    }
    let token = hub.ext.store.grant(&req.extension_id, &req.capabilities)?;
    Ok(Json(json!({"token":token,"api_version":API_VERSION})))
}
async fn revoke(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(extension): Path<String>,
) -> Result<Json<Value>> {
    admin(&hub, &h)?;
    hub.ext.store.revoke(&extension)?;
    Ok(Json(json!({"revoked":true})))
}

async fn hello(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    Ok(Json(json!({
        "api_version": API_VERSION,
        "extension_id": caller.extension,
        "capabilities": caller.capabilities,
        "features": FEATURES,
        "node_id": hub.node_id(),
        // Pass as `after` to follow events from here without a race.
        "event_cursor": hub.ext.store.latest_seq(),
        "runtimes": {"gui": ctx(&hub)?.runtimes.available("gui")},
    })))
}

/// The user's bots as extensions see them: identity and limits, no persona.
async fn list_bots(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("bots.read")?;
    let (_, roster) = super::bots::roster(&hub)?;
    let bots: Vec<Value> = roster
        .bots
        .iter()
        .map(|bot| bot.public(roster.default_bot.as_deref() == Some(bot.id.as_str())))
        .collect();
    Ok(Json(json!({"bots":bots,"default_bot":roster.default_bot})))
}

fn describe(dto: Value, owner: Option<&store::Owned>) -> Value {
    let mut dto = dto;
    dto["ext"] = owner.map(store::Owned::describe).unwrap_or(Value::Null);
    dto
}

#[derive(Deserialize)]
struct ListQuery {
    owner: Option<String>,
    label: Option<String>,
}
async fn list(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    let ctx = ctx(&hub)?;
    let sessions: Vec<Value> = match q.owner.as_deref().unwrap_or("self") {
        "self" => hub
            .ext
            .store
            .owned_by(&caller.extension)?
            .into_iter()
            .filter(|(_, o)| q.label.as_ref().is_none_or(|l| o.labels.contains(l)))
            .filter_map(|(id, o)| ctx.runtimes.snapshot(id).map(|dto| describe(dto, Some(&o))))
            .collect(),
        "any" => {
            caller.require("sessions.read")?;
            let mut result = json!({"sessions":ctx.runtimes.snapshots().into_iter().map(|s|s["dto"].clone()).collect::<Vec<_>>()});
            super::filter_visible_runtime_sessions(&mut result, &hub.store.document("workspaces")?);
            let rows = result["sessions"].as_array().cloned().unwrap_or_default();
            let mut sessions = vec![];
            for dto in rows {
                let owner = dto["id"]
                    .as_u64()
                    .map(|id| hub.ext.store.owner(id))
                    .transpose()?
                    .flatten();
                if q.label
                    .as_ref()
                    .is_some_and(|l| !owner.as_ref().is_some_and(|o| o.labels.contains(l)))
                {
                    continue;
                }
                sessions.push(describe(dto, owner.as_ref()));
            }
            sessions
        }
        _ => {
            return Err(Error(
                StatusCode::BAD_REQUEST,
                "owner must be self or any".into(),
            ))
        }
    };
    Ok(Json(json!({"sessions":sessions})))
}

async fn read(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<u64>,
) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    let owner = hub.ext.store.owner(id)?;
    let mine = owner
        .as_ref()
        .is_some_and(|o| o.extension == caller.extension);
    if !mine {
        caller
            .require("sessions.read")
            .map_err(|_| Error(StatusCode::NOT_FOUND, "unknown session".into()))?;
    }
    let dto = ctx(&hub)?
        .runtimes
        .snapshot(id)
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown session".into()))?;
    Ok(Json(describe(dto, owner.as_ref())))
}

fn validate_labels(labels: &[String]) -> Result<()> {
    if labels.len() > MAX_LABELS || labels.iter().any(|l| l.len() > 64 || !valid_id(l)) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            format!("at most {MAX_LABELS} labels of [A-Za-z0-9-_.:], 64 bytes each"),
        ));
    }
    Ok(())
}
fn validate_meta(meta: &Value) -> Result<()> {
    if serde_json::to_vec(meta).map_or(true, |b| b.len() > MAX_META_BYTES) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            format!("meta must stay under {MAX_META_BYTES} bytes"),
        ));
    }
    Ok(())
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct CreateRequest {
    /// Run as a bot (an id, or `"default"` for the user's assistant). The bot
    /// decides the Agent, persona, memory scope and permission ceiling.
    #[serde(default)]
    bot: Option<String>,
    #[serde(default)]
    backend_key: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    permission_mode: Option<String>,
    #[serde(default)]
    initial_input: Option<String>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    meta: Value,
    #[serde(default)]
    parent: Option<u64>,
    idempotency_key: String,
}

/// What the runtime is asked to start, after a bot (if any) is applied.
struct Launch {
    backend_key: String,
    cwd: String,
    model: Option<String>,
    permission_mode: Option<String>,
    persona: Option<String>,
    labels: Vec<String>,
}

fn launch(hub: &Hub, caller: &Caller, req: &CreateRequest) -> Result<Launch> {
    let mut labels = req.labels.clone();
    let Some(bot) = req.bot.as_deref() else {
        let backend_key = req.backend_key.clone().ok_or_else(|| Error(StatusCode::BAD_REQUEST, "backend_key or bot is required".into()))?;
        let cwd = req.cwd.clone().ok_or_else(|| Error(StatusCode::BAD_REQUEST, "cwd is required".into()))?;
        return Ok(Launch { backend_key, cwd, model: req.model.clone(), permission_mode: req.permission_mode.clone(), persona: None, labels });
    };
    caller.require("bots.read")?;
    let bot = super::bots::resolve(hub, bot).map_err(|e| Error(StatusCode::NOT_FOUND, e.to_string()))?;
    if req.backend_key.as_ref().is_some_and(|key| *key != bot.backend_key) {
        return Err(Error(StatusCode::BAD_REQUEST, "a bot runs its own Agent; omit backend_key".into()));
    }
    let permission = super::bots::effective_permission(req.permission_mode.as_deref(), &bot.permission_ceiling)
        .map_err(|e| Error(StatusCode::FORBIDDEN, e.to_string()))?;
    let cwd = req.cwd.clone().or_else(|| bot.default_cwd.clone())
        .ok_or_else(|| Error(StatusCode::BAD_REQUEST, "cwd is required: this bot has no default workspace".into()))?;
    let label = format!("bot:{}", bot.id);
    if !labels.contains(&label) {
        labels.push(label);
        validate_labels(&labels)?;
    }
    Ok(Launch {
        persona: Some(bot.persona_prompt()),
        backend_key: bot.backend_key,
        cwd,
        model: req.model.clone().or(bot.model),
        permission_mode: Some(permission),
        labels,
    })
}

async fn create(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(req): Json<CreateRequest>,
) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("sessions.create")?;
    if !valid_id(&req.idempotency_key) {
        return Err(Error(StatusCode::BAD_REQUEST, "invalid idempotency_key".into()));
    }
    validate_labels(&req.labels)?;
    validate_meta(&req.meta)?;
    if req
        .initial_input
        .as_ref()
        .is_some_and(|t| t.trim().is_empty() || t.len() > super::model::MAX_CONTENT_BYTES)
    {
        return Err(Error(StatusCode::BAD_REQUEST, "initial_input must be non-empty and under 64 KiB".into()));
    }
    if let Some(parent) = req.parent {
        owned(&hub, &caller, parent)?;
    }
    let ctx = ctx(&hub)?;
    let fingerprint = store::digest(&serde_json::to_string(&req).map_err(anyhow::Error::from)?);
    if let Some(prior) = hub
        .ext
        .store
        .begin_request(&caller.extension, &req.idempotency_key, &fingerprint)
        .map_err(|e| Error(StatusCode::CONFLICT, e.to_string()))?
    {
        return Ok(Json(prior));
    }
    let launch = launch(&hub, &caller, &req)?;
    if !ctx.runtimes.available("gui") {
        return Err(Error(StatusCode::SERVICE_UNAVAILABLE, "Open Kode on this computer before creating a session".into()));
    }
    let rid = request_id(&caller.extension, &req.idempotency_key, "");
    let payload = json!({"backend_key":launch.backend_key,"cwd":launch.cwd,"model":launch.model,"permission_mode":launch.permission_mode,"system_prompt":launch.persona});
    let dto = ctx.runtimes.request("gui", None, "create_session", payload, &rid).await?;
    let id = dto["id"]
        .as_u64()
        .ok_or_else(|| Error(StatusCode::BAD_GATEWAY, "runtime did not return a session".into()))?;
    // A backend without a system prompt flag (or an older Kode) gets the
    // persona as the first message instead.
    let persona_message = launch.persona.filter(|_| dto["system_prompt"] != "applied");
    let first_input = match (persona_message, req.initial_input) {
        (Some(persona), Some(text)) => Some(format!("{persona}\n\n{text}")),
        (persona, text) => persona.or(text),
    };
    let owner = store::Owned { extension: caller.extension.clone(), labels: launch.labels, meta: req.meta, parent: req.parent };
    hub.ext.store.own(id, &owner)?;
    let pending = first_input.is_some();
    let result = json!({"session":describe(dto, Some(&owner)),"initial_input":if pending {json!("pending")} else {Value::Null}});
    hub.ext.store.finish_request(&caller.extension, &req.idempotency_key, &result)?;
    hub.ext.append(id, "session.created", json!({"labels":owner.labels,"parent":owner.parent}))?;
    if let Some(text) = first_input {
        tokio::spawn(deliver_initial(hub.clone(), ctx, id, text, format!("{rid}.in")));
    }
    Ok(Json(result))
}

/// A new CLI takes input only once it settles at its prompt; typing earlier
/// can land in its startup screen. Wait for the first idle, driven by the
/// runtime's own updates.
async fn deliver_initial(hub: Arc<Hub>, ctx: Arc<crate::Ctx>, id: u64, text: String, rid: String) {
    let mut bus = ctx.bus.subscribe();
    let deadline = tokio::time::Instant::now() + INITIAL_INPUT_TIMEOUT;
    let outcome = loop {
        match ctx
            .runtimes
            .snapshot(id)
            .as_ref()
            .and_then(|dto| dto["status"].as_str().map(str::to_owned))
            .as_deref()
        {
            Some("idle") => {
                break ctx
                    .runtimes
                    .command(id, "input", json!({"text":text}), &rid)
                    .await
                    .map(|_| ())
            }
            Some("exited") | None => {
                break Err(anyhow::anyhow!("session exited before it was ready"))
            }
            _ => {}
        }
        tokio::select! {
            _ = bus.recv() => {}
            // Safety net for a missed broadcast; the bus is the normal wake-up.
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            _ = tokio::time::sleep_until(deadline) => break Err(anyhow::anyhow!("session was not ready within 90 seconds")),
        }
        if hub.ext.stopped.load(Ordering::Relaxed) {
            return;
        }
    };
    let payload = match outcome {
        Ok(()) => json!({"status":"delivered"}),
        Err(e) => json!({"status":"failed","error":e.to_string()}),
    };
    if let Err(e) = hub.ext.append(id, "session.input_result", payload) {
        tracing::warn!(error=%e, "extension initial input result not recorded");
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputRequest {
    text: String,
    idempotency_key: String,
}
async fn input(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<u64>,
    Json(req): Json<InputRequest>,
) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("sessions.input")?;
    owned(&hub, &caller, id)?;
    if !valid_id(&req.idempotency_key)
        || req.text.trim().is_empty()
        || req.text.len() > super::model::MAX_CONTENT_BYTES
    {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "text must be non-empty and under 64 KiB, with a valid idempotency_key".into(),
        ));
    }
    let rid = request_id(&caller.extension, &req.idempotency_key, ".input");
    ctx(&hub)?
        .runtimes
        .command(id, "input", json!({"text":req.text}), &rid)
        .await?;
    Ok(Json(json!({"accepted":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InterruptRequest {
    idempotency_key: String,
}
async fn interrupt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<u64>,
    Json(req): Json<InterruptRequest>,
) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("sessions.interrupt")?;
    owned(&hub, &caller, id)?;
    if !valid_id(&req.idempotency_key) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid idempotency_key".into(),
        ));
    }
    let rid = request_id(&caller.extension, &req.idempotency_key, ".interrupt");
    ctx(&hub)?
        .runtimes
        .command(id, "interrupt", json!({}), &rid)
        .await?;
    Ok(Json(json!({"accepted":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MetaRequest {
    #[serde(default)]
    labels: Option<Vec<String>>,
    #[serde(default)]
    meta: Option<Value>,
}
async fn update_meta(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<u64>,
    Json(req): Json<MetaRequest>,
) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    owned(&hub, &caller, id)?;
    if let Some(labels) = &req.labels {
        validate_labels(labels)?;
    }
    if let Some(meta) = &req.meta {
        validate_meta(meta)?;
    }
    hub.ext
        .store
        .update_meta(id, req.labels.as_deref(), req.meta.as_ref())?;
    let owner = owned(&hub, &caller, id)?;
    Ok(Json(owner.describe()))
}

#[derive(Deserialize, Clone)]
struct EventQuery {
    #[serde(default)]
    after: Option<u64>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    session: Option<u64>,
    /// Comma-separated event kinds; empty means all.
    #[serde(default)]
    kinds: Option<String>,
}
struct Filter {
    owner: Option<String>,
    session: Option<u64>,
    kinds: Vec<String>,
}
fn filter(hub: &Hub, caller: &Caller, q: &EventQuery) -> Result<Filter> {
    caller.require("events.subscribe")?;
    let owner = match q.owner.as_deref().unwrap_or("self") {
        "self" => Some(caller.extension.clone()),
        "any" => {
            caller.require("sessions.read")?;
            None
        }
        _ => {
            return Err(Error(
                StatusCode::BAD_REQUEST,
                "owner must be self or any".into(),
            ))
        }
    };
    if let (Some(session), Some(_)) = (q.session, owner.as_ref()) {
        owned(hub, caller, session)?;
    }
    let kinds = q
        .kinds
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(Filter {
        owner,
        session: q.session,
        kinds,
    })
}
impl Filter {
    fn page(&self, gateway: &Gateway, after: u64) -> anyhow::Result<(Vec<store::Event>, u64)> {
        let rows = gateway
            .store
            .events(after, self.owner.as_deref(), self.session, 200)?;
        let cursor = rows.last().map_or(after, |e| e.seq);
        Ok((
            rows.into_iter()
                .filter(|e| self.kinds.is_empty() || self.kinds.contains(&e.kind))
                .collect(),
            cursor,
        ))
    }
}

/// One page, for clients without SSE.
async fn events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(q): Query<EventQuery>,
) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    let filter = filter(&hub, &caller, &q)?;
    let after = q.after.unwrap_or(0);
    let (events, cursor) = filter.page(&hub.ext, after)?;
    Ok(Json(json!({"events":events,"cursor":cursor})))
}

/// Replays from `after` (or `Last-Event-ID`) and then follows new events.
/// Each event's SSE id is its cursor, so a reconnect resumes losslessly.
async fn stream(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(q): Query<EventQuery>,
) -> Result<Sse<impl Stream<Item = std::result::Result<SseEvent, Infallible>>>> {
    let caller = caller(&hub, &h)?;
    let filter = filter(&hub, &caller, &q)?;
    let resume = h
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let after = resume
        .or(q.after)
        .unwrap_or_else(|| hub.ext.store.latest_seq());
    let rx = hub.ext.latest.subscribe();
    let state = (hub, filter, after, rx, VecDeque::<store::Event>::new());
    let stream = futures_util::stream::unfold(
        state,
        |(hub, filter, mut after, mut rx, mut buffer)| async move {
            loop {
                if let Some(event) = buffer.pop_front() {
                    let sse = SseEvent::default()
                        .id(event.seq.to_string())
                        .event(event.kind.clone())
                        .json_data(&event)
                        .unwrap_or_else(|_| SseEvent::default().comment("unserializable event"));
                    return Some((Ok(sse), (hub, filter, after, rx, buffer)));
                }
                if hub.ext.stopped.load(Ordering::Relaxed) {
                    return None;
                }
                rx.borrow_and_update();
                match filter.page(&hub.ext, after) {
                    Ok((rows, cursor)) => {
                        let advanced = cursor != after;
                        after = cursor;
                        buffer.extend(rows);
                        if advanced {
                            continue;
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error=%e, "extension event stream read failed");
                        return None;
                    }
                }
                tokio::select! {
                    changed = rx.changed() => if changed.is_err() { return None },
                    _ = hub.ext.wake.notified() => {}
                }
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

/// Follow the durable runtime log and append derived turn events. The cursor
/// is persisted, so a restart neither replays old turns nor skips new ones.
pub(super) fn spawn_projector(hub: Arc<Hub>) {
    tokio::spawn(async move {
        let Some(ctx) = hub.ctx.upgrade() else { return };
        let mut bus = ctx.bus.subscribe();
        let gateway = &hub.ext;
        let mut cursor = match gateway.store.state("runtime_cursor") {
            Ok(Some(value)) => value.as_u64().unwrap_or(0),
            _ => ctx.runtimes.latest_event(),
        };
        let mut machine = projector::Projector::new(gateway.grace);
        drop(ctx);
        while !gateway.stopped.load(Ordering::Relaxed) {
            let Some(ctx) = hub.ctx.upgrade() else { return };
            if let Err(e) = project(gateway, &ctx, &mut machine, &mut cursor) {
                tracing::warn!(error=%e, "extension event projection failed");
            }
            let wait = machine
                .next_deadline()
                .map_or(Duration::from_secs(30), |at| {
                    at.saturating_duration_since(Instant::now())
                });
            drop(ctx);
            tokio::select! {
                received = bus.recv() => match received {
                    Ok(event) if event.r#type == "session.updated" && event.payload["status"] == "exited" => {
                        for (id, kind, payload) in machine.exit(event.session_id) {
                            if let Err(e) = gateway.append(id, kind, payload) {
                                tracing::warn!(error=%e, "extension exit event not recorded");
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    // Lag only means "something changed": the log is read next.
                    _ => {}
                },
                _ = tokio::time::sleep(wait) => {}
                _ = gateway.wake.notified() => {}
            }
        }
    });
}

fn project(
    gateway: &Gateway,
    ctx: &crate::Ctx,
    machine: &mut projector::Projector,
    cursor: &mut u64,
) -> anyhow::Result<()> {
    let start = *cursor;
    loop {
        let batch = ctx.runtimes.events_after(*cursor, 500)?;
        let now = Instant::now();
        for event in &batch {
            for (id, kind, payload) in machine.feed(event, now) {
                gateway.append(id, kind, payload)?;
            }
            *cursor = event.ts;
        }
        if batch.len() < 500 {
            break;
        }
    }
    if *cursor != start {
        gateway.store.set_state("runtime_cursor", &json!(*cursor))?;
    }
    for (id, turn) in machine.due(Instant::now()) {
        let history = ctx.runtimes.history(id, 0, 200)?;
        let message = projector::final_message(&history, FINAL_MESSAGE_CHARS);
        gateway.append(
            id,
            "session.turn_completed",
            json!({"turn_id":turn,"outcome":"idle","final_message":message}),
        )?;
    }
    Ok(())
}
