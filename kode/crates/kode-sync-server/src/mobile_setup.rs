//! Online desktop setup requests. Reads are ephemeral; creates keep a durable
//! idempotency receipt, including unknown outcomes. Never replay a create.
use super::*;
use tokio::sync::oneshot;

type Reply = (u16, Value);
pub(super) type Pending = HashMap<(String, String), oneshot::Sender<Reply>>;

pub(super) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS session_creates(
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES bindings(id),
    device_id TEXT NOT NULL REFERENCES devices(id),
    idempotency_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status_code INTEGER,
    response_json TEXT,
    UNIQUE(binding_id, idempotency_key)
);";

pub(super) async fn backends(
    axum::extract::State(state): axum::extract::State<ServerState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    dispatch(&state, &headers, "backends", json!({})).await
}

pub(super) async fn models(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    dispatch(&state, &headers, "models", json!({"backend_key":key})).await
}

#[derive(Deserialize)]
pub(super) struct DirectoryQuery {
    path: Option<String>,
    #[serde(default)]
    show_hidden: bool,
}

pub(super) async fn directories(
    axum::extract::State(state): axum::extract::State<ServerState>,
    Query(query): Query<DirectoryQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    dispatch(
        &state,
        &headers,
        "directories",
        json!({"path":query.path,"show_hidden":query.show_hidden}),
    )
    .await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateRequest {
    backend_key: String,
    cwd: Option<String>,
    model: Option<String>,
}

pub(super) async fn create(
    axum::extract::State(state): axum::extract::State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<CreateRequest>,
) -> Result<Response, ApiError> {
    if req.backend_key.trim().is_empty()
        || req.backend_key.len() > 256
        || req.cwd.as_ref().is_some_and(|v| v.len() > 4096)
        || req.model.as_ref().is_some_and(|v| v.len() > 256)
    {
        return Err(ApiError::BadRequest(
            "Invalid backend, path or model".into(),
        ));
    }
    dispatch(
        &state,
        &headers,
        "create_session",
        serde_json::to_value(req).unwrap(),
    )
    .await
}

fn response((status, body): Reply) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
        Json(body),
    )
        .into_response()
}

async fn dispatch(
    state: &ServerState,
    headers: &HeaderMap,
    kind: &str,
    payload: Value,
) -> Result<Response, ApiError> {
    let creating = kind == "create_session";
    let auth = mobile_auth_from_headers(
        state,
        headers,
        if creating {
            "sessions.send"
        } else {
            "sessions.content.read"
        },
    )?;
    let id = format!("setup_{}", Uuid::new_v4().simple());
    // Keep the desktop connection stable through insertion and dispatch.
    let agent = state.inner.agents.lock().get(&auth.device_id).cloned();
    if creating {
        let key = headers
            .get("Idempotency-Key")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.trim().is_empty() && v.len() <= 128)
            .ok_or_else(|| ApiError::BadRequest("Idempotency-Key is required".into()))?;
        let db = state.inner.db.lock();
        let existing = db.query_row(
            "SELECT payload_json, status_code, response_json FROM session_creates WHERE binding_id=?1 AND idempotency_key=?2",
            params![auth.binding_id, key], |row| Ok((row.get::<_,String>(0)?, row.get::<_,Option<u16>>(1)?, row.get::<_,Option<String>>(2)?)),
        ).optional()?;
        if let Some((original, status, body)) = existing {
            if original != payload.to_string() {
                return Err(ApiError::Conflict(
                    "A creation request cannot be changed when checking its result".into(),
                ));
            }
            return Ok(response(match (status, body) {
                (Some(status), Some(body)) => {
                    (status, serde_json::from_str(&body).unwrap_or(Value::Null))
                }
                _ => (
                    202,
                    json!({"error":"creation_unconfirmed","detail":"Creation is still pending or its result is unknown. Check again or inspect the session list before starting another session."}),
                ),
            }));
        }
        if agent.is_none() {
            return Err(ApiError::Conflict(
                "Desktop is offline; session was not created".into(),
            ));
        }
        db.execute("INSERT INTO session_creates(id,binding_id,device_id,idempotency_key,payload_json) VALUES(?1,?2,?3,?4,?5)",
            params![id, auth.binding_id, auth.device_id, key, payload.to_string()])?;
    }
    let agent = agent
        .ok_or_else(|| ApiError::Conflict("Desktop is offline; connect it and retry".into()))?;
    let (tx, rx) = oneshot::channel();
    let pending_key = (auth.device_id.clone(), id.clone());
    state
        .inner
        .setup_pending
        .lock()
        .insert(pending_key.clone(), tx);
    let guard = PendingGuard {
        state: state.clone(),
        key: pending_key,
    };
    let frame = ServerFrame::SetupRequest {
        request_id: id.clone(),
        kind: kind.into(),
        payload,
        expires_at: now_ms() + COMMAND_TTL_MS,
    };
    if agent.tx.send(frame).is_err() {
        let reply = (
            409,
            json!({"error":"desktop_offline","detail":"Desktop disconnected; request was not sent"}),
        );
        if creating {
            store_result(state, &auth.device_id, &id, &reply)?;
        }
        return Ok(response(reply));
    }
    let result = tokio::time::timeout(Duration::from_secs(50), rx).await;
    drop(guard);
    // Recheck revocation after the desktop read has completed.
    mobile_auth_from_headers(
        state,
        headers,
        if creating {
            "sessions.send"
        } else {
            "sessions.content.read"
        },
    )?;
    Ok(response(match result {
        Ok(Ok(reply)) => reply,
        _ => (
            504,
            json!({"error": if creating {"creation_unconfirmed"} else {"desktop_timeout"},
            "detail": if creating {"Creation result is unknown. Check again using the same request; do not create another session."}
                else {"Desktop did not respond. Update the desktop and sync server, then retry."}}),
        ),
    }))
}

struct PendingGuard {
    state: ServerState,
    key: (String, String),
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.state.inner.setup_pending.lock().remove(&self.key);
    }
}

fn store_result(
    state: &ServerState,
    device_id: &str,
    id: &str,
    reply: &Reply,
) -> Result<(), ApiError> {
    state.inner.db.lock().execute(
        "UPDATE session_creates SET status_code=?1,response_json=?2 WHERE id=?3 AND device_id=?4 AND status_code IS NULL",
        params![reply.0, reply.1.to_string(), id, device_id])?;
    Ok(())
}

pub(super) fn complete(
    state: &ServerState,
    device_id: &str,
    id: &str,
    boot_id: &str,
    status: u16,
    mut body: Value,
) -> Result<(), ApiError> {
    let is_create = state
        .inner
        .db
        .lock()
        .query_row(
            "SELECT 1 FROM session_creates WHERE id=?1 AND device_id=?2 AND status_code IS NULL",
            params![id, device_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if is_create && (200..300).contains(&status) {
        let local_id = body["id"]
            .as_u64()
            .ok_or_else(|| ApiError::BadRequest("Created session has no id".into()))?;
        let (cloud_id, created, dto) = {
            let mut db = state.inner.db.lock();
            let tx = db.transaction()?;
            let result = upsert_session_tx(&tx, device_id, boot_id, local_id, body)?;
            tx.commit()?;
            result
        };
        body = dto;
        state.publish(
            device_id,
            CloudEnvelope::new(
                cloud_id,
                if created {
                    "session.created"
                } else {
                    "session.updated"
                },
                body.clone(),
            ),
        );
    }
    let reply = (status, body);
    if is_create {
        store_result(state, device_id, id, &reply)?;
    }
    if let Some(tx) = state
        .inner
        .setup_pending
        .lock()
        .remove(&(device_id.into(), id.into()))
    {
        let _ = tx.send(reply);
    }
    Ok(())
}
