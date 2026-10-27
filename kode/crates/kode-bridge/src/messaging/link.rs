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
fn initial(hub: &Hub) -> Frame {
    Frame::Hello {
        node_id: hub.node_id().into(),
        version: 1,
    }
}
fn frames(hub: &Hub, peer: &str, sent: &mut HashMap<String, Status>) -> Result<Vec<Frame>> {
    let mut out = vec![Frame::Directory {
        sessions: hub.store.sessions()?,
    }];
    for (id, (node, command, _)) in hub.workspace_pending.lock().iter() {
        if node == peer { out.push(Frame::WorkspaceRequest { id: id.clone(), command: command.clone() }); }
    }
    for m in hub.store.messages()? {
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
async fn incoming(hub: &Arc<Hub>, peer: &str, text: &str) -> Result<Option<Frame>> {
    if text.len() > 128 * 1024 {
        bail!("peer frame too large")
    }
    match serde_json::from_str::<Frame>(text)? {
        Frame::WorkspaceRequest { id, command } => {
            if !valid_id(&id) { bail!("invalid workspace request") }
            let result = super::workspaces::execute(hub.clone(), command).await;
            Ok(Some(match result { Ok(value) => Frame::WorkspaceResponse { id, value: Some(value), error: None }, Err(error) => Frame::WorkspaceResponse { id, value: None, error: Some(error.to_string()) } }))
        }
        Frame::WorkspaceResponse { id, value, error } => {
            let mut pending = hub.workspace_pending.lock();
            if pending.get(&id).is_some_and(|(node,_,_)| node == peer) {
                if let Some((_,_,send)) = pending.remove(&id) { let _ = send.send(match (value,error) { (Some(value),None) => Ok(value), (_,Some(error)) => Err(error), _ => Err("invalid workspace response".into()) }); }
            }
            Ok(None)
        }
        Frame::Hello { .. } => bail!("unexpected hello"),
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
fn hello(text: &str, peer: &str) -> Result<()> {
    match serde_json::from_str::<Frame>(text)? {
        Frame::Hello {
            node_id,
            version: 1,
        } if node_id == peer => Ok(()),
        _ => bail!("peer identity/protocol mismatch"),
    }
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
    let allowed = hub
        .config
        .peers
        .iter()
        .any(|p| p.node_id == peer && crate::constant_eq(&p.link_token, token));
    if !allowed {
        return Err(Error(StatusCode::UNAUTHORIZED, "unauthorized peer".into()));
    }
    let peer = peer.to_string();
    Ok(ws
        .max_message_size(128 * 1024)
        .max_frame_size(128 * 1024)
        .on_upgrade(move |socket| async move {
            if let Err(e) = serve(&hub, &peer, socket).await {
                tracing::debug!(error=%e,"messaging peer disconnected");
            }
            disconnected(&hub, &peer);
        }))
}
async fn serve(hub: &Arc<Hub>, peer: &str, mut socket: WebSocket) -> Result<()> {
    socket
        .send(AxMessage::Text(serde_json::to_string(&initial(hub))?))
        .await?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await?
        .ok_or_else(|| anyhow::anyhow!("missing hello"))??;
    let AxMessage::Text(text) = first else {
        bail!("expected hello")
    };
    hello(&text, peer)?;
    let mut sent = HashMap::new();
    let mut last_seen = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if hub.stopped.load(Ordering::Relaxed){break}
                if last_seen.elapsed()>Duration::from_secs(15){bail!("peer heartbeat timed out")} for f in frames(hub,peer,&mut sent)? {tokio::time::timeout(Duration::from_secs(10),socket.send(AxMessage::Text(serde_json::to_string(&f)?))).await??;}}
            msg=socket.recv()=>match msg {
                Some(Ok(AxMessage::Text(text)))=>{last_seen=Instant::now();if let Some(f)=incoming(hub,peer,&text).await? {tokio::time::timeout(Duration::from_secs(10),socket.send(AxMessage::Text(serde_json::to_string(&f)?))).await??;}},
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
        while !hub.stopped.load(Ordering::Relaxed) {
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
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await??;
    socket
        .send(TungMessage::Text(serde_json::to_string(&initial(hub))?))
        .await?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await?
        .ok_or_else(|| anyhow::anyhow!("missing hello"))??;
    let TungMessage::Text(text) = first else {
        bail!("expected hello")
    };
    hello(&text, &peer.node_id)?;
    let mut sent = HashMap::new();
    let mut last_seen = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if hub.stopped.load(Ordering::Relaxed){break}
                if last_seen.elapsed()>Duration::from_secs(15){bail!("peer heartbeat timed out")} for f in frames(hub,&peer.node_id,&mut sent)? {tokio::time::timeout(Duration::from_secs(10),socket.send(TungMessage::Text(serde_json::to_string(&f)?))).await??;}}
            msg=socket.next()=>match msg {
                Some(Ok(TungMessage::Text(text)))=>{last_seen=Instant::now();if let Some(f)=incoming(hub,&peer.node_id,&text).await? {tokio::time::timeout(Duration::from_secs(10),socket.send(TungMessage::Text(serde_json::to_string(&f)?))).await??;}},
                Some(Ok(TungMessage::Ping(b)))=>socket.send(TungMessage::Pong(b)).await?,
                Some(Ok(TungMessage::Pong(_)))=>{},
                _=>break,
            }
        }
    }
    Ok(())
}
