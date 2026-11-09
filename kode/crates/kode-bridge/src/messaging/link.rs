//! One authenticated full-duplex link carries both directions, including behind ssh -L.
use super::{api::Error, model::*, Hub, Peer};
use anyhow::{bail, Result};
use axum::{
    extract::{
        ws::{Message as AxMessage, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as TungMessage};

pub(super) fn validate_url(url: &str) -> Result<()> {
    let uri: axum::http::Uri = url.parse()?;
    if !matches!(uri.scheme_str(), Some("http" | "https"))
        || uri.host().is_none()
        || uri.authority().is_some_and(|a| a.as_str().contains('@'))
        || uri.query().is_some()
        || uri.path() != "/"
    {
        bail!("peer URL must be an HTTP(S) origin without credentials or query")
    }
    Ok(())
}
const PROTOCOL_HEADER: &str = "x-kode-messaging-version";

fn initial(hub: &Hub, version: u32) -> Frame {
    Frame::Hello {
        node_id: hub.node_id().into(),
        version,
    }
}
fn frames(hub: &Hub, peer: &str, sent: &mut HashMap<String, Status>) -> Result<Vec<Frame>> {
    let mut out = vec![Frame::Directory {
        sessions: hub.store.sessions()?,
    }];
    for (id, (node, command, _)) in hub.workspace_pending.lock().iter() {
        if node == peer {
            out.push(Frame::WorkspaceRequest {
                id: id.clone(),
                command: command.clone(),
            });
        }
    }
    for m in hub.store.peer_messages(peer)? {
        if sent.get(&m.id) == Some(&m.status) {
            continue;
        }
        sent.insert(m.id.clone(), m.status.clone());
        if m.source.node_id == hub.node_id() && m.target.node_id == peer && !m.status.terminal() {
            out.push(Frame::Message { message: m });
        } else if m.source.node_id == peer && m.target.node_id == hub.node_id() {
            out.push(Frame::Receipt {
                id: m.id,
                status: m.status,
                detail: m.detail,
            });
        }
    }
    Ok(out)
}
async fn incoming(
    hub: &Arc<Hub>,
    peer: &str,
    text: &str,
    delivery: &mut DeliveryLink,
) -> Result<Option<Frame>> {
    if text.len() > 128 * 1024 {
        bail!("peer frame too large")
    }
    match serde_json::from_str::<Frame>(text)? {
        Frame::OperationRequest { id, request } => {
            if !delivery.operation_enabled || !valid_id(&id) {
                bail!("operation relay not negotiated or invalid identity")
            }
            if request.requires_assignment_task_workspace() && !delivery.assignment_task_workspace_enabled {
                bail!("Assignment task worktree not negotiated")
            }
            if request.requires_assignment_workspace() && !delivery.assignment_workspace_enabled {
                bail!("Assignment workspace not negotiated")
            }
            if request.requires_assignment_archive() && !delivery.assignment_archive_enabled {
                bail!("Assignment archive not negotiated")
            }
            if request.requires_verification_archive() && !delivery.verification_archive_enabled {
                bail!("Verification archive not negotiated")
            }
            if request.requires_archive_capability() && !delivery.archive_enabled {
                bail!("Artifact archive not negotiated")
            }
            if request.requires_assignment_outputs_capability()
                && !delivery.assignment_outputs_enabled
            {
                bail!("Assignment outputs not negotiated")
            }
            if request.requires_assignment_clarification_capability() && !delivery.assignment_clarification_enabled {
                bail!("Assignment clarification not negotiated")
            }
            if request.requires_assignment_run_capability() && !delivery.assignment_run_enabled {
                bail!("Assignment run context not negotiated")
            }
            if request.requires_assignment_stop_capability() && !delivery.assignment_stop_enabled {
                bail!("Assignment stop not negotiated")
            }
            if request.requires_assignment_admission_capability()
                && !delivery.assignment_admission_enabled
            {
                bail!("Assignment admission not negotiated")
            }
            if request.requires_assignment_creation_capability()
                && !delivery.assignment_creation_enabled
            {
                bail!("Assignment creation not negotiated")
            }
            if request.requires_assignment_capability() && !delivery.assignment_enabled {
                bail!("Assignment context not negotiated")
            }
            if request.requires_monetary_capability() && !delivery.monetary_enabled {
                bail!("monetary quota not negotiated")
            }
            if request.requires_grant_capability() && !delivery.grant_enabled {
                bail!("grant projection not negotiated")
            }
            if request.requires_selection_capability() && !delivery.selection_enabled {
                bail!("selection evidence not negotiated")
            }
            if request.requires_artifact_capability() && !delivery.artifact_enabled {
                bail!("artifact evidence not negotiated")
            }
            if request.requires_tool_capability() && !delivery.tool_enabled {
                bail!("tool evidence not negotiated")
            }
            if request.requires_official_capability() && !delivery.official_enabled {
                bail!("official call accounting not negotiated")
            }
            if request.requires_quota_capability() && !delivery.quota_enabled {
                bail!("operation quota not negotiated")
            }
            if request.requires_resource_capability() && !delivery.resource_enabled {
                bail!("operation resources not negotiated")
            }
            if request.accounting.is_some() && !delivery.accounting_enabled {
                bail!("operation accounting not negotiated")
            }
            Ok(Some(match hub.receive_operation(peer, request) {
                Ok(value) => Frame::OperationResponse {
                    id,
                    value: Some(value),
                    error: None,
                },
                Err(error) => Frame::OperationResponse {
                    id,
                    value: None,
                    error: Some(error.to_string()),
                },
            }))
        }
        Frame::OperationResponse { id, value, error } => {
            if !delivery.operation_enabled {
                bail!("operation relay not negotiated")
            }
            let mut pending = hub.operation_pending.lock();
            if pending.get(&id).is_some_and(|p| p.node == peer && p.sent) {
                if let Some(p) = pending.remove(&id) {
                    let _ = p.result.send(match (value, error) {
                        (Some(value), None) => Ok(value),
                        (None, Some(error)) => Err(error),
                        _ => Err("invalid operation response".into()),
                    });
                }
            }
            Ok(None)
        }
        Frame::InputCancellation { record } => {
            if !delivery.cancel_enabled {
                bail!("input cancellation not negotiated")
            }
            Ok(hub
                .receive_cancellation(peer, record)?
                .map(|record| Frame::InputCancellation { record }))
        }
        Frame::DeliveryBatch { entries } => {
            if !delivery.enabled {
                bail!("delivery observations not negotiated")
            }
            Ok(Some(Frame::DeliveryAck {
                through: hub.mirror_deliveries(peer, &entries)?,
            }))
        }
        Frame::DeliveryAck { through } => {
            if !delivery.enabled || through == 0 || through > delivery.sent_through {
                bail!("invalid delivery acknowledgement")
            }
            hub.store.acknowledge_deliveries(peer, through)?;
            Ok(None)
        }
        Frame::WorkspaceRequest { id, command } => {
            if !valid_id(&id) {
                bail!("invalid workspace request")
            }
            let result = if let super::workspaces::Command::AssignmentCatalog { after } = command {
                if !delivery.assignment_catalog_enabled {
                    bail!("Assignment catalog not negotiated")
                }
                hub.store.remote_assignment_catalog(peer, after)
            } else {
                super::workspaces::execute(hub.clone(), command).await
            };
            Ok(Some(match result {
                Ok(value) => Frame::WorkspaceResponse {
                    id,
                    value: Some(value),
                    error: None,
                },
                Err(error) => Frame::WorkspaceResponse {
                    id,
                    value: None,
                    error: Some(error.to_string()),
                },
            }))
        }
        Frame::WorkspaceResponse { id, value, error } => {
            let mut pending = hub.workspace_pending.lock();
            if pending.get(&id).is_some_and(|(node, _, _)| node == peer) {
                if let Some((_, _, send)) = pending.remove(&id) {
                    let _ = send.send(match (value, error) {
                        (Some(value), None) => Ok(value),
                        (_, Some(error)) => Err(error),
                        _ => Err("invalid workspace response".into()),
                    });
                }
            }
            Ok(None)
        }
        Frame::Hello { .. } | Frame::Capabilities { .. } => bail!("unexpected handshake frame"),
        Frame::Directory { mut sessions } => {
            if sessions.len() > 4096
                || sessions.iter().any(|s| {
                    s.address.node_id != peer
                        || !valid_id(&s.address.session_id)
                        || s.title.len() > 512
                        || s.runtime.len() > 64
                })
            {
                bail!("invalid peer directory")
            }
            for s in &mut sessions {
                s.updated_at = now();
            }
            hub.remote.lock().insert(peer.into(), sessions);
            Ok(None)
        }
        Frame::Message { message } => {
            let id = message.id.clone();
            match hub.receive(peer, message) {
                Ok(m) => Ok(Some(Frame::Receipt {
                    id: m.id,
                    status: m.status,
                    detail: m.detail,
                })),
                Err(e) => Ok(Some(Frame::Receipt {
                    id,
                    status: Status::Rejected,
                    detail: Some(e.to_string()),
                })),
            }
        }
        Frame::Receipt { id, status, detail } => {
            hub.receipt(peer, &id, status, detail)?;
            Ok(None)
        }
    }
}
fn hello(text: &str, peer: &str) -> Result<u32> {
    if text.len() > 1024 {
        bail!("hello frame too large")
    }
    match serde_json::from_str::<Frame>(text)? {
        Frame::Hello { node_id, version } if node_id == peer && matches!(version, 1 | 2) => {
            Ok(version)
        }
        _ => bail!("peer identity/protocol mismatch"),
    }
}
fn requested_version(headers: &HeaderMap) -> Result<u32> {
    match headers.get(PROTOCOL_HEADER) {
        None => Ok(1),
        Some(value) => match value.to_str()? {
            "1" => Ok(1),
            "2" => Ok(2),
            _ => bail!("unsupported messaging protocol offer"),
        },
    }
}
const MONETARY_FEATURE: &str = "operation_monetary_quota_v1";
const SELECTION_FEATURE: &str = "operation_selection_evidence_v1";
const GRANT_FEATURE: &str = "operation_grants_v1";
const ASSIGNMENT_TASK_WORKSPACE_FEATURE: &str = "operation_assignment_task_workspace_v1";
const ASSIGNMENT_WORKSPACE_FEATURE: &str = "operation_assignment_workspace_v1";
const ASSIGNMENT_ARCHIVE_FEATURE: &str = "operation_assignment_archive_v1";
const VERIFICATION_ARCHIVE_FEATURE: &str = "operation_verification_archive_v1";
const ARCHIVE_FEATURE: &str = "operation_artifact_archive_v1";
const ASSIGNMENT_OUTPUTS_FEATURE: &str = "operation_assignment_outputs_v1";
const ASSIGNMENT_CATALOG_FEATURE: &str = "assignment_catalog_v1";
const ASSIGNMENT_CLARIFICATION_FEATURE: &str = "operation_assignment_clarification_v1";
const ASSIGNMENT_RUN_FEATURE: &str = "operation_assignment_run_context_v1";
const ASSIGNMENT_STOP_FEATURE: &str = "operation_assignment_stop_v1";
const ASSIGNMENT_ADMISSION_FEATURE: &str = "operation_assignment_admission_v1";
const ASSIGNMENT_CREATION_FEATURE: &str = "operation_assignment_creation_v1";
const ASSIGNMENT_FEATURE: &str = "operation_assignment_context_v1";
const ARTIFACT_FEATURE: &str = "operation_artifact_evidence_v1";
const TOOL_FEATURE: &str = "operation_tool_evidence_v1";
const OFFICIAL_FEATURE: &str = "operation_official_calls_v1";
const QUOTA_FEATURE: &str = "operation_quota_v1";
const RESOURCE_FEATURE: &str = "operation_resources_v1";
const ACCOUNTING_FEATURE: &str = "operation_accounting_v1";
const OPERATION_FEATURE: &str = "operation_leases_v1";
const CANCEL_FEATURE: &str = "input_cancellation_v1";
const DELIVERY_FEATURE: &str = "delivery_observations_v1";
#[derive(Default)]
struct DeliveryLink {
    assignment_admission_enabled: bool,
    assignment_stop_enabled: bool,
    assignment_run_enabled: bool,
    assignment_clarification_enabled: bool,
    assignment_catalog_enabled: bool,
    assignment_task_workspace_enabled: bool,
    assignment_workspace_enabled: bool,
    assignment_archive_enabled: bool,
    verification_archive_enabled: bool,
    archive_enabled: bool,
    assignment_outputs_enabled: bool,
    assignment_creation_enabled: bool,
    assignment_enabled: bool,
    artifact_enabled: bool,
    monetary_enabled: bool,
    selection_enabled: bool,
    grant_enabled: bool,
    tool_enabled: bool,
    official_enabled: bool,
    quota_enabled: bool,
    resource_enabled: bool,
    accounting_enabled: bool,
    operation_enabled: bool,
    enabled: bool,
    sent_through: u64,
    cancel_enabled: bool,
    cancel_after: String,
}
impl DeliveryLink {
    fn frames(
        &mut self,
        hub: &Hub,
        peer: &str,
        sent: &mut HashMap<String, Status>,
    ) -> Result<Vec<Frame>> {
        if !self.assignment_catalog_enabled {
            let mut pending = hub.workspace_pending.lock();
            let unsupported: Vec<_> = pending
                .iter()
                .filter(|(_, (node, command, _))| {
                    node == peer
                        && matches!(
                            command,
                            super::workspaces::Command::AssignmentCatalog { .. }
                        )
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in unsupported {
                if let Some((_, _, send)) = pending.remove(&id) {
                    let _ = send.send(Err("peer lacks assignment_catalog_v1 capability".into()));
                }
            }
        }
        if !self.assignment_task_workspace_enabled {
            let mut pending = hub.operation_pending.lock();
            let ids: Vec<_> = pending.iter().filter(|(_, p)| p.node == peer && p.request.requires_assignment_task_workspace()).map(|(id, _)| id.clone()).collect();
            for id in ids {
                if let Some(p) = pending.remove(&id) {
                    let _ = p.result.send(Err("peer lacks operation_assignment_task_workspace_v1 capability".into()));
                }
            }
        }
        if !self.assignment_workspace_enabled {
            let mut pending = hub.operation_pending.lock();
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, p)| p.node == peer && p.request.requires_assignment_workspace())
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(p) = pending.remove(&id) {
                    let _ = p.result.send(Err(
                        "peer lacks operation_assignment_workspace_v1 capability".into(),
                    ));
                }
            }
        }
        if !self.assignment_archive_enabled {
            let mut pending = hub.operation_pending.lock();
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, p)| p.node == peer && p.request.requires_assignment_archive())
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(p) = pending.remove(&id) {
                    let _ = p.result.send(Err(
                        "peer lacks operation_assignment_archive_v1 capability".into(),
                    ));
                }
            }
        }
        if !self.verification_archive_enabled {
            let mut pending = hub.operation_pending.lock();
            let ids: Vec<_> = pending
                .iter()
                .filter(|(_, p)| p.node == peer && p.request.requires_verification_archive())
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                if let Some(p) = pending.remove(&id) {
                    let _ = p.result.send(Err(
                        "peer lacks operation_verification_archive_v1 capability".into(),
                    ));
                }
            }
        }
        let mut frames = frames(hub, peer, sent)?;
        frames.extend(hub.operation_frames(
            peer,
            self.operation_enabled,
            self.accounting_enabled,
            self.resource_enabled,
            self.quota_enabled,
            self.official_enabled,
            self.tool_enabled,
            self.grant_enabled,
            self.selection_enabled,
            self.monetary_enabled,
            self.artifact_enabled,
            self.assignment_enabled,
            self.assignment_creation_enabled,
            self.assignment_admission_enabled,
            self.assignment_stop_enabled,
            self.assignment_run_enabled,
            self.archive_enabled,
            self.assignment_outputs_enabled,
            self.assignment_clarification_enabled,
        ));
        if self.enabled {
            let entries = hub.store.delivery_batch(peer)?;
            if let Some(last) = entries.last() {
                self.sent_through = last.seq;
                frames.push(Frame::DeliveryBatch { entries });
            }
        }
        if self.cancel_enabled {
            let records = hub.outgoing_cancellations(peer, &self.cancel_after)?;
            self.cancel_after = if records.len() == 64 {
                records.last().unwrap().message_id.clone()
            } else {
                String::new()
            };
            frames.extend(
                records
                    .into_iter()
                    .map(|record| Frame::InputCancellation { record }),
            );
        }
        Ok(frames)
    }
}
fn capabilities() -> Frame {
    Frame::Capabilities {
        features: vec![
            DELIVERY_FEATURE.into(),
            CANCEL_FEATURE.into(),
            OPERATION_FEATURE.into(),
            ACCOUNTING_FEATURE.into(),
            RESOURCE_FEATURE.into(),
            QUOTA_FEATURE.into(),
            OFFICIAL_FEATURE.into(),
            TOOL_FEATURE.into(),
            GRANT_FEATURE.into(),
            SELECTION_FEATURE.into(),
            MONETARY_FEATURE.into(),
            ARTIFACT_FEATURE.into(),
            ASSIGNMENT_FEATURE.into(),
            ASSIGNMENT_CREATION_FEATURE.into(),
            ASSIGNMENT_ADMISSION_FEATURE.into(),
            ASSIGNMENT_STOP_FEATURE.into(),
            ASSIGNMENT_RUN_FEATURE.into(),
            ASSIGNMENT_CLARIFICATION_FEATURE.into(),
            ASSIGNMENT_CATALOG_FEATURE.into(),
            ASSIGNMENT_OUTPUTS_FEATURE.into(),
            ASSIGNMENT_TASK_WORKSPACE_FEATURE.into(),
            ASSIGNMENT_WORKSPACE_FEATURE.into(),
            ASSIGNMENT_ARCHIVE_FEATURE.into(),
            VERIFICATION_ARCHIVE_FEATURE.into(),
            ARCHIVE_FEATURE.into(),
        ],
    }
}
fn check_capabilities(text: &str) -> Result<Vec<String>> {
    if text.len() > 8192 {
        bail!("capabilities frame too large")
    }
    let Frame::Capabilities { features } = serde_json::from_str::<Frame>(text)? else {
        bail!("expected capabilities before application frames")
    };
    let mut unique = std::collections::HashSet::new();
    if features.len() > 64
        || features
            .iter()
            .any(|f| f.len() > 64 || !valid_id(f) || !unique.insert(f))
    {
        bail!("invalid capabilities")
    }
    Ok(features)
}
fn disconnected(hub: &Hub, peer: &str) {
    if let Some(sessions) = hub.remote.lock().get_mut(peer) {
        for s in sessions {
            s.online = false;
        }
    }
}

pub(super) async fn upgrade(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> std::result::Result<Response, Error> {
    let peer = headers
        .get("x-kode-node")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    let allowed = hub.peer_allowed(peer, token);
    if !allowed {
        return Err(Error(StatusCode::UNAUTHORIZED, "unauthorized peer".into()));
    }
    let version =
        requested_version(&headers).map_err(|e| Error(StatusCode::BAD_REQUEST, e.to_string()))?;
    let peer = peer.to_string();
    let token = token.to_string();
    Ok(ws
        .max_message_size(128 * 1024)
        .max_frame_size(128 * 1024)
        .on_upgrade(move |socket| async move {
            if let Err(e) = serve(&hub, &peer, &token, version, socket).await {
                tracing::debug!(error=%e,"messaging peer disconnected");
            }
            disconnected(&hub, &peer);
        }))
}
async fn serve(
    hub: &Arc<Hub>,
    peer: &str,
    token: &str,
    version: u32,
    mut socket: WebSocket,
) -> Result<()> {
    socket
        .send(AxMessage::Text(super::wire::encode(
            &initial(hub, version),
            version,
        )?))
        .await?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await?
        .ok_or_else(|| anyhow::anyhow!("missing hello"))??;
    let AxMessage::Text(text) = first else {
        bail!("expected hello")
    };
    if hello(&text, peer)? != version {
        bail!("peer changed negotiated protocol")
    }
    let mut delivery = DeliveryLink::default();
    if version == 2 {
        socket
            .send(AxMessage::Text(super::wire::encode(
                &capabilities(),
                version,
            )?))
            .await?;
        let frame = tokio::time::timeout(Duration::from_secs(10), socket.recv())
            .await?
            .ok_or_else(|| anyhow::anyhow!("missing capabilities"))??;
        let AxMessage::Text(text) = frame else {
            bail!("expected capabilities")
        };
        let features = check_capabilities(&text)?;
        delivery.enabled = features.iter().any(|f| f == DELIVERY_FEATURE);
        delivery.cancel_enabled = features.iter().any(|f| f == CANCEL_FEATURE);
        delivery.operation_enabled = features.iter().any(|f| f == OPERATION_FEATURE);
        delivery.accounting_enabled = features.iter().any(|f| f == ACCOUNTING_FEATURE);
        delivery.resource_enabled = features.iter().any(|f| f == RESOURCE_FEATURE);
        delivery.monetary_enabled = features.iter().any(|f| f == MONETARY_FEATURE);
        delivery.selection_enabled = features.iter().any(|f| f == SELECTION_FEATURE);
        delivery.grant_enabled = features.iter().any(|f| f == GRANT_FEATURE);
        delivery.artifact_enabled = features.iter().any(|f| f == ARTIFACT_FEATURE);
        delivery.assignment_enabled = features.iter().any(|f| f == ASSIGNMENT_FEATURE);
        delivery.assignment_creation_enabled =
            features.iter().any(|f| f == ASSIGNMENT_CREATION_FEATURE);
        delivery.assignment_admission_enabled =
            features.iter().any(|f| f == ASSIGNMENT_ADMISSION_FEATURE);
        delivery.assignment_stop_enabled = features.iter().any(|f| f == ASSIGNMENT_STOP_FEATURE);
        delivery.assignment_run_enabled = features.iter().any(|f| f == ASSIGNMENT_RUN_FEATURE);
        delivery.assignment_clarification_enabled = features.iter().any(|f| f == ASSIGNMENT_CLARIFICATION_FEATURE);
        delivery.assignment_catalog_enabled =
            features.iter().any(|f| f == ASSIGNMENT_CATALOG_FEATURE);
        delivery.assignment_outputs_enabled =
            features.iter().any(|f| f == ASSIGNMENT_OUTPUTS_FEATURE);
        delivery.assignment_task_workspace_enabled = features.iter().any(|f| f == ASSIGNMENT_TASK_WORKSPACE_FEATURE);
        delivery.assignment_workspace_enabled =
            features.iter().any(|f| f == ASSIGNMENT_WORKSPACE_FEATURE);
        delivery.assignment_archive_enabled =
            features.iter().any(|f| f == ASSIGNMENT_ARCHIVE_FEATURE);
        delivery.verification_archive_enabled =
            features.iter().any(|f| f == VERIFICATION_ARCHIVE_FEATURE);
        delivery.archive_enabled = features.iter().any(|f| f == ARCHIVE_FEATURE);
        delivery.tool_enabled = features.iter().any(|f| f == TOOL_FEATURE);
        delivery.official_enabled = features.iter().any(|f| f == OFFICIAL_FEATURE);
        delivery.quota_enabled = features.iter().any(|f| f == QUOTA_FEATURE);
    }
    hub.remember_cancel_peer(peer, delivery.cancel_enabled)?;
    let observation = hub.observe_link(peer, version);
    let mut sent = HashMap::new();
    let mut last_seen = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            _=observation.send_ready(&mut tick)=>{
                if hub.stopped.load(Ordering::Relaxed) || !hub.peer_allowed(peer, token){break}
                if last_seen.elapsed()>Duration::from_secs(15){bail!("peer heartbeat timed out")} for f in delivery.frames(hub,peer,&mut sent)? {tokio::time::timeout(Duration::from_secs(10),socket.send(AxMessage::Text(super::wire::encode(&f, version)?))).await??;}}
            msg=socket.recv()=>match msg {
                Some(Ok(AxMessage::Text(text)))=>{if !hub.peer_allowed(peer,token){break} last_seen=Instant::now();if let Some(f)=incoming(hub,peer,&text,&mut delivery).await? {tokio::time::timeout(Duration::from_secs(10),socket.send(AxMessage::Text(super::wire::encode(&f, version)?))).await??;} observation.received();},
                Some(Ok(AxMessage::Ping(b)))=>socket.send(AxMessage::Pong(b)).await?,
                Some(Ok(AxMessage::Pong(_)))=>{},
                _=>break,
            }
        }
    }
    Ok(())
}
pub(super) fn connect(hub: Arc<Hub>, peer: Peer) {
    tokio::spawn(async move {
        let mut backoff = 1;
        while !hub.stopped.load(Ordering::Relaxed)
            && hub.peer_allowed(&peer.node_id, &peer.link_token)
        {
            let mut tunnel = None;
            let url = if let Some(ssh) = &peer.ssh {
                match super::ssh::Tunnel::start(ssh).await {
                    Ok(t) => {
                        let u = t.url.clone();
                        tunnel = Some(t);
                        u
                    }
                    Err(e) => {
                        tracing::debug!(error=%e,"messaging SSH unavailable");
                        tokio::time::sleep(Duration::from_secs(backoff)).await;
                        backoff = (backoff * 2).min(30);
                        continue;
                    }
                }
            } else {
                peer.url.clone().expect("initiating peer URL")
            };
            if let Err(e) = dial(&hub, &peer, &url).await {
                tracing::debug!(error=%e,peer=%peer.node_id,"messaging link reconnecting");
            }
            disconnected(&hub, &peer.node_id);
            if let Some(t) = &mut tunnel {
                t.close().await;
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
}
async fn dial(hub: &Arc<Hub>, peer: &Peer, url: &str) -> Result<()> {
    validate_url(url)?;
    let ws =
        format!("{}/api/v1/messaging/link", url.trim_end_matches('/')).replacen("http", "ws", 1);
    let mut request = ws.into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", peer.link_token).parse()?,
    );
    request
        .headers_mut()
        .insert("x-kode-node", hub.node_id().parse()?);
    request.headers_mut().insert(PROTOCOL_HEADER, "2".parse()?);
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await??;
    // Released v1 servers send Hello first. Wait for their choice before replying.
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await?
        .ok_or_else(|| anyhow::anyhow!("missing hello"))??;
    let TungMessage::Text(text) = first else {
        bail!("expected hello")
    };
    let version = hello(&text, &peer.node_id)?;
    socket
        .send(TungMessage::Text(super::wire::encode(
            &initial(hub, version),
            version,
        )?))
        .await?;
    let mut delivery = DeliveryLink::default();
    if version == 2 {
        socket
            .send(TungMessage::Text(super::wire::encode(
                &capabilities(),
                version,
            )?))
            .await?;
        let frame = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await?
            .ok_or_else(|| anyhow::anyhow!("missing capabilities"))??;
        let TungMessage::Text(text) = frame else {
            bail!("expected capabilities")
        };
        let features = check_capabilities(&text)?;
        delivery.enabled = features.iter().any(|f| f == DELIVERY_FEATURE);
        delivery.cancel_enabled = features.iter().any(|f| f == CANCEL_FEATURE);
        delivery.operation_enabled = features.iter().any(|f| f == OPERATION_FEATURE);
        delivery.accounting_enabled = features.iter().any(|f| f == ACCOUNTING_FEATURE);
        delivery.resource_enabled = features.iter().any(|f| f == RESOURCE_FEATURE);
        delivery.monetary_enabled = features.iter().any(|f| f == MONETARY_FEATURE);
        delivery.selection_enabled = features.iter().any(|f| f == SELECTION_FEATURE);
        delivery.grant_enabled = features.iter().any(|f| f == GRANT_FEATURE);
        delivery.artifact_enabled = features.iter().any(|f| f == ARTIFACT_FEATURE);
        delivery.assignment_enabled = features.iter().any(|f| f == ASSIGNMENT_FEATURE);
        delivery.assignment_creation_enabled =
            features.iter().any(|f| f == ASSIGNMENT_CREATION_FEATURE);
        delivery.assignment_admission_enabled =
            features.iter().any(|f| f == ASSIGNMENT_ADMISSION_FEATURE);
        delivery.assignment_stop_enabled = features.iter().any(|f| f == ASSIGNMENT_STOP_FEATURE);
        delivery.assignment_run_enabled = features.iter().any(|f| f == ASSIGNMENT_RUN_FEATURE);
        delivery.assignment_clarification_enabled = features.iter().any(|f| f == ASSIGNMENT_CLARIFICATION_FEATURE);
        delivery.assignment_catalog_enabled =
            features.iter().any(|f| f == ASSIGNMENT_CATALOG_FEATURE);
        delivery.assignment_outputs_enabled =
            features.iter().any(|f| f == ASSIGNMENT_OUTPUTS_FEATURE);
        delivery.assignment_task_workspace_enabled = features.iter().any(|f| f == ASSIGNMENT_TASK_WORKSPACE_FEATURE);
        delivery.assignment_workspace_enabled =
            features.iter().any(|f| f == ASSIGNMENT_WORKSPACE_FEATURE);
        delivery.assignment_archive_enabled =
            features.iter().any(|f| f == ASSIGNMENT_ARCHIVE_FEATURE);
        delivery.verification_archive_enabled =
            features.iter().any(|f| f == VERIFICATION_ARCHIVE_FEATURE);
        delivery.archive_enabled = features.iter().any(|f| f == ARCHIVE_FEATURE);
        delivery.tool_enabled = features.iter().any(|f| f == TOOL_FEATURE);
        delivery.official_enabled = features.iter().any(|f| f == OFFICIAL_FEATURE);
        delivery.quota_enabled = features.iter().any(|f| f == QUOTA_FEATURE);
    }
    hub.remember_cancel_peer(&peer.node_id, delivery.cancel_enabled)?;
    let observation = hub.observe_link(&peer.node_id, version);
    let mut sent = HashMap::new();
    let mut last_seen = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            _=observation.send_ready(&mut tick)=>{
                if hub.stopped.load(Ordering::Relaxed) || !hub.peer_allowed(&peer.node_id, &peer.link_token){break}
                if last_seen.elapsed()>Duration::from_secs(15){bail!("peer heartbeat timed out")} for f in delivery.frames(hub,&peer.node_id,&mut sent)? {tokio::time::timeout(Duration::from_secs(10),socket.send(TungMessage::Text(super::wire::encode(&f, version)?))).await??;}}
            msg=socket.next()=>match msg {
                Some(Ok(TungMessage::Text(text)))=>{if !hub.peer_allowed(&peer.node_id,&peer.link_token){break} last_seen=Instant::now();if let Some(f)=incoming(hub,&peer.node_id,&text,&mut delivery).await? {tokio::time::timeout(Duration::from_secs(10),socket.send(TungMessage::Text(super::wire::encode(&f, version)?))).await??;} observation.received();},
                Some(Ok(TungMessage::Ping(b)))=>socket.send(TungMessage::Pong(b)).await?,
                Some(Ok(TungMessage::Pong(_)))=>{},
                _=>break,
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use serde_json::json;
    const TOKEN: &str = "isolated-protocol-fixture-secret-32-bytes";
    fn fixture() -> (Arc<Hub>, Arc<crate::Ctx>, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let ctx = crate::build_test_ctx(kode_core::config::Config::default(), "test-admin".into());
        let hub = Hub::open(
            super::super::Config {
                node_id: "new".into(),
                database: root.path().join("messages.sqlite"),
                peers: vec![Peer {
                    node_id: "old".into(),
                    link_token: TOKEN.into(),
                    url: None,
                    ssh: None,
                }],
            },
            &ctx,
        )
        .unwrap();
        (hub, ctx, root)
    }
    #[test]
    fn negotiation_validates_identity_versions_and_bounded_capabilities() {
        assert_eq!(requested_version(&HeaderMap::new()).unwrap(), 1);
        let mut headers = HeaderMap::new();
        headers.insert(PROTOCOL_HEADER, "2".parse().unwrap());
        assert_eq!(requested_version(&headers).unwrap(), 2);
        headers.insert(PROTOCOL_HEADER, "3".parse().unwrap());
        assert!(requested_version(&headers).is_err());
        assert_eq!(
            hello(r#"{"type":"hello","node_id":"peer","version":2}"#, "peer").unwrap(),
            2
        );
        assert!(hello(
            r#"{"type":"hello","node_id":"foreign","version":2}"#,
            "peer"
        )
        .is_err());
        assert!(hello(r#"{"type":"hello","node_id":"peer","version":3}"#, "peer").is_err());
        assert!(check_capabilities(r#"{"type":"directory","sessions":[]}"#).is_err());
        assert!(check_capabilities(r#"{"type":"capabilities","features":["x","x"]}"#).is_err());
        assert!(check_capabilities(
            &json!({"type":"capabilities","features":vec!["x";65]}).to_string()
        )
        .is_err());
        assert_eq!(
            check_capabilities(&serde_json::to_string(&capabilities()).unwrap()).unwrap(),
            [
                DELIVERY_FEATURE,
                CANCEL_FEATURE,
                OPERATION_FEATURE,
                ACCOUNTING_FEATURE,
                RESOURCE_FEATURE,
                QUOTA_FEATURE,
                OFFICIAL_FEATURE,
                TOOL_FEATURE,
                GRANT_FEATURE,
                SELECTION_FEATURE,
                MONETARY_FEATURE,
                ARTIFACT_FEATURE,
                ASSIGNMENT_FEATURE,
                ASSIGNMENT_CREATION_FEATURE,
                ASSIGNMENT_ADMISSION_FEATURE,
                ASSIGNMENT_STOP_FEATURE,
                ASSIGNMENT_RUN_FEATURE,
                ASSIGNMENT_CLARIFICATION_FEATURE,
                ASSIGNMENT_CATALOG_FEATURE,
                ASSIGNMENT_OUTPUTS_FEATURE,
                ASSIGNMENT_TASK_WORKSPACE_FEATURE,
                ASSIGNMENT_WORKSPACE_FEATURE,
                ASSIGNMENT_ARCHIVE_FEATURE,
                VERIFICATION_ARCHIVE_FEATURE,
                ARCHIVE_FEATURE
            ]
        );
    }
    #[tokio::test]
    async fn reconnect_replays_terminal_receipts_without_redelivering_messages() {
        let (hub, _ctx, _root) = fixture();
        let message = Message {
            id: "completed-message".into(),
            source: Address {
                node_id: "old".into(),
                session_id: "sender".into(),
            },
            target: Address {
                node_id: "new".into(),
                session_id: "worker".into(),
            },
            content: "fixture".into(),
            idempotency_key: "receipt-replay".into(),
            in_reply_to: None,
            hop_count: 0,
            created_at: now(),
            expires_at: now() + 60_000,
            status: Status::Accepted,
            detail: None,
        };
        hub.store.insert(message).unwrap();
        hub.observe_delivery(
            "completed-message",
            super::super::delivery::Observation {
                session_id: "worker".into(),
                input_id: "stable-input".into(),
                phase: super::super::delivery::Phase::Prepared,
                event_seq: None,
            },
        )
        .unwrap();
        let legacy = DeliveryLink::default()
            .frames(&hub, "old", &mut HashMap::new())
            .unwrap();
        assert!(!legacy.iter().any(|f| matches!(
            f,
            Frame::DeliveryBatch { .. } | Frame::InputCancellation { .. }
        )));
        assert!(incoming(
            &hub,
            "old",
            r#"{"type":"delivery_ack","through":1}"#,
            &mut DeliveryLink::default()
        )
        .await
        .is_err());
        let control = Frame::InputCancellation {
            record: super::super::cancellation::Record {
                message_id: "message".into(),
                session_id: "worker".into(),
                input_id: "input".into(),
                state: super::super::cancellation::State::Requested,
                reason: None,
                updated_at: 1,
            },
        };
        assert!(incoming(
            &hub,
            "old",
            &serde_json::to_string(&control).unwrap(),
            &mut DeliveryLink::default()
        )
        .await
        .is_err());

        let mut sent = HashMap::new();
        assert!(frames(&hub, "old", &mut sent)
            .unwrap()
            .iter()
            .any(|f| matches!(
                f,
                Frame::Receipt {
                    status: Status::Accepted,
                    ..
                }
            )));
        assert!(!frames(&hub, "old", &mut sent)
            .unwrap()
            .iter()
            .any(|f| matches!(f, Frame::Receipt { .. })));
        let replay = frames(&hub, "old", &mut HashMap::new()).unwrap();
        assert!(replay.iter().any(|f| matches!(
            f,
            Frame::Receipt {
                status: Status::Accepted,
                ..
            }
        )));
        assert!(!replay.iter().any(|f| matches!(f, Frame::Message { .. })));
    }
    #[tokio::test]
    async fn new_client_waits_for_legacy_hello_and_never_sends_capabilities() {
        let (hub, _ctx, _root) = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.send(TungMessage::Text(
                json!({"type":"hello","node_id":"old","version":1}).to_string(),
            ))
            .await
            .unwrap();
            let response = ws.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&response).unwrap(),
                json!({"type":"hello","node_id":"new","version":1})
            );
            let data = ws.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&data).unwrap(),
                json!({"type":"directory","sessions":[]})
            );
            ws.close(None).await.unwrap();
        });
        let peer = hub.peers()[0].clone();
        tokio::time::timeout(Duration::from_secs(5), dial(&hub, &peer, &url))
            .await
            .unwrap()
            .unwrap();
        server.await.unwrap();
    }
    #[tokio::test]
    async fn new_server_preserves_legacy_wire_and_requires_v2_capabilities() {
        let (hub, _ctx, _root) = fixture();
        let registered = hub
            .store
            .register(RegisterRequest {
                session_id: "worker".into(),
                title: "Fixture".into(),
                runtime: "dsh".into(),
                owner_token: None,
            })
            .unwrap();
        let expected = json!({"type":"directory","sessions":[{"address":{"node_id":"new","session_id":"worker"},"title":"Fixture","runtime":"dsh","online":true,"updated_at":registered.session.updated_at}]});
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "ws://{}/api/v1/messaging/link",
            listener.local_addr().unwrap()
        );
        let router = hub.router();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        for version in [1, 2] {
            let mut request = url.clone().into_client_request().unwrap();
            request
                .headers_mut()
                .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
            request
                .headers_mut()
                .insert("x-kode-node", "old".parse().unwrap());
            if version == 2 {
                request
                    .headers_mut()
                    .insert(PROTOCOL_HEADER, "2".parse().unwrap());
            }
            let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
            let greeting = ws.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(hello(&greeting, "new").unwrap(), version);
            ws.send(TungMessage::Text(
                json!({"type":"hello","node_id":"old","version":version}).to_string(),
            ))
            .await
            .unwrap();
            if version == 2 {
                let caps = ws.next().await.unwrap().unwrap().into_text().unwrap();
                assert_eq!(
                    check_capabilities(&caps).unwrap(),
                    [
                        DELIVERY_FEATURE,
                        CANCEL_FEATURE,
                        OPERATION_FEATURE,
                        ACCOUNTING_FEATURE,
                        RESOURCE_FEATURE,
                        QUOTA_FEATURE,
                        OFFICIAL_FEATURE,
                        TOOL_FEATURE,
                        GRANT_FEATURE,
                        SELECTION_FEATURE,
                        MONETARY_FEATURE,
                        ARTIFACT_FEATURE,
                        ASSIGNMENT_FEATURE,
                        ASSIGNMENT_CREATION_FEATURE,
                        ASSIGNMENT_ADMISSION_FEATURE,
                        ASSIGNMENT_STOP_FEATURE,
                        ASSIGNMENT_RUN_FEATURE,
                        ASSIGNMENT_CLARIFICATION_FEATURE,
                        ASSIGNMENT_CATALOG_FEATURE,
                        ASSIGNMENT_OUTPUTS_FEATURE,
                        ASSIGNMENT_TASK_WORKSPACE_FEATURE,
                ASSIGNMENT_WORKSPACE_FEATURE,
                        ASSIGNMENT_ARCHIVE_FEATURE,
                        VERIFICATION_ARCHIVE_FEATURE,
                        ARCHIVE_FEATURE
                    ]
                );
                assert!(tokio::time::timeout(Duration::from_millis(50), ws.next())
                    .await
                    .is_err());
                ws.send(TungMessage::Text(
                    serde_json::to_string(&capabilities()).unwrap(),
                ))
                .await
                .unwrap();
            }
            let data = tokio::time::timeout(Duration::from_secs(2), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&data).unwrap(),
                expected
            );
            ws.close(None).await.unwrap();
        }
        hub.shutdown();
        server.abort();
    }
    #[tokio::test]
    async fn queued_operation_requests_wake_the_authenticated_socket_without_poll_delay() {
        let (hub, _ctx, _root) = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "ws://{}/api/v1/messaging/link",
            listener.local_addr().unwrap()
        );
        let router = hub.router();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        request
            .headers_mut()
            .insert("x-kode-node", "old".parse().unwrap());
        request
            .headers_mut()
            .insert(PROTOCOL_HEADER, "2".parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        ws.next().await.unwrap().unwrap(); // Hello
        ws.send(TungMessage::Text(
            serde_json::to_string(&Frame::Hello {
                node_id: "old".into(),
                version: 2,
            })
            .unwrap(),
        ))
        .await
        .unwrap();
        ws.next().await.unwrap().unwrap(); // Capabilities
        ws.send(TungMessage::Text(
            serde_json::to_string(&capabilities()).unwrap(),
        ))
        .await
        .unwrap();
        ws.next().await.unwrap().unwrap(); // First periodic directory, before queuing requests.
        let started = Instant::now();
        for sequence in 0..4 {
            let relay_hub = hub.clone();
            let relay = tokio::spawn(async move {
                relay_hub
                    .relay_operation(
                        "old",
                        super::super::operation_relay::Request {
                            operation_id: "op".into(),
                            worker_session: "worker".into(),
                            command: None,
                            accounting: None,
                        },
                    )
                    .await
                    .unwrap()
            });
            let id = loop {
                let text = tokio::time::timeout(Duration::from_millis(350), ws.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .into_text()
                    .unwrap();
                if let Frame::OperationRequest { id, .. } = serde_json::from_str(&text).unwrap() {
                    break id;
                }
            };
            if sequence == 0 {
                hub.wake_peer("old");
                hub.wake_peer("old");
                let duplicate = tokio::time::timeout(Duration::from_millis(50), async {
                    loop {
                        let text = ws.next().await.unwrap().unwrap().into_text().unwrap();
                        if matches!(
                            serde_json::from_str::<Frame>(&text).unwrap(),
                            Frame::OperationRequest { .. }
                        ) {
                            break;
                        }
                    }
                })
                .await;
                assert!(
                    duplicate.is_err(),
                    "a sent operation must not be sent again on a wakeup"
                );
            }
            ws.send(TungMessage::Text(
                serde_json::to_string(&Frame::OperationResponse {
                    id,
                    value: Some(json!({"sequence": sequence})),
                    error: None,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
            assert_eq!(relay.await.unwrap(), json!({"sequence": sequence}));
        }
        assert!(started.elapsed() < Duration::from_millis(450));
        assert!(hub.operation_pending.lock().is_empty());
        ws.close(None).await.unwrap();
        hub.shutdown();
        server.abort();
    }
    #[tokio::test]
    async fn assignment_catalog_requires_negotiation_and_binds_actual_peer() {
        let (hub, _ctx, _root) = fixture();
        let command = super::super::workspaces::Command::AssignmentCatalog { after: None };
        let frame = Frame::WorkspaceRequest {
            id: "catalog".into(),
            command: command.clone(),
        };
        assert!(super::super::wire::encode(&frame, 1).is_err());
        let text = serde_json::to_string(&frame).unwrap();
        assert!(incoming(&hub, "old", &text, &mut DeliveryLink::default())
            .await
            .is_err());
        let (send, receive) = tokio::sync::oneshot::channel();
        hub.workspace_pending
            .lock()
            .insert("catalog".into(), ("old".into(), command, send));
        let frames = DeliveryLink::default()
            .frames(&hub, "old", &mut HashMap::new())
            .unwrap();
        assert!(!frames
            .iter()
            .any(|f| matches!(f, Frame::WorkspaceRequest { .. })));
        assert!(receive
            .await
            .unwrap()
            .unwrap_err()
            .contains("assignment_catalog_v1"));
        let mut negotiated = DeliveryLink {
            assignment_catalog_enabled: true,
            ..Default::default()
        };
        let reply = incoming(&hub, "old", &text, &mut negotiated)
            .await
            .unwrap()
            .unwrap();
        let Frame::WorkspaceResponse {
            value: Some(value),
            error: None,
            ..
        } = reply
        else {
            panic!("expected catalog response")
        };
        assert_eq!(value["execution_host"], "old");
        assert_eq!(value["home_hub"], hub.node_id());
        assert_eq!(value["items"], serde_json::json!([]));
    }
    #[tokio::test]
    async fn verification_archive_requires_negotiation_before_send_or_receive() {
        let (hub, _ctx, _root) = fixture();
        let request = super::super::operation_relay::Request {
            operation_id: "op".into(),
            worker_session: "worker".into(),
            command: None,
            accounting: Some(super::super::accounting_relay::Accounting {
                attempt: 1,
                action: super::super::accounting_relay::Action::VerificationComplete {
                    sequence: 1,
                    record_hash: "a".repeat(64),
                },
            }),
        };
        let frame = Frame::OperationRequest {
            id: "archive".into(),
            request: request.clone(),
        };
        let mut delivery = DeliveryLink {
            operation_enabled: true,
            ..Default::default()
        };
        assert!(incoming(
            &hub,
            "old",
            &serde_json::to_string(&frame).unwrap(),
            &mut delivery
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("Verification archive not negotiated"));
        let (send, receive) = tokio::sync::oneshot::channel();
        hub.operation_pending.lock().insert(
            "archive".into(),
            super::super::operation_relay::Pending {
                node: "old".into(),
                request,
                sent: false,
                result: send,
            },
        );
        let frames = delivery.frames(&hub, "old", &mut HashMap::new()).unwrap();
        assert!(!frames
            .iter()
            .any(|f| matches!(f, Frame::OperationRequest { .. })));
        assert!(receive
            .await
            .unwrap()
            .unwrap_err()
            .contains("operation_verification_archive_v1"));
    }
    #[tokio::test]
    async fn assignment_archive_requires_negotiation_before_send_or_receive() {
        let (hub, _ctx, _root) = fixture();
        let request = super::super::operation_relay::Request {
            operation_id: "op".into(),
            worker_session: "worker".into(),
            command: None,
            accounting: Some(super::super::accounting_relay::Accounting {
                attempt: 1,
                action: super::super::accounting_relay::Action::AssignmentArchiveRead {
                    sequence: 1,
                    assignment_id: "assignment".into(),
                    offset: None,
                },
            }),
        };
        let frame = Frame::OperationRequest {
            id: "archive".into(),
            request: request.clone(),
        };
        let mut delivery = DeliveryLink {
            operation_enabled: true,
            ..Default::default()
        };
        assert!(incoming(
            &hub,
            "old",
            &serde_json::to_string(&frame).unwrap(),
            &mut delivery
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("Assignment archive not negotiated"));
        let (send, receive) = tokio::sync::oneshot::channel();
        hub.operation_pending.lock().insert(
            "archive".into(),
            super::super::operation_relay::Pending {
                node: "old".into(),
                request,
                sent: false,
                result: send,
            },
        );
        let frames = delivery.frames(&hub, "old", &mut HashMap::new()).unwrap();
        assert!(!frames
            .iter()
            .any(|f| matches!(f, Frame::OperationRequest { .. })));
        assert!(receive
            .await
            .unwrap()
            .unwrap_err()
            .contains("operation_assignment_archive_v1"));
    }
    #[tokio::test]
    async fn assignment_workspace_requires_negotiation_before_send_or_receive() {
        let (hub, _ctx, _root) = fixture();
        let request = super::super::operation_relay::Request {
            operation_id: "op".into(),
            worker_session: "worker".into(),
            command: None,
            accounting: Some(super::super::accounting_relay::Accounting {
                attempt: 1,
                action: super::super::accounting_relay::Action::AssignmentWorkspaceReceipt {
                    assignment_id: "assignment".into(),
                    receipt: super::super::assignment_workspace::Receipt {
                        request_id: "receipt".into(),
                        expected_revision: 1,
                        input_hash: "a".repeat(64),
                        source_stage: "source".into(),
                        output: "artifact".into(),
                        sequence: 1,
                        snapshot_hash: "b".repeat(64),
                        archive_hash: "c".repeat(64),
                        root: "/fixture/snapshot".into(),
                    },
                },
            }),
        };
        let frame = Frame::OperationRequest {
            id: "archive".into(),
            request: request.clone(),
        };
        let mut delivery = DeliveryLink {
            operation_enabled: true,
            ..Default::default()
        };
        assert!(incoming(
            &hub,
            "old",
            &serde_json::to_string(&frame).unwrap(),
            &mut delivery
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("Assignment workspace not negotiated"));
        let (send, receive) = tokio::sync::oneshot::channel();
        hub.operation_pending.lock().insert(
            "archive".into(),
            super::super::operation_relay::Pending {
                node: "old".into(),
                request,
                sent: false,
                result: send,
            },
        );
        let frames = delivery.frames(&hub, "old", &mut HashMap::new()).unwrap();
        assert!(!frames
            .iter()
            .any(|f| matches!(f, Frame::OperationRequest { .. })));
        assert!(receive
            .await
            .unwrap()
            .unwrap_err()
            .contains("operation_assignment_workspace_v1"));
    }
    #[tokio::test]
    async fn task_worktree_prepare_and_scope_require_their_own_negotiated_feature() {
        let (hub, _ctx, _root) = fixture();
        for kind in ["assignment_task_workspace_prepare", "assignment_task_workspace"] {
            let mut receipt = serde_json::json!({"request_id":"prepare","expected_revision":1,
                "input_hash":"a".repeat(64),"context_hash":"b".repeat(64),"authorization_hash":"c".repeat(64),
                "stage_attempt":1,"operation":{"id":"op","attempt":1,"epoch":1},"repository_binding":"source",
                "workspace":{"key":"d".repeat(64),"repository":"/fixture/repository","common_dir":"/fixture/repository/.git",
                    "root":"/fixture/task","branch":"kode/task-test","base_commit":"e".repeat(40)}});
            if kind == "assignment_task_workspace" { receipt["starting_snapshot"] = serde_json::json!({"basis":"git_base","snapshot_hash":"f".repeat(64)}); }
            let request = super::super::operation_relay::Request {
                operation_id: "op".into(), worker_session: "worker".into(), command: None,
                accounting: Some(serde_json::from_value(serde_json::json!({"attempt":1,
                    "action":{"kind":kind,"assignment_id":"assignment","receipt":receipt}})).unwrap()),
            };
            let mut delivery = DeliveryLink { operation_enabled: true, assignment_workspace_enabled: true, ..Default::default() };
            let frame = Frame::OperationRequest { id: kind.into(), request: request.clone() };
            assert!(incoming(&hub, "old", &serde_json::to_string(&frame).unwrap(), &mut delivery).await
                .unwrap_err().to_string().contains("Assignment task worktree not negotiated"));
            let (send, receive) = tokio::sync::oneshot::channel();
            hub.operation_pending.lock().insert(kind.into(), super::super::operation_relay::Pending {
                node: "old".into(), request, sent: false, result: send,
            });
            assert!(!delivery.frames(&hub, "old", &mut HashMap::new()).unwrap().iter().any(|frame| matches!(frame, Frame::OperationRequest { .. })));
            assert!(receive.await.unwrap().unwrap_err().contains("operation_assignment_task_workspace_v1"));
        }
    }
}
