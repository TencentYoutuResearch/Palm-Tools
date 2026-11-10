//! Desktop agent WebSocket.
//!
//! A desktop connects with its owner's access token; the token's `sub` picks
//! the tenant and `device_id` names the desktop inside it. The relay tells the
//! agent whether anyone is watching through the existing `sync_enabled` gate,
//! so desktops upload nothing while no phone has the device open.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use kode_relay_protocol::{AgentFrame, CloudEnvelope, ServerFrame};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    now_ms, setup,
    tenant::{AgentConn, Device},
    valid_device_id, ApiError, Caller, RelayState,
};

#[derive(Deserialize)]
pub(crate) struct AgentQuery {
    device_id: String,
    name: Option<String>,
}

pub(crate) async fn upgrade(
    State(state): State<RelayState>,
    Query(query): Query<AgentQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let caller = state.authenticate(&headers).await?;
    if !valid_device_id(&query.device_id) {
        return Err(ApiError::BadRequest("invalid device_id".into()));
    }
    let name = query
        .name
        .map(|name| name.trim().chars().take(80).collect::<String>())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Kode Desktop".into());
    if caller
        .tenant
        .lock()
        .devices
        .get(&query.device_id)
        .is_some_and(|device| device.agent.is_some())
    {
        return Err(ApiError::Conflict(
            "another desktop process is already connected for this device".into(),
        ));
    }
    let device_id = query.device_id;
    Ok(ws
        .on_upgrade(move |socket| run(socket, state, caller, device_id, name))
        .into_response())
}

async fn run(
    socket: WebSocket,
    state: RelayState,
    caller: Caller,
    device_id: String,
    name: String,
) {
    let connection_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerFrame>();
    {
        let now = now_ms();
        let mut tenant = caller.tenant.lock();
        let device = tenant
            .devices
            .entry(device_id.clone())
            .or_insert_with(|| Device::new(name.clone(), now));
        if device.agent.is_some() {
            return;
        }
        device.name = name;
        device.last_seen_ms = now;
        device.agent = Some(AgentConn {
            connection_id: connection_id.clone(),
            tx: tx.clone(),
        });
        device.boot_id = None;
        device.sync_enabled = device.wants_stream(now);
        let _ = tx.send(ServerFrame::Hello {
            sync_enabled: device.sync_enabled,
            binding_count: device.ws_viewers as u64,
        });
        // Commands dispatched while the socket was reconnecting are still
        // live; the agent deduplicates by command id.
        for (command_id, receipt) in &device.commands {
            if receipt.status == "dispatched" && receipt.expires_at >= now {
                let _ = tx.send(ServerFrame::Command {
                    command_id: command_id.clone(),
                    local_session_id: receipt.local_session_id,
                    kind: receipt.kind.clone(),
                    payload: receipt.payload.clone(),
                    expires_at: receipt.expires_at,
                });
            }
        }
    }
    tracing::info!(user = %caller.user_id, %device_id, "desktop agent connected");

    let (mut sink, mut source) = socket.split();
    let mut reverify = tokio::time::interval(state.timings().reverify_interval);
    reverify.tick().await;
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
                        Ok(frame) => handle_frame(&caller, &device_id, frame, &tx),
                        Err(error) => tracing::warn!(%device_id, %error, "invalid agent frame"),
                    },
                    Message::Ping(value) => { let _ = sink.send(Message::Pong(value)).await; }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            _ = reverify.tick() => {
                // An expired or revoked token ends the session; the desktop
                // reconnects with a refreshed one.
                if matches!(state.verify(&caller.token).await, Err(ApiError::Unauthorized)) {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }

    let mut tenant = caller.tenant.lock();
    if let Some(device) = tenant.devices.get_mut(&device_id) {
        if device
            .agent
            .as_ref()
            .is_some_and(|agent| agent.connection_id == connection_id)
        {
            device.agent = None;
            device.sync_enabled = false;
            device.last_seen_ms = now_ms();
            // Waiters learn the desktop is gone instead of timing out.
            device.setup_pending.clear();
        }
    }
    tracing::info!(user = %caller.user_id, %device_id, "desktop agent disconnected");
}

fn handle_frame(
    caller: &Caller,
    device_id: &str,
    frame: AgentFrame,
    tx: &mpsc::UnboundedSender<ServerFrame>,
) {
    let now = now_ms();
    let mut tenant = caller.tenant.lock();
    let Some(device) = tenant.devices.get_mut(device_id) else {
        return;
    };
    device.last_seen_ms = now;
    match frame {
        AgentFrame::Hello { boot_id, sessions } => {
            device.boot_id = Some(boot_id.clone());
            if !device.sync_enabled {
                return;
            }
            for envelope in device.sessions.apply_snapshot(&boot_id, sessions, now) {
                device.publish(envelope);
            }
            device.snapshots.send_modify(|seq| *seq += 1);
        }
        AgentFrame::Event {
            boot_id,
            local_session_id,
            event,
        } => {
            if !device.sync_enabled {
                return;
            }
            if let Some(envelope) = device.sessions.translate(&boot_id, local_session_id, event) {
                device.publish(envelope);
            }
        }
        AgentFrame::CommandResult {
            command_id,
            status,
            error,
        } => {
            if !matches!(
                status.as_str(),
                "accepted" | "executed" | "failed" | "expired"
            ) {
                return;
            }
            // Receipts are looked up inside this device only; an agent can
            // never settle a command addressed to another desktop.
            let Some(receipt) = device.commands.get_mut(&command_id) else {
                return;
            };
            // Reconnects can resend an old acceptance after a terminal receipt.
            if matches!(receipt.status.as_str(), "executed" | "failed" | "expired") {
                return;
            }
            receipt.status = status.clone();
            receipt.updated_ms = now;
            receipt.envelope = CloudEnvelope::new(
                receipt.cloud_session_id,
                "command.status",
                json!({"command_id": command_id, "status": status, "error": error}),
                now,
            );
            let envelope = receipt.envelope.clone();
            device.publish(envelope);
        }
        AgentFrame::SetupResult {
            request_id,
            boot_id,
            status,
            body,
        } => setup::complete(device, &request_id, &boot_id, status, body, now),
        AgentFrame::Ping => {
            let _ = tx.send(ServerFrame::Pong);
        }
    }
}
