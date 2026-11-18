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
            let result = super::workspaces::execute(hub.clone(), command).await;
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
const CANCEL_FEATURE: &str = "input_cancellation_v1";
const DELIVERY_FEATURE: &str = "delivery_observations_v1";
#[derive(Default)]
struct DeliveryLink {
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
        let mut frames = frames(hub, peer, sent)?;
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
        features: vec![DELIVERY_FEATURE.into(), CANCEL_FEATURE.into()],
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
    }
    hub.remember_cancel_peer(peer, delivery.cancel_enabled)?;
    let mut sent = HashMap::new();
    let mut last_seen = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if hub.stopped.load(Ordering::Relaxed) || !hub.peer_allowed(peer, token){break}
                if last_seen.elapsed()>Duration::from_secs(15){bail!("peer heartbeat timed out")} for f in delivery.frames(hub,peer,&mut sent)? {tokio::time::timeout(Duration::from_secs(10),socket.send(AxMessage::Text(super::wire::encode(&f, version)?))).await??;}}
            msg=socket.recv()=>match msg {
                Some(Ok(AxMessage::Text(text)))=>{if !hub.peer_allowed(peer,token){break} last_seen=Instant::now();if let Some(f)=incoming(hub,peer,&text,&mut delivery).await? {tokio::time::timeout(Duration::from_secs(10),socket.send(AxMessage::Text(super::wire::encode(&f, version)?))).await??;}},
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
    }
    hub.remember_cancel_peer(&peer.node_id, delivery.cancel_enabled)?;
    let mut sent = HashMap::new();
    let mut last_seen = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if hub.stopped.load(Ordering::Relaxed) || !hub.peer_allowed(&peer.node_id, &peer.link_token){break}
                if last_seen.elapsed()>Duration::from_secs(15){bail!("peer heartbeat timed out")} for f in delivery.frames(hub,&peer.node_id,&mut sent)? {tokio::time::timeout(Duration::from_secs(10),socket.send(TungMessage::Text(super::wire::encode(&f, version)?))).await??;}}
            msg=socket.next()=>match msg {
                Some(Ok(TungMessage::Text(text)))=>{if !hub.peer_allowed(&peer.node_id,&peer.link_token){break} last_seen=Instant::now();if let Some(f)=incoming(hub,&peer.node_id,&text,&mut delivery).await? {tokio::time::timeout(Duration::from_secs(10),socket.send(TungMessage::Text(super::wire::encode(&f, version)?))).await??;}},
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
            [DELIVERY_FEATURE, CANCEL_FEATURE,]
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
                    [DELIVERY_FEATURE, CANCEL_FEATURE,]
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
}
