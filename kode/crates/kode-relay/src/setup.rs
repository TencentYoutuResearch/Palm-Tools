//! Requests answered by the online desktop: backend/model/directory pickers,
//! session creation, and history. The relay stores no history; every page is
//! read from the desktop and merged with recent command receipts, which the
//! phone waits on through `/history`.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use kode_relay_protocol::{ServerFrame, SETUP_KIND_HISTORY};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::{
    device_from_headers, idempotency_key,
    mobile::touch,
    now_ms,
    tenant::{CreateReceipt, Device, Reply},
    ApiError, Caller, RelayState,
};

pub(crate) async fn backends(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (caller, device_id) = open(&state, &headers).await?;
    Ok(response(
        request(&state, &caller, &device_id, "backends", json!({})).await?,
    ))
}

pub(crate) async fn models(
    State(state): State<RelayState>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (caller, device_id) = open(&state, &headers).await?;
    let payload = json!({ "backend_key": key });
    Ok(response(
        request(&state, &caller, &device_id, "models", payload).await?,
    ))
}

#[derive(Deserialize)]
pub(crate) struct DirectoryQuery {
    path: Option<String>,
    #[serde(default)]
    show_hidden: bool,
}

pub(crate) async fn directories(
    State(state): State<RelayState>,
    Query(query): Query<DirectoryQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (caller, device_id) = open(&state, &headers).await?;
    let payload = json!({ "path": query.path, "show_hidden": query.show_hidden });
    Ok(response(
        request(&state, &caller, &device_id, "directories", payload).await?,
    ))
}

#[derive(Deserialize)]
pub(crate) struct HistoryQuery {
    from: Option<u64>,
    limit: Option<usize>,
}

pub(crate) async fn history(
    State(state): State<RelayState>,
    Path(session_id): Path<i64>,
    Query(query): Query<HistoryQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (caller, device_id) = open(&state, &headers).await?;
    let local_session_id = {
        let tenant = caller.tenant.lock();
        tenant
            .devices
            .get(&device_id)
            .and_then(|device| device.sessions.live(session_id))
            .map(|entry| entry.local_id)
            .ok_or_else(|| ApiError::NotFound(format!("session {session_id}")))?
    };
    let from = query.from.unwrap_or(0);
    let limit = query.limit.unwrap_or(1000).clamp(1, 2000);
    let payload = json!({ "local_session_id": local_session_id, "from": from, "limit": limit });
    let (status, body) = request(&state, &caller, &device_id, SETUP_KIND_HISTORY, payload).await?;
    if !(200..300).contains(&status) {
        return Ok(response((status, body)));
    }
    let raw = body["events"].as_array().cloned().unwrap_or_default();
    let tenant = caller.tenant.lock();
    let device = tenant
        .devices
        .get(&device_id)
        .ok_or_else(|| ApiError::NotFound("device".into()))?;
    let mut events = device.sessions.translate_history(session_id, &raw);
    events.extend(
        device
            .commands
            .values()
            .filter(|receipt| receipt.cloud_session_id == session_id && receipt.envelope.ts >= from)
            .map(|receipt| receipt.envelope.clone()),
    );
    events.sort_by_key(|event| event.ts);
    Ok(Json(json!({ "events": events })).into_response())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateRequest {
    backend_key: String,
    cwd: Option<String>,
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
}

pub(crate) async fn create(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(req): Json<CreateRequest>,
) -> Result<Response, ApiError> {
    if req.backend_key.trim().is_empty()
        || req.backend_key.len() > 256
        || req.cwd.as_ref().is_some_and(|v| v.len() > 4096)
        || req.model.as_ref().is_some_and(|v| v.len() > 256)
        || req.permission_mode.as_deref().is_some_and(|v| {
            !matches!(
                v,
                "default" | "acceptEdits" | "plan" | "bypass" | "bypassPermissions"
            )
        })
    {
        return Err(ApiError::BadRequest(
            "Invalid backend, path, model or permission mode".into(),
        ));
    }
    let key = idempotency_key(&headers)
        .ok_or_else(|| ApiError::BadRequest("Idempotency-Key is required".into()))?;
    let (caller, device_id) = open(&state, &headers).await?;
    let payload = serde_json::to_value(&req).unwrap_or(Value::Null);
    let payload_text = payload.to_string();
    let request_id = format!("setup_{}", Uuid::new_v4().simple());
    {
        let mut tenant = caller.tenant.lock();
        let device = tenant
            .devices
            .get_mut(&device_id)
            .ok_or_else(|| ApiError::NotFound("device".into()))?;
        if let Some(existing) = device.creates.get(&key) {
            if existing.payload != payload_text {
                return Err(ApiError::Conflict(
                    "A creation request cannot be changed when checking its result".into(),
                ));
            }
            return Ok(response(existing.result.clone().unwrap_or_else(|| (
                202,
                json!({"error":"creation_unconfirmed","detail":"Creation is still pending or its result is unknown. Check again or inspect the session list before starting another session."}),
            ))));
        }
        if device.agent.is_none() {
            return Err(ApiError::Conflict(
                "Desktop is offline; session was not created".into(),
            ));
        }
        device.creates.insert(
            key.clone(),
            CreateReceipt {
                request_id: request_id.clone(),
                payload: payload_text,
                result: None,
                created_ms: now_ms(),
            },
        );
    }
    let reply = send(
        &state,
        &caller,
        &device_id,
        &request_id,
        "create_session",
        payload,
    )
    .await?;
    let reply = match reply {
        Some(reply) => reply,
        None => (
            504,
            json!({"error":"creation_unconfirmed","detail":"Creation result is unknown. Check again using the same request; do not create another session."}),
        ),
    };
    Ok(response(reply))
}

async fn open(state: &RelayState, headers: &HeaderMap) -> Result<(Caller, String), ApiError> {
    let caller = state.authenticate(headers).await?;
    let device_id = device_from_headers(headers)?;
    touch(state, &caller, &device_id).await?;
    Ok((caller, device_id))
}

/// Read-only desktop request; a missing reply becomes 504.
async fn request(
    state: &RelayState,
    caller: &Caller,
    device_id: &str,
    kind: &str,
    payload: Value,
) -> Result<Reply, ApiError> {
    let request_id = format!("setup_{}", Uuid::new_v4().simple());
    Ok(send(state, caller, device_id, &request_id, kind, payload)
        .await?
        .unwrap_or_else(|| {
            (
                504,
                json!({"error":"desktop_timeout","detail":"Desktop did not respond. Update the desktop app, then retry."}),
            )
        }))
}

async fn send(
    state: &RelayState,
    caller: &Caller,
    device_id: &str,
    request_id: &str,
    kind: &str,
    payload: Value,
) -> Result<Option<Reply>, ApiError> {
    let (tx, rx) = oneshot::channel();
    {
        let mut tenant = caller.tenant.lock();
        let device = tenant
            .devices
            .get_mut(device_id)
            .ok_or_else(|| ApiError::NotFound("device".into()))?;
        let agent = device
            .agent
            .clone()
            .ok_or_else(|| ApiError::Conflict("Desktop is offline; connect it and retry".into()))?;
        device.setup_pending.insert(request_id.to_string(), tx);
        let frame = ServerFrame::SetupRequest {
            request_id: request_id.to_string(),
            kind: kind.into(),
            payload,
            expires_at: now_ms() + state.timings().command_ttl.as_millis() as u64,
        };
        if agent.tx.send(frame).is_err() {
            device.setup_pending.remove(request_id);
            return Ok(Some((
                409,
                json!({"error":"desktop_offline","detail":"Desktop disconnected; request was not sent"}),
            )));
        }
    }
    let result = tokio::time::timeout(state.timings().setup_timeout, rx).await;
    if let Some(device) = caller.tenant.lock().devices.get_mut(device_id) {
        device.setup_pending.remove(request_id);
    }
    Ok(match result {
        Ok(Ok(reply)) => Some(reply),
        _ => None,
    })
}

/// Applies a desktop's setup reply. Created sessions join the index under the
/// replying boot so later events and commands resolve to the same phone id.
pub(crate) fn complete(
    device: &mut Device,
    request_id: &str,
    boot_id: &str,
    status: u16,
    mut body: Value,
    now: u64,
) {
    let create_key = device
        .creates
        .iter()
        .find(|(_, receipt)| receipt.request_id == request_id && receipt.result.is_none())
        .map(|(key, _)| key.clone());
    if let Some(key) = &create_key {
        if (200..300).contains(&status) {
            if let Some(local_id) = body["id"].as_u64() {
                let (cloud_id, created) = device.sessions.upsert(boot_id, local_id, body);
                body = device
                    .sessions
                    .live(cloud_id)
                    .map(|entry| entry.dto.clone())
                    .unwrap_or(Value::Null);
                let kind = if created {
                    "session.created"
                } else {
                    "session.updated"
                };
                device.publish(kode_relay_protocol::CloudEnvelope::new(
                    cloud_id,
                    kind,
                    body.clone(),
                    now,
                ));
            }
        }
        if let Some(receipt) = device.creates.get_mut(key) {
            receipt.result = Some((status, body.clone()));
        }
    }
    if let Some(tx) = device.setup_pending.remove(request_id) {
        let _ = tx.send((status, body));
    }
}

fn response((status, body): Reply) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
        Json(body),
    )
        .into_response()
}
