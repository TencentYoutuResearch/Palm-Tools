//! Mobile REST surface and event stream.
//!
//! Paths and bodies match `kode-sync-server` so the phone reuses one client;
//! the target desktop comes from `X-Kode-Device` (or `?device_id=` for the
//! WebSocket) and is resolved only inside the caller's tenant. Unknown and
//! foreign devices are indistinguishable 404s.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{SinkExt, StreamExt};
use kode_relay_protocol::{CloudEnvelope, ServerFrame};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    device_from_headers, idempotency_key, now_ms, tenant::CommandReceipt, valid_device_id,
    ApiError, Caller, RelayState, MAX_TEXT_BYTES,
};

pub(crate) const SCOPES: [&str; 3] = ["sessions.read", "sessions.content.read", "sessions.send"];

/// Extends the viewing lease for one desktop and, if that turned streaming
/// on, waits briefly for the desktop's fresh snapshot.
pub(crate) async fn touch(
    state: &RelayState,
    caller: &Caller,
    device_id: &str,
) -> Result<(), ApiError> {
    let lease = state.timings().viewer_lease.as_millis() as u64;
    let waiter = {
        let mut tenant = caller.tenant.lock();
        let device = tenant
            .devices
            .get_mut(device_id)
            .ok_or_else(|| ApiError::NotFound("device".into()))?;
        let now = now_ms();
        device.lease_until_ms = device.lease_until_ms.max(now + lease);
        let waiter = device.snapshots.subscribe();
        device.apply_stream_gate(now).then_some(waiter)
    };
    if let Some(mut waiter) = waiter {
        let _ = tokio::time::timeout(state.timings().snapshot_wait, waiter.changed()).await;
    }
    Ok(())
}

pub(crate) async fn devices(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let tenant = caller.tenant.lock();
    let mut devices: Vec<Value> = tenant
        .devices
        .iter()
        .map(|(id, device)| {
            json!({
                "device_id": id,
                "name": device.name,
                "online": device.agent.is_some(),
                "last_seen_at": device.last_seen_ms,
            })
        })
        .collect();
    devices.sort_by(|a, b| {
        (b["online"].as_bool(), a["name"].as_str())
            .cmp(&(a["online"].as_bool(), b["name"].as_str()))
    });
    Ok(Json(json!({ "devices": devices })))
}

pub(crate) async fn forget(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    state.authenticate(&headers).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn list_sessions(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let device_id = device_from_headers(&headers)?;
    touch(&state, &caller, &device_id).await?;
    let tenant = caller.tenant.lock();
    let device = tenant
        .devices
        .get(&device_id)
        .ok_or_else(|| ApiError::NotFound("device".into()))?;
    Ok(Json(json!({ "sessions": device.sessions.live_dtos() })))
}

pub(crate) async fn get_session(
    State(state): State<RelayState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = state.authenticate(&headers).await?;
    let device_id = device_from_headers(&headers)?;
    touch(&state, &caller, &device_id).await?;
    session_dto(&caller, &device_id, session_id).map(Json)
}

fn session_dto(caller: &Caller, device_id: &str, session_id: i64) -> Result<Value, ApiError> {
    let tenant = caller.tenant.lock();
    tenant
        .devices
        .get(device_id)
        .and_then(|device| device.sessions.live(session_id))
        .map(|entry| entry.dto.clone())
        .ok_or_else(|| ApiError::NotFound(format!("session {session_id}")))
}

#[derive(Deserialize)]
pub(crate) struct InputReq {
    text: String,
}

pub(crate) async fn post_input(
    State(state): State<RelayState>,
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
    dispatch(
        &state,
        session_id,
        &headers,
        "input",
        json!({"text": req.text}),
    )
    .await
}

pub(crate) async fn post_interrupt(
    State(state): State<RelayState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(&state, session_id, &headers, "interrupt", json!({})).await
}

pub(crate) async fn delete_session(
    State(state): State<RelayState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    dispatch(&state, session_id, &headers, "delete", json!({})).await
}

pub(crate) async fn post_answer(
    State(state): State<RelayState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if payload.get("response").is_some() {
        if payload["request_id"].as_str().is_none() || !payload["response"].is_object() {
            return Err(ApiError::BadRequest(
                "request_id and structured response are required".into(),
            ));
        }
    } else {
        let choice = payload
            .get("choice_index")
            .and_then(Value::as_u64)
            .ok_or_else(|| ApiError::BadRequest("choice_index is required".into()))?;
        if choice > 8 {
            return Err(ApiError::BadRequest(
                "choice_index must be between 0 and 8".into(),
            ));
        }
    }
    dispatch(&state, session_id, &headers, "answer", payload).await
}

pub(crate) async fn post_plan_response(
    State(state): State<RelayState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if payload.get("accept").and_then(Value::as_bool).is_none() {
        return Err(ApiError::BadRequest("accept is required".into()));
    }
    dispatch(&state, session_id, &headers, "plan_response", payload).await
}

pub(crate) async fn post_model(
    State(state): State<RelayState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("model is required".into()))?;
    if model.is_empty()
        || model.len() > 200
        || !model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:/[]".contains(&c))
    {
        return Err(ApiError::BadRequest("invalid model id".into()));
    }
    dispatch(&state, session_id, &headers, "model", payload).await
}

pub(crate) async fn post_mode(
    State(state): State<RelayState>,
    Path(session_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mode = payload
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("mode is required".into()))?
        .to_string();
    {
        // Runtime presets are deployment-defined; validate against the
        // session snapshot instead of translating policies.
        let caller = state.authenticate(&headers).await?;
        let device_id = device_from_headers(&headers)?;
        touch(&state, &caller, &device_id).await?;
        let dto = session_dto(&caller, &device_id, session_id)?;
        let supported = match dto["permission_modes"].as_array() {
            Some(options) => options
                .iter()
                .any(|option| option["id"].as_str() == Some(&mode)),
            None => matches!(
                mode.as_str(),
                "default" | "acceptEdits" | "bypassPermissions" | "plan"
            ),
        };
        if !supported {
            return Err(ApiError::BadRequest(
                "unsupported mode on this runtime".into(),
            ));
        }
    }
    let (status, Json(mut response)) =
        dispatch(&state, session_id, &headers, "mode", payload).await?;
    response["mode"] = json!(mode);
    Ok((status, Json(response)))
}

async fn dispatch(
    state: &RelayState,
    session_id: i64,
    headers: &HeaderMap,
    kind: &str,
    payload: Value,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let caller = state.authenticate(headers).await?;
    let device_id = device_from_headers(headers)?;
    touch(state, &caller, &device_id).await?;
    let key = idempotency_key(headers).unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();
    let mut tenant = caller.tenant.lock();
    let device = tenant
        .devices
        .get_mut(&device_id)
        .ok_or_else(|| ApiError::NotFound("device".into()))?;
    if let Some(existing) = device.command_keys.get(&key).and_then(|id| {
        device
            .commands
            .get(id)
            .map(|receipt| (id.clone(), receipt.status.clone()))
    }) {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "command_id": existing.0, "status": existing.1, "deduplicated": true })),
        ));
    }
    let agent = device
        .agent
        .clone()
        .ok_or_else(|| ApiError::Conflict("desktop is offline; message was not queued".into()))?;
    let local_session_id = device
        .sessions
        .live(session_id)
        .map(|entry| entry.local_id)
        .ok_or_else(|| ApiError::NotFound(format!("session {session_id}")))?;
    let command_id = format!("cmd_{}", Uuid::new_v4().simple());
    let expires_at = now + state.timings().command_ttl.as_millis() as u64;
    let frame = ServerFrame::Command {
        command_id: command_id.clone(),
        local_session_id,
        kind: kind.into(),
        payload: payload.clone(),
        expires_at,
    };
    if agent.tx.send(frame).is_err() {
        return Err(ApiError::Conflict(
            "desktop disconnected; message was not queued".into(),
        ));
    }
    let envelope = CloudEnvelope::new(
        session_id,
        "command.status",
        json!({ "command_id": command_id, "status": "dispatched", "error": null }),
        now,
    );
    device.commands.insert(
        command_id.clone(),
        CommandReceipt {
            cloud_session_id: session_id,
            local_session_id,
            kind: kind.into(),
            payload,
            status: "dispatched".into(),
            expires_at,
            updated_ms: now,
            envelope: envelope.clone(),
        },
    );
    device.command_keys.insert(key, command_id.clone());
    device.publish(envelope);
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "command_id": command_id, "status": "dispatched", "expires_at": expires_at })),
    ))
}

#[derive(Deserialize)]
pub(crate) struct WsQuery {
    device_id: String,
}

pub(crate) async fn ws_upgrade(
    State(state): State<RelayState>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let caller = state.authenticate(&headers).await?;
    if !valid_device_id(&query.device_id)
        || !caller.tenant.lock().devices.contains_key(&query.device_id)
    {
        return Err(ApiError::NotFound("device".into()));
    }
    let device_id = query.device_id;
    Ok(ws
        .on_upgrade(move |socket| mobile_socket(socket, state, caller, device_id))
        .into_response())
}

async fn mobile_socket(socket: WebSocket, state: RelayState, caller: Caller, device_id: String) {
    // Subscribe before opening the gate so the desktop's snapshot is not missed.
    let (mut events, online) = {
        let mut tenant = caller.tenant.lock();
        let Some(device) = tenant.devices.get_mut(&device_id) else {
            return;
        };
        let events = device.bus.subscribe();
        device.ws_viewers += 1;
        device.apply_stream_gate(now_ms());
        (events, device.agent.is_some())
    };
    let (mut sink, mut source) = socket.split();
    let hello = CloudEnvelope::new(
        0,
        "connection.hello",
        json!({
            "server_kind": "kode-relay",
            "device_id": device_id,
            "scopes": SCOPES,
            "desktop_online": online,
        }),
        now_ms(),
    );
    let mut alive = match serde_json::to_string(&hello) {
        Ok(raw) => sink.send(Message::Text(raw)).await.is_ok(),
        Err(_) => false,
    };
    let mut reverify = tokio::time::interval(state.timings().reverify_interval);
    reverify.tick().await;
    while alive {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    let Ok(raw) = serde_json::to_string(&event) else { continue; };
                    alive = sink.send(Message::Text(raw)).await.is_ok();
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => alive = false,
            },
            inbound = source.next() => {
                let Some(Ok(inbound)) = inbound else { break; };
                match inbound {
                    Message::Text(raw) if raw.contains("\"type\":\"ping\"") => {
                        let pong = CloudEnvelope::new(0, "pong", json!({}), now_ms());
                        if let Ok(raw) = serde_json::to_string(&pong) {
                            let _ = sink.send(Message::Text(raw)).await;
                        }
                    }
                    Message::Ping(value) => { let _ = sink.send(Message::Pong(value)).await; }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            _ = reverify.tick() => {
                if matches!(state.verify(&caller.token).await, Err(ApiError::Unauthorized)) {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }
    let lease = state.timings().viewer_lease.as_millis() as u64;
    let mut tenant = caller.tenant.lock();
    if let Some(device) = tenant.devices.get_mut(&device_id) {
        device.ws_viewers = device.ws_viewers.saturating_sub(1);
        // Brief app switches should not stop and restart the desktop stream.
        device.lease_until_ms = device.lease_until_ms.max(now_ms() + lease);
    }
}
