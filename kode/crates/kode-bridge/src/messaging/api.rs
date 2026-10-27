//! Administration uses the existing bridge bearer. Agent credentials are session-scoped.
use super::{model::*, Hub};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub(super) struct Error(pub(super) StatusCode, pub(super) String);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        tracing::debug!(error=%e,"messaging request rejected");
        Self(StatusCode::BAD_REQUEST, e.to_string())
    }
}
type Result<T> = std::result::Result<T, Error>;
#[derive(Clone)]
enum Principal {
    Admin,
    Session(String),
}
fn auth(hub: &Hub, headers: &HeaderMap) -> Result<Principal> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "unauthorized".into()))?;
    if hub
        .ctx
        .upgrade()
        .is_some_and(|ctx| crate::constant_eq(token, &ctx.token))
    {
        return Ok(Principal::Admin);
    }
    hub.store
        .principal(token)?
        .map(Principal::Session)
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "unauthorized".into()))
}
fn admin(hub: &Hub, h: &HeaderMap) -> Result<()> {
    match auth(hub, h)? {
        Principal::Admin => Ok(()),
        _ => Err(Error(
            StatusCode::FORBIDDEN,
            "administrator required".into(),
        )),
    }
}
fn owner(hub: &Hub, h: &HeaderMap, id: &str) -> Result<()> {
    match auth(hub, h)? {
        Principal::Admin => Ok(()),
        Principal::Session(s) if s == id => Ok(()),
        _ => Err(Error(StatusCode::FORBIDDEN, "foreign session".into())),
    }
}
pub(super) fn router(hub: Arc<Hub>) -> Router {
    Router::new()
        .route("/api/v1/messaging/node", get(node))
        .route("/api/v1/messaging/workbench/catalog", get(workbench_catalog))
        .route("/api/v1/messaging/workbench/agents", get(agent_catalog).post(change_agent))
        .route("/api/v1/messaging/workbench/sessions", get(workbench_sessions))
        .route("/api/v1/messaging/workbench/workspaces", get(workspaces).post(change_workspace))
        .route("/api/v1/messaging/workbench/workspaces/hosts", get(workspace_hosts))
        .route("/api/v1/messaging/workbench/transcript", post(workbench_transcript))
        .route("/api/v1/messaging/workbench/documents/:key", get(workbench_document).post(save_workbench_document))
        .route("/api/v1/messaging/self", get(own_session))
        .route(
            "/api/v1/messaging/native/:id/credential",
            post(native_credential),
        )
        .route("/api/v1/messaging/sessions", get(directory).post(register))
        .route("/api/v1/messaging/sessions/:id/heartbeat", post(heartbeat))
        .route("/api/v1/messaging/sessions/:id/title", post(update_title))
        .route("/api/v1/messaging/sessions/:id/offline", post(offline))
        .route("/api/v1/messaging/sessions/:id/claim", post(claim))
        .route("/api/v1/messaging/sessions/:id/pending", get(pending))
        .route("/api/v1/messaging/messages", post(send))
        .route("/api/v1/messaging/messages/:id", get(message).post(settle))
        .route("/api/v1/messaging/events", get(events))
        .route("/api/v1/messaging/link", get(super::link::upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(128 * 1024))
        .with_state(hub)
}
async fn node(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    auth(&hub, &h)?;
    Ok(Json(json!({"node_id":hub.node_id(),"protocol_version":1})))
}
fn document_key(key: &str) -> Result<()> {
    if !matches!(key, "agents" | "ssh-hosts" | "session-index" | "workspaces") {
        return Err(Error(StatusCode::BAD_REQUEST, "unknown workbench document".into()));
    }
    Ok(())
}
async fn workbench_document(State(hub): State<Arc<Hub>>, h: HeaderMap, Path(key): Path<String>) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?; document_key(&key)?;
    if key == "workspaces" {
        return Ok(Json(tokio::task::spawn_blocking(move || { let _gate = hub.gate.lock(); super::workspaces::ensure(&hub) }).await.map_err(anyhow::Error::from)??));
    }
    Ok(Json(hub.store.document(&key)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentUpdate { expected_revision: u64, value: serde_json::Value }
async fn save_workbench_document(State(hub): State<Arc<Hub>>, h: HeaderMap, Path(key): Path<String>, Json(update): Json<DocumentUpdate>) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?; document_key(&key)?;
    if key == "workspaces" { super::workspaces::validate(&update.value)?; }
    if key == "agents" {
        return Ok(Json(tokio::task::spawn_blocking(move || { let _gate=hub.gate.lock(); super::agents::save(&hub,update.expected_revision,update.value) }).await.map_err(anyhow::Error::from)??));
    }
    Ok(Json(hub.store.save_document(&key, update.expected_revision, update.value)?))
}
async fn agent_catalog(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<super::agents::Catalog>> {
    admin(&hub,&h)?;
    Ok(Json(tokio::task::spawn_blocking(move ||super::agents::catalog(&hub)).await.map_err(anyhow::Error::from)??))
}
async fn change_agent(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(command): Json<super::agents::Change>) -> Result<Json<super::agents::Catalog>> {
    admin(&hub,&h)?;
    Ok(Json(tokio::task::spawn_blocking(move || { let _gate=hub.gate.lock();super::agents::change(&hub,command) }).await.map_err(anyhow::Error::from)??))
}
#[derive(Deserialize)]
struct WorkspaceNode { node_id: Option<String> }
async fn workspaces(State(hub): State<Arc<Hub>>, h: HeaderMap, Query(query): Query<WorkspaceNode>) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(hub.workspace(query.node_id.as_deref().unwrap_or(""), super::workspaces::Command::List).await?))
}
#[derive(Deserialize)]
struct WorkspaceChange { node_id: Option<String>, #[serde(flatten)] command: super::workspaces::Command }
async fn change_workspace(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(input): Json<WorkspaceChange>) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(hub.workspace(input.node_id.as_deref().unwrap_or(""),input.command).await?))
}
async fn workspace_hosts(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(json!({"local_node_id":hub.node_id(),"hosts":hub.config.peers.iter().map(|peer| json!({"node_id":peer.node_id,"ssh_host":peer.ssh.as_ref().map(|ssh| &ssh.host)})).collect::<Vec<_>>()})))
}
async fn workbench_sessions(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(super::session_catalog::federated(hub).await?))
}
async fn workbench_catalog(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let state_path = std::env::var_os("KODE_GUI_STATE_PATH").map(std::path::PathBuf::from)
        .or_else(|| dirs::config_dir().map(|path| path.join("kode/state.json")));
    let mut state = match state_path {
        Some(path) => match tokio::fs::read(path).await {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|error| Error(StatusCode::INTERNAL_SERVER_ERROR, format!("cannot read Kode saved state: {error}")))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
            Err(error) => return Err(Error(StatusCode::INTERNAL_SERVER_ERROR, format!("cannot read Kode saved state: {error}"))),
        }, None => serde_json::json!({}),
    };
    let document = hub.store.document("session-index")?;
    if let Some(gui) = document.pointer("/value/gui").and_then(|value| value.as_object()) {
        if let Some(state) = state.as_object_mut() { for (key, value) in gui { state.insert(key.clone(), value.clone()); } }
    }
    let mut tabs=state["tabs"].as_array().cloned().unwrap_or_default();
    let mut offset=0;
    loop {
        let page=super::workspaces::execute(hub.clone(),super::workspaces::Command::SessionCatalog{offset}).await?;
        for tab in page["tabs"].as_array().into_iter().flatten() {
            if let Some(index)=tabs.iter().position(|row|(row["endpoint_id"].is_null() || row["endpoint_id"]["kind"]=="local") && row["session_id"]==tab["session_id"] && row["backend_key"]==tab["backend_key"]) {
                if let (Some(row),Some(native))=(tabs[index].as_object_mut(),tab.as_object()){row.extend(native.clone());}
            } else {tabs.push(tab.clone());}
        }
        if let Some(next)=page["next_offset"].as_u64(){offset=next as usize}else{break}
    }
    let workspace_document=hub.store.document("workspaces")?;
    let archived=workspace_document.pointer("/value/global/archivedSessionIds").and_then(serde_json::Value::as_array);
    tabs.retain(|tab| {
        if !tab["endpoint_id"].is_null() && tab["endpoint_id"]["kind"]!="local" {return true}
        let native=document.pointer("/value/native_sessions").and_then(serde_json::Value::as_array).and_then(|rows|rows.iter().find(|row|row["session_id"]==tab["session_id"] && row["backend_key"]==tab["backend_key"]));
        let id=tab["dsh_session_id"].as_str().or_else(||native.and_then(|row|row["dsh_session_id"].as_str()));
        !id.is_some_and(|id|archived.is_some_and(|rows|rows.iter().any(|row|row.as_str()==Some(id))))
    });
    let agents = super::agents::catalog(&hub)?;
    let backends = serde_json::to_value(&agents.backends).map_err(anyhow::Error::from)?;
    Ok(Json(serde_json::json!({"node_id":hub.node_id(),"tabs":tabs,"endpoints":state.get("endpoints").cloned().unwrap_or(serde_json::json!([])),"session_titles":state.get("session_titles").cloned().unwrap_or(serde_json::json!({})),"backends":backends,"agent_ids":agents.ids})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedTranscript { backend_key: String, session_id: String, cwd: String, limit: Option<usize>, tail_bytes: Option<usize>, before: Option<i64> }
async fn workbench_transcript(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(input): Json<SavedTranscript>) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    if !valid_id(&input.session_id) || !std::path::Path::new(&input.cwd).is_absolute() { return Err(Error(StatusCode::BAD_REQUEST, "invalid saved session".into())); }
    let catalog=super::agents::catalog(&hub)?;
    let protocol=catalog.backends.get(&input.backend_key).map(|config|config.protocol_key(&input.backend_key)).unwrap_or(&input.backend_key);
    let backend = kode_core::session::jsonl_tail::Backend::from_backend_key(protocol).ok_or_else(|| Error(StatusCode::BAD_REQUEST, "unsupported transcript format".into()))?;
    let messages = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let Some(path) = kode_core::session::jsonl_tail::resolve_session_path(backend, std::path::Path::new(&input.cwd), &input.session_id) else { return Ok(json!({"messages":[],"available":false})); };
        super::transcript::recent_before(&path,input.limit.unwrap_or(80).clamp(1,1000),input.tail_bytes.unwrap_or(8*1024*1024).clamp(4096,64*1024*1024),input.before)
    }).await.map_err(anyhow::Error::from)??;
    Ok(Json(messages))
}
async fn own_session(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    let Principal::Session(id) = auth(&hub, &h)? else {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "session credential required".into(),
        ));
    };
    Ok(Json(
        json!({"address":Address{node_id:hub.node_id().into(),session_id:id}}),
    ))
}
async fn native_credential(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<u64>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let live = hub
        .ctx
        .upgrade()
        .is_some_and(|ctx| ctx.sessions.lock().contains_key(&id));
    if !live {
        return Err(Error(
            StatusCode::NOT_FOUND,
            "unknown native session".into(),
        ));
    }
    let session = hub
        .native
        .lock()
        .iter()
        .find(|(_, runtime_id)| **runtime_id == id)
        .map(|(session, _)| session.clone())
        .ok_or_else(|| {
            Error(
                StatusCode::NOT_FOUND,
                "native session is not registered yet".into(),
            )
        })?;
    let token = hub
        .store
        .db_token(&session)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown native session".into()))?;
    Ok(Json(
        json!({"address":Address{node_id:hub.node_id().into(),session_id:session},"token":token}),
    ))
}
async fn directory(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    auth(&hub, &h)?;
    Ok(Json(json!({"sessions":hub.directory()?})))
}
async fn register(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Registration>> {
    admin(&hub, &h)?;
    if req.session_id.starts_with("kode:") || !matches!(req.runtime.as_str(), "dsh" | "external") {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "reserved runtime or session id".into(),
        ));
    }
    let _guard = hub.gate.lock();
    let id = req.session_id.clone();
    let registration = hub.store.register(req)?;
    // A new activation fences the previous token. Claimed external work is never replayed.
    for mut m in hub.store.messages()? {
        if m.target.node_id == hub.node_id()
            && m.target.session_id == id
            && m.status == Status::Delivering
        {
            m.status = Status::Uncertain;
            m.detail = Some("runtime owner replaced during submission".into());
            hub.store.save(&m)?;
        }
    }
    Ok(Json(registration))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TitleRequest {
    title: String,
}
async fn update_title(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<TitleRequest>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    hub.store.update_title(&id, &req.title)?;
    Ok(Json(json!({"ok":true})))
}
async fn heartbeat(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    hub.store.heartbeat(&id)?;
    Ok(Json(json!({"ok":true})))
}
async fn offline(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    hub.store.offline(&id)?;
    Ok(Json(json!({"ok":true})))
}
async fn claim(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    if hub.native.lock().contains_key(&id) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "native runtime owns this inbox".into(),
        ));
    }
    Ok(Json(json!({"messages":hub.claim(&id)?})))
}
async fn pending(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    Ok(Json(json!({"pending":hub.store.pending_count(&id)?})))
}
async fn send(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(req): Json<SendRequest>,
) -> Result<Json<Message>> {
    let source = match auth(&hub, &h)? {
        Principal::Admin => req
            .source
            .clone()
            .ok_or_else(|| Error(StatusCode::BAD_REQUEST, "source required".into()))?,
        Principal::Session(id) => {
            if req.source.as_ref().is_some_and(|s| s != &id) {
                return Err(Error(
                    StatusCode::FORBIDDEN,
                    "cannot impersonate another session".into(),
                ));
            }
            id
        }
    };
    Ok(Json(hub.send(&source, req)?))
}
async fn message(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Message>> {
    let p = auth(&hub, &h)?;
    let m = hub
        .store
        .get(&id)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown message".into()))?;
    if let Principal::Session(s) = p {
        if !((m.source.node_id == hub.node_id() && m.source.session_id == s)
            || (m.target.node_id == hub.node_id() && m.target.session_id == s))
        {
            return Err(Error(StatusCode::FORBIDDEN, "foreign message".into()));
        }
    }
    Ok(Json(m))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settlement {
    session_id: String,
    status: Status,
    detail: Option<String>,
}
async fn settle(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<Settlement>,
) -> Result<Json<Message>> {
    owner(&hub, &h, &req.session_id)?;
    Ok(Json(hub.settle(
        &req.session_id,
        &id,
        req.status,
        req.detail,
    )?))
}
#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    after: u64,
}
async fn events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    let session = match auth(&hub, &h)? {
        Principal::Admin => None,
        Principal::Session(s) => Some(s),
    };
    let events = hub.store.events(q.after, session.as_deref())?;
    let cursor = events.last().map_or(q.after, |e| e.seq);
    Ok(Json(json!({"events":events,"cursor":cursor})))
}
