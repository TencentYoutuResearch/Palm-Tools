//! Opt-in durable session messaging. No Tauri dependencies and no PTY byte-path changes.
//! `KODE_MESSAGING_CONFIG` selects a JSON config; disabled bridges behave as before.
mod api;
pub mod agents;
mod codebuddy_registry;
mod link;
mod peers;
pub mod model;
mod ssh;
pub use ssh::SshConfig;
pub use ssh::Tunnel as SshTunnel;
mod store;
mod session_catalog;
mod transcript;
pub mod workspaces;
pub mod server;
#[cfg(test)]
mod tests;
use anyhow::{bail, Result};
use model::*;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
};
use store::Store;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub node_id: String,
    pub database: PathBuf,
    #[serde(default)]
    pub peers: Vec<Peer>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Peer {
    pub node_id: String,
    /// Same per-link secret on both nodes; never exposed to agents or browsers.
    pub link_token: String,
    /// Only the initiating node needs a URL. The peer can send over the accepted link.
    pub url: Option<String>,
    pub ssh: Option<ssh::SshConfig>,
}

pub struct Hub {
    store: Store,
    config: Config,
    peers: Mutex<Vec<Peer>>,
    ctx: Weak<crate::Ctx>,
    gate: Mutex<()>,
    remote: Mutex<HashMap<String, Vec<SessionInfo>>>,
    native: Mutex<HashMap<String, crate::SessionId>>,
    workspace_pending: Mutex<HashMap<String, (String, workspaces::Command, tokio::sync::oneshot::Sender<std::result::Result<serde_json::Value, String>>)>>,
    boot: String,
    stopped: AtomicBool,
}
impl Hub {
    pub fn open(config: Config, ctx: &Arc<crate::Ctx>) -> Result<Arc<Self>> {
        let mut names = std::collections::HashSet::new();
        for p in &config.peers {
            if !valid_id(&p.node_id)
                || p.node_id == config.node_id
                || !names.insert(&p.node_id)
                || p.link_token.len() < 32
            {
                bail!("invalid peer identity or link token (minimum 32 bytes)")
            }
            if let Some(url) = &p.url {
                link::validate_url(url)?;
            }
            if let Some(ssh) = &p.ssh {
                ssh.validate()?;
                if p.url.is_some() {
                    bail!("peer must choose url or ssh")
                }
            }
        }
        let store = Store::open(&config.database, &config.node_id)?;
        let peers = peers::load(&store, &config)?;
        let hub = Arc::new(Self {
            store,
            config,
            peers: Mutex::new(peers),
            ctx: Arc::downgrade(ctx),
            gate: Mutex::new(()),
            remote: Mutex::new(HashMap::new()),
            native: Mutex::new(HashMap::new()),
            workspace_pending: Mutex::new(HashMap::new()),
            boot: uuid::Uuid::new_v4().to_string(),
            stopped: AtomicBool::new(false),
        });
        agents::initialize(&hub)?;
        Ok(hub)
    }
    pub fn start(self: &Arc<Self>) {
        let hub = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
            while !hub.stopped.load(Ordering::Relaxed) {
                interval.tick().await;
                if let Err(e) = hub.tick().await {
                    tracing::warn!(error=%e,"messaging dispatch failed");
                }
            }
        });
        for peer in self
            .peers()
            .iter()
            .filter(|p| p.url.is_some() || p.ssh.is_some())
        {
            link::connect(self.clone(), peer.clone());
        }
    }
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
    pub fn node_id(&self) -> &str {
        &self.config.node_id
    }
    pub fn router(self: &Arc<Self>) -> axum::Router {
        api::router(self.clone())
    }
    async fn workspace(self: &Arc<Self>, node: &str, command: workspaces::Command) -> Result<serde_json::Value> {
        if node == self.node_id() || node.is_empty() { return workspaces::execute(self.clone(), command).await }
        if !self.peers().iter().any(|peer| peer.node_id == node) { bail!("unknown workspace execution node") }
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = tokio::sync::oneshot::channel();
        { let mut pending = self.workspace_pending.lock(); if pending.len() >= 32 { bail!("too many workspace requests") }; pending.insert(id.clone(), (node.into(), command, send)); }
        struct Cleanup<'a>(&'a Hub, String);
        impl Drop for Cleanup<'_> { fn drop(&mut self) { self.0.workspace_pending.lock().remove(&self.1); } }
        let _cleanup = Cleanup(self,id.clone());
        let response = tokio::time::timeout(std::time::Duration::from_secs(15), receive).await;
        self.workspace_pending.lock().remove(&id);
        match response { Ok(Ok(Ok(value))) => Ok(value), Ok(Ok(Err(error))) => bail!(error), _ => bail!("workspace node is unavailable; no local directory fallback") }
    }
    fn directory(&self) -> Result<Vec<SessionInfo>> {
        let mut all = self.store.sessions()?;
        for sessions in self.remote.lock().values() {
            all.extend(sessions.clone());
        }
        Ok(all)
    }
    fn send(&self, source: &str, req: SendRequest) -> Result<Message> {
        let _guard = self.gate.lock();
        if !valid_id(&req.target.node_id)
            || !valid_id(&req.target.session_id)
            || !valid_id(&req.idempotency_key)
            || req.content.trim().is_empty()
            || req.content.len() > MAX_CONTENT_BYTES
            || !(1..=86400).contains(&req.ttl_seconds)
        {
            bail!("invalid message, idempotency key or ttl")
        }
        if !self
            .store
            .sessions()?
            .iter()
            .any(|s| s.address.session_id == source)
        {
            bail!("unknown source session")
        }
        if req.target.node_id != self.node_id()
            && !self
                .peers()
                .iter()
                .any(|p| p.node_id == req.target.node_id)
        {
            bail!("unknown peer")
        }
        let mut hop_count = 0;
        if let Some(reply) = &req.in_reply_to {
            let original = self
                .store
                .get(reply)?
                .ok_or_else(|| anyhow::anyhow!("unknown request"))?;
            if original.target
                != (Address {
                    node_id: self.node_id().into(),
                    session_id: source.into(),
                })
                || original.source != req.target
            {
                bail!("reply does not match request participants")
            }
            hop_count = original.hop_count + 1;
            if hop_count > 8 {
                bail!("reply chain limit reached; start a new explicit request")
            }
        }
        let local = req.target.node_id == self.node_id();
        if local
            && !self
                .store
                .sessions()?
                .iter()
                .any(|s| s.address == req.target)
        {
            bail!("unknown target session")
        }
        let m = Message {
            id: uuid::Uuid::new_v4().to_string(),
            source: Address {
                node_id: self.node_id().into(),
                session_id: source.into(),
            },
            target: req.target,
            content: req.content,
            idempotency_key: req.idempotency_key,
            in_reply_to: req.in_reply_to,
            hop_count,
            created_at: now(),
            expires_at: now() + req.ttl_seconds * 1000,
            status: if local {
                Status::Received
            } else {
                Status::Queued
            },
            detail: None,
        };
        self.store.insert(m)
    }
    fn receive(&self, peer: &str, mut m: Message) -> Result<Message> {
        let _guard = self.gate.lock();
        if m.source.node_id != peer
            || m.target.node_id != self.node_id()
            || !valid_id(&m.id)
            || !valid_id(&m.source.session_id)
            || !valid_id(&m.target.session_id)
            || !valid_id(&m.idempotency_key)
            || m.content.trim().is_empty()
            || m.content.len() > MAX_CONTENT_BYTES
            || m.hop_count > 8
            || m.expires_at.saturating_sub(m.created_at) > 86400 * 1000
        {
            bail!("invalid peer message")
        }
        if !self.store.sessions()?.iter().any(|s| s.address == m.target) {
            bail!("unknown target session")
        }
        m.status = if m.expires_at <= now() {
            Status::Expired
        } else {
            Status::Received
        };
        m.detail = None;
        self.store.insert(m)
    }
    fn receipt(&self, peer: &str, id: &str, status: Status, detail: Option<String>) -> Result<()> {
        let _guard = self.gate.lock();
        let mut m = self
            .store
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("unknown receipt"))?;
        if m.source.node_id != self.node_id()
            || m.target.node_id != peer
            || detail.as_ref().is_some_and(|s| s.len() > 1024)
        {
            bail!("invalid receipt authority")
        }
        if m.status.terminal()
            && !(m.status == Status::Uncertain && status.terminal() && status != Status::Uncertain)
        {
            return Ok(());
        }
        let rank = |s: &Status| match s {
            Status::Queued => 0,
            Status::Received => 1,
            Status::Delivering => 2,
            _ => 3,
        };
        if rank(&status) < rank(&m.status) || m.status == status {
            return Ok(());
        }
        m.status = status;
        m.detail = detail;
        self.store.save(&m)
    }
    fn claim(&self, session: &str) -> Result<Vec<Message>> {
        let _guard = self.gate.lock();
        self.store.heartbeat(session)?;
        let mut pending = Vec::new();
        for mut m in self.store.messages()? {
            if m.target.node_id == self.node_id()
                && m.target.session_id == session
                && m.status == Status::Received
            {
                if m.expires_at <= now() {
                    m.status = Status::Expired;
                    self.store.save(&m)?;
                    continue;
                }
                // Persist before handing work to another process. No blind redelivery.
                m.status = Status::Delivering;
                self.store.save(&m)?;
                pending.push(m);
                break;
            }
        }
        Ok(pending)
    }
    fn settle(
        &self,
        session: &str,
        id: &str,
        status: Status,
        detail: Option<String>,
    ) -> Result<Message> {
        let _guard = self.gate.lock();
        let mut m = self
            .store
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("unknown message"))?;
        if m.target.node_id != self.node_id()
            || m.target.session_id != session
            || !matches!(
                status,
                Status::Accepted | Status::Uncertain | Status::Rejected
            )
            || detail.as_ref().is_some_and(|s| s.len() > 1024)
        {
            bail!("invalid settlement")
        }
        if m.status == status {
            return Ok(m);
        }
        if m.status != Status::Delivering {
            bail!("message is not claimed")
        }
        m.status = status;
        m.detail = detail;
        self.store.save(&m)?;
        Ok(m)
    }
    async fn tick(&self) -> Result<()> {
        let Some(ctx) = self.ctx.upgrade() else {
            self.shutdown();
            return Ok(());
        };
        // Existing PTY/ACP sessions stay owned by their original runtime.
        let rows: Vec<_> = ctx
            .sessions
            .lock()
            .iter()
            .map(|(id, s)| {
                (
                    *id,
                    s.state.title.clone(),
                    s.session_id.clone(),
                    s.state.status,
                    s.backend_key.clone(),
                    s.pty.is_some(),
                    s.launch_config.clone(),
                    s.cwd.clone(),
                    s.state.model.clone(),
                )
            })
            .collect();
        let live_ids: std::collections::HashSet<_> = rows.iter().map(|row| row.0).collect();
        let removed: Vec<_> = self
            .native
            .lock()
            .iter()
            .filter(|(_, id)| !live_ids.contains(id))
            .map(|(key, _)| key.clone())
            .collect();
        for old in removed {
            self.native.lock().remove(&old);
            self.store.offline(&old)?;
        }
        for (id, title, uuid, status, backend_key, has_pty, config, cwd, model) in rows {
            if let Some(thread_id)=uuid.as_ref() {
                let _gate=self.gate.lock();
                agents::change(self,agents::Change::Bind{key:backend_key.clone(),thread_id:thread_id.clone(),config,cwd:cwd.to_string_lossy().into(),title:title.clone(),model:Some(model)})?;
            }
            // A backend config key is an independent identity, even when two CLI
            // installations happen to expose the same native session UUID.
            let sid = uuid
                .map(|u| format!("kode:{backend_key}:{u}"))
                .filter(|s| valid_id(s))
                .unwrap_or_else(|| format!("kode:{}:{id}", self.boot));
            let replaced: Vec<_> = self
                .native
                .lock()
                .iter()
                .filter(|(key, runtime_id)| **runtime_id == id && *key != &sid)
                .map(|(key, _)| key.clone())
                .collect();
            for old in replaced {
                self.native.lock().remove(&old);
                self.store.offline(&old)?;
            }
            self.native.lock().insert(sid.clone(), id);
            let token = self.store.db_token(&sid)?;
            let registration = self.store.register(RegisterRequest {
                session_id: sid.clone(),
                title,
                runtime: "kode".into(),
                owner_token: token,
            })?;
            if matches!(status, kode_core::session::state::Status::Exited(_)) {
                self.store.offline(&sid)?;
                continue;
            }
            if status != kode_core::session::state::Status::Idle
                || (!has_pty && ctx.acp.get(id).is_none())
                || crate::pending_interaction(&ctx, id).is_some()
            {
                continue;
            }
            if let Some(m) = self.claim(&sid)?.first() {
                let text = format!(
                    "[Session message {} from {}/{}]\n{}",
                    m.id, m.source.node_id, m.source.session_id, m.content
                );
                match crate::submit_text_input(&ctx, id, &text).await {
                    Ok(()) => {
                        self.settle(
                            &sid,
                            &m.id,
                            Status::Accepted,
                            Some("submitted to runtime; processing is not confirmed".into()),
                        )?;
                    }
                    Err(_) => {
                        self.settle(
                            &sid,
                            &m.id,
                            Status::Uncertain,
                            Some("runtime submission failed; do not automatically retry".into()),
                        )?;
                    }
                }
            }
            let _ = registration;
        }
        let _guard = self.gate.lock();
        let online: std::collections::HashSet<_> = self
            .store
            .sessions()?
            .into_iter()
            .filter(|s| s.online)
            .map(|s| s.address.session_id)
            .collect();
        for mut m in self.store.messages()? {
            if m.target.node_id == self.node_id()
                && m.status == Status::Delivering
                && !online.contains(&m.target.session_id)
            {
                m.status = Status::Uncertain;
                m.detail = Some("runtime owner lease expired during submission".into());
                self.store.save(&m)?;
            }
            if m.expires_at <= now() {
                if m.target.node_id == self.node_id() && m.status == Status::Received {
                    m.status = Status::Expired;
                    self.store.save(&m)?;
                } else if m.source.node_id == self.node_id()
                    && m.target.node_id != self.node_id()
                    && m.status == Status::Queued
                {
                    m.status = Status::Uncertain;
                    m.detail = Some(
                        "deadline elapsed without a target receipt; delivery may have occurred"
                            .into(),
                    );
                    self.store.save(&m)?;
                }
            }
        }
        Ok(())
    }
}

pub fn configured_router(ctx: &Arc<crate::Ctx>) -> Result<axum::Router> {
    let Some(path) = std::env::var_os("KODE_MESSAGING_CONFIG") else {
        return Ok(axum::Router::new());
    };
    let config: Config = serde_json::from_slice(&std::fs::read(path)?)?;
    let hub = Hub::open(config, ctx)?;
    hub.start();
    Ok(hub.router())
}
