//! Agent tools contributed by extensions. An extension declares tools in its
//! manifest; Kode sends the definitions with its grant. The session MCP that
//! Kode gives every CLI lists the tools a session may use and forwards calls
//! here; the extension long-polls for calls and posts results. Its backend
//! address never leaves Kode, and a tool only reaches sessions the
//! extension owns (optionally only those with given labels).
use super::{caller, store::Owned, Error, Result};
use crate::messaging::Hub;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};

const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_WAIT: Duration = Duration::from_secs(25);
const MAX_QUEUED: usize = 64;
const MAX_TOOLS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    #[serde(default = "empty_schema", rename = "inputSchema", alias = "input_schema")]
    pub input_schema: Value,
    /// Labels a session must carry (any of them); empty = every session the
    /// extension owns.
    #[serde(default)]
    pub labels: Vec<String>,
}

fn empty_schema() -> Value {
    json!({"type":"object","properties":{}})
}

pub fn validate(tools: &[ToolDef]) -> anyhow::Result<()> {
    if tools.len() > MAX_TOOLS {
        anyhow::bail!("at most {MAX_TOOLS} agent tools")
    }
    let mut seen = std::collections::HashSet::new();
    for tool in tools {
        let name = tool.name.as_str();
        let shaped = name.len() >= 2 && name.len() <= 48 && name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        if !shaped || name.starts_with("kode_") || name.starts_with("memory_") || !seen.insert(name) {
            anyhow::bail!("invalid or reserved agent tool name `{name}`")
        }
        if tool.description.trim().is_empty() || tool.description.len() > 2000 || !tool.input_schema.is_object() || tool.input_schema.to_string().len() > 16 * 1024 {
            anyhow::bail!("agent tool `{name}` needs a description and an object input schema")
        }
    }
    Ok(())
}

struct Pending {
    id: String,
    name: String,
    arguments: Value,
    session: Value,
}

#[derive(Default)]
pub struct Tools {
    /// extension → its tools
    defs: Mutex<HashMap<String, Vec<ToolDef>>>,
    queues: Mutex<HashMap<String, VecDeque<Pending>>>,
    waiting: Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<Value>)>>,
    queued: tokio::sync::Notify,
}

impl Tools {
    pub fn set(&self, extension: &str, tools: Vec<ToolDef>) {
        let mut defs = self.defs.lock();
        if tools.is_empty() {
            defs.remove(extension);
        } else {
            defs.insert(extension.to_owned(), tools);
        }
    }

    pub fn clear(&self, extension: &str) {
        self.defs.lock().remove(extension);
        self.queues.lock().remove(extension);
        // Callers waiting on this extension get an error instead of a hang.
        self.waiting.lock().retain(|_, (owner, _)| owner != extension);
    }

    fn visible(&self, owner: &Owned) -> Vec<ToolDef> {
        self.defs
            .lock()
            .get(&owner.extension)
            .map(|tools| tools.iter().filter(|t| t.labels.is_empty() || t.labels.iter().any(|l| owner.labels.contains(l))).cloned().collect())
            .unwrap_or_default()
    }
}

/// The runtime session behind a session principal and its extension owner.
fn owner_of(hub: &Hub, session: &str) -> anyhow::Result<Option<(u64, Owned)>> {
    let Some(id) = hub.native.lock().get(session).copied() else { return Ok(None) };
    Ok(hub.ext.store.owner(id)?.map(|owner| (id, owner)))
}

fn young(hub: &Hub, session: &str) -> bool {
    let Some(id) = hub.native.lock().get(session).copied() else { return false };
    let Some(ctx) = hub.ctx.upgrade() else { return false };
    ctx.runtimes.snapshot(id).and_then(|dto| dto["reserved_at"].as_u64()).is_some_and(|at| crate::now_ms().saturating_sub(at) < 30_000)
}

fn session_principal(hub: &Hub, h: &HeaderMap) -> Result<String> {
    let token = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "unauthorized".into()))?;
    hub.store.principal(token)?.ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "unauthorized".into()))
}

/// Tools for the calling session (session MCP → backend).
pub(super) async fn list(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<Value>> {
    let session = session_principal(&hub, &h)?;
    // A session an extension just created can publish before its owner is
    // recorded; a young session waits a moment before "no tools". Others
    // (every session nobody owns) answer at once.
    for attempt in 0..10 {
        if let Some((_, owner)) = owner_of(&hub, &session)? {
            return Ok(Json(json!({"tools":hub.ext.tools.visible(&owner)})));
        }
        if attempt == 9 || !young(&hub, &session) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(Json(json!({"tools":[]})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ToolCall {
    name: String,
    #[serde(default)]
    arguments: Value,
}
pub(super) async fn call(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(req): Json<ToolCall>) -> Result<Json<Value>> {
    let session = session_principal(&hub, &h)?;
    let (id, owner) = owner_of(&hub, &session)?.ok_or_else(|| Error(StatusCode::NOT_FOUND, "no extension tools for this session".into()))?;
    if !hub.ext.tools.visible(&owner).iter().any(|t| t.name == req.name) {
        return Err(Error(StatusCode::NOT_FOUND, format!("unknown tool {}", req.name)));
    }
    let tools = &hub.ext.tools;
    let call_id = uuid::Uuid::new_v4().to_string();
    let (send, receive) = tokio::sync::oneshot::channel();
    {
        let mut queues = tools.queues.lock();
        let queue = queues.entry(owner.extension.clone()).or_default();
        if queue.len() >= MAX_QUEUED {
            return Err(Error(StatusCode::SERVICE_UNAVAILABLE, "the extension is not answering tool calls".into()));
        }
        tools.waiting.lock().insert(call_id.clone(), (owner.extension.clone(), send));
        queue.push_back(Pending {
            id: call_id.clone(),
            name: req.name,
            arguments: req.arguments,
            session: json!({"id":id,"labels":owner.labels,"meta":owner.meta,"parent":owner.parent}),
        });
    }
    tools.queued.notify_waiters();
    let outcome = tokio::time::timeout(CALL_TIMEOUT, receive).await;
    tools.waiting.lock().remove(&call_id);
    match outcome {
        Ok(Ok(result)) => Ok(Json(result)),
        Ok(Err(_)) => Err(Error(StatusCode::SERVICE_UNAVAILABLE, "the extension stopped before answering".into())),
        Err(_) => Err(Error(StatusCode::GATEWAY_TIMEOUT, "the extension did not answer in time".into())),
    }
}

#[derive(Deserialize)]
pub(super) struct NextQuery {
    #[serde(default)]
    wait: u64,
}
/// Extension side: take queued calls, waiting up to `wait` seconds.
pub(super) async fn next(State(hub): State<Arc<Hub>>, h: HeaderMap, Query(q): Query<NextQuery>) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("tools.provide")?;
    let tools = &hub.ext.tools;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(q.wait).min(MAX_WAIT);
    loop {
        let queued = tools.queued.notified();
        tokio::pin!(queued);
        queued.as_mut().enable();
        let calls: Vec<Value> = tools
            .queues
            .lock()
            .get_mut(&caller.extension)
            .map(|queue| queue.drain(..).map(|p| json!({"id":p.id,"name":p.name,"arguments":p.arguments,"session":p.session})).collect())
            .unwrap_or_default();
        let now = tokio::time::Instant::now();
        if !calls.is_empty() || now >= deadline || hub.ext.stopped.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(Json(json!({"calls":calls})));
        }
        tokio::select! {
            _ = queued => {}
            _ = tokio::time::sleep_until(deadline) => {}
            _ = hub.ext.wake.notified() => {}
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ToolResult {
    #[serde(default)]
    content: Value,
    #[serde(default)]
    is_error: bool,
}
pub(super) async fn result(State(hub): State<Arc<Hub>>, h: HeaderMap, Path(id): Path<String>, Json(req): Json<ToolResult>) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("tools.provide")?;
    let waiting = hub.ext.tools.waiting.lock().remove(&id);
    let Some((owner, send)) = waiting else { return Err(Error(StatusCode::NOT_FOUND, "unknown or expired tool call".into())) };
    if owner != caller.extension {
        // Not theirs: put it back untouched.
        hub.ext.tools.waiting.lock().insert(id, (owner, send));
        return Err(Error(StatusCode::NOT_FOUND, "unknown or expired tool call".into()));
    }
    let text = match req.content {
        Value::String(text) => text,
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let _ = send.send(json!({"text":text.chars().take(64_000).collect::<String>(),"is_error":req.is_error}));
    Ok(Json(json!({"ok":true})))
}
