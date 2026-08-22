//! Outbound-only centralized session synchronization for the GUI.
//!
//! The server never dials this process. A one-time QR claim enables upload;
//! before that the agent connection carries only registration/heartbeats.

use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};
use uuid::Uuid;

const MAX_COMMAND_RECEIPTS: usize = 512;

#[derive(Debug, Clone, Serialize)]
pub struct CloudSyncStatus {
    pub server_url: String,
    pub device_id: Option<String>,
    pub active_backend_id: Option<String>,
    pub backends: Vec<CloudBackendSummary>,
    pub state: String,
    pub connected: bool,
    pub sync_enabled: bool,
    pub binding_count: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CloudBackendSummary {
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub remote_port: Option<u16>,
    pub managed: bool,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommandReceipt {
    id: String,
    status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CloudBackendConfig {
    id: String,
    name: String,
    server_url: String,
    #[serde(default)]
    ssh_host: Option<String>,
    #[serde(default)]
    ssh_port: Option<u16>,
    #[serde(default)]
    remote_port: Option<u16>,
    #[serde(default)]
    managed: bool,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    device_token: Option<String>,
    #[serde(default)]
    command_receipts: VecDeque<CommandReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CloudSyncConfig {
    installation_id: String,
    #[serde(default)]
    active_backend_id: Option<String>,
    #[serde(default)]
    backends: Vec<CloudBackendConfig>,
    // Legacy single-backend fields. They are read once and migrated into
    // `backends`, then omitted from subsequent writes.
    #[serde(default, skip_serializing)]
    server_url: Option<String>,
    #[serde(default, skip_serializing)]
    device_id: Option<String>,
    #[serde(default, skip_serializing)]
    device_token: Option<String>,
    #[serde(default)]
    #[serde(skip_serializing)]
    command_receipts: VecDeque<CommandReceipt>,
}

impl Default for CloudSyncConfig {
    fn default() -> Self {
        Self {
            installation_id: Uuid::new_v4().to_string(),
            active_backend_id: None,
            backends: Vec::new(),
            server_url: None,
            device_id: None,
            device_token: None,
            command_receipts: VecDeque::new(),
        }
    }
}

impl CloudSyncConfig {
    fn active_backend(&self) -> Option<&CloudBackendConfig> {
        let id = self.active_backend_id.as_deref()?;
        self.backends.iter().find(|backend| backend.id == id)
    }

    fn active_backend_mut(&mut self) -> Option<&mut CloudBackendConfig> {
        let id = self.active_backend_id.clone()?;
        self.backends.iter_mut().find(|backend| backend.id == id)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CloudPairingPayload {
    pub pairing_id: String,
    pub secret: String,
    pub uri: String,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct CloudSyncManager {
    inner: Arc<Inner>,
}

struct Inner {
    ctx: Arc<kode_bridge::Ctx>,
    config_path: PathBuf,
    config: Mutex<CloudSyncConfig>,
    status: Mutex<CloudSyncStatus>,
    generation: AtomicU64,
    boot_id: String,
    client: reqwest::Client,
}

impl CloudSyncManager {
    pub fn new(ctx: Arc<kode_bridge::Ctx>) -> Self {
        let config_path = config_path();
        let mut config = load_config(&config_path).unwrap_or_default();
        migrate_legacy_backend(&mut config);
        let default_server = std::env::var("KODE_SYNC_SERVER_URL")
            .ok()
            .map(|value| value.trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "http://127.0.0.1:8787".into());
        let active = config.active_backend().cloned();
        let status = CloudSyncStatus {
            server_url: active
                .as_ref()
                .map(|backend| backend.server_url.clone())
                .unwrap_or(default_server),
            device_id: active
                .as_ref()
                .and_then(|backend| backend.device_id.clone()),
            active_backend_id: active.as_ref().map(|backend| backend.id.clone()),
            backends: backend_summaries(&config),
            state: if active.is_some() {
                "offline".into()
            } else {
                "not_configured".into()
            },
            connected: false,
            sync_enabled: false,
            binding_count: 0,
            last_error: None,
        };
        Self {
            inner: Arc::new(Inner {
                ctx,
                config_path,
                config: Mutex::new(config),
                status: Mutex::new(status),
                generation: AtomicU64::new(0),
                boot_id: Uuid::new_v4().to_string(),
                client: reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(8))
                    .timeout(Duration::from_secs(15))
                    .build()
                    .expect("cloud sync HTTP client"),
            }),
        }
    }

    pub fn start_saved(&self) {
        if self.inner.config.lock().active_backend().is_some() {
            self.restart_agent();
        }
    }

    pub fn status(&self) -> CloudSyncStatus {
        let mut status = self.inner.status.lock().clone();
        let config = self.inner.config.lock();
        status.backends = backend_summaries(&config);
        status.active_backend_id = config.active_backend_id.clone();
        status
    }

    pub fn activate_backend(&self, backend_id: &str) -> Result<CloudSyncStatus, String> {
        {
            let mut config = self.inner.config.lock();
            if !config
                .backends
                .iter()
                .any(|backend| backend.id == backend_id)
            {
                return Err("cloud sync backend was not found".into());
            }
            config.active_backend_id = Some(backend_id.to_string());
            save_config(&self.inner.config_path, &config)?;
        }
        self.reset_status_for_active_backend();
        self.restart_agent();
        Ok(self.status())
    }

    pub fn upsert_managed_backend(
        &self,
        name: String,
        server_url: String,
        ssh_host: String,
        ssh_port: u16,
        remote_port: u16,
    ) -> Result<CloudBackendSummary, String> {
        let server_url = normalize_server_url(&server_url)?;
        let id = {
            let mut config = self.inner.config.lock();
            let existing_id = config
                .backends
                .iter()
                .find(|backend| {
                    backend.server_url == server_url
                        || backend.ssh_host.as_deref() == Some(ssh_host.as_str())
                })
                .map(|backend| backend.id.clone());
            let id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
            if let Some(backend) = config.backends.iter_mut().find(|backend| backend.id == id) {
                backend.name = name;
                backend.server_url = server_url.clone();
                backend.ssh_host = Some(ssh_host);
                backend.ssh_port = Some(ssh_port);
                backend.remote_port = Some(remote_port);
                backend.managed = true;
            } else {
                config.backends.push(CloudBackendConfig {
                    id: id.clone(),
                    name,
                    server_url: server_url.clone(),
                    ssh_host: Some(ssh_host),
                    ssh_port: Some(ssh_port),
                    remote_port: Some(remote_port),
                    managed: true,
                    device_id: None,
                    device_token: None,
                    command_receipts: VecDeque::new(),
                });
            }
            config.active_backend_id = Some(id.clone());
            save_config(&self.inner.config_path, &config)?;
            id
        };
        self.reset_status_for_active_backend();
        let config = self.inner.config.lock();
        backend_summaries(&config)
            .into_iter()
            .find(|backend| backend.id == id)
            .ok_or_else(|| "deployed backend was not saved".into())
    }

    fn reset_status_for_active_backend(&self) {
        let config = self.inner.config.lock();
        let active = config.active_backend();
        let mut status = self.inner.status.lock();
        status.server_url = active
            .map(|backend| backend.server_url.clone())
            .unwrap_or_default();
        status.device_id = active.and_then(|backend| backend.device_id.clone());
        status.active_backend_id = active.map(|backend| backend.id.clone());
        status.backends = backend_summaries(&config);
        status.state = if active.is_some() {
            "connecting".into()
        } else {
            "not_configured".into()
        };
        status.connected = false;
        status.sync_enabled = false;
        status.binding_count = 0;
        status.last_error = None;
    }

    pub async fn configure_and_create_pairing(
        &self,
        server_url: String,
    ) -> Result<CloudPairingPayload, String> {
        let server_url = normalize_server_url(&server_url)?;
        let switched = {
            let mut config = self.inner.config.lock();
            let backend_id = match config
                .backends
                .iter()
                .find(|backend| backend.server_url == server_url)
            {
                Some(backend) => backend.id.clone(),
                None => {
                    let id = Uuid::new_v4().to_string();
                    config.backends.push(CloudBackendConfig {
                        id: id.clone(),
                        name: backend_name_from_url(&server_url),
                        server_url: server_url.clone(),
                        ssh_host: None,
                        ssh_port: None,
                        remote_port: None,
                        managed: false,
                        device_id: None,
                        device_token: None,
                        command_receipts: VecDeque::new(),
                    });
                    id
                }
            };
            let switched = config.active_backend_id.as_deref() != Some(backend_id.as_str());
            config.active_backend_id = Some(backend_id);
            save_config(&self.inner.config_path, &config)?;
            switched
        };
        self.reset_status_for_active_backend();

        let registration = self.ensure_registered().await?;
        if switched || !self.inner.status.lock().connected {
            self.restart_agent();
        }
        let response = self
            .inner
            .client
            .post(format!(
                "{}/api/v1/devices/{}/pairings",
                server_url, registration.device_id
            ))
            .bearer_auth(&registration.device_token)
            .json(&json!({
                "scopes": ["sessions.read", "sessions.content.read", "sessions.send"]
            }))
            .send()
            .await
            .map_err(friendly_network_error)?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        let pairing = response
            .json::<CloudPairingPayload>()
            .await
            .map_err(|error| format!("invalid pairing response: {error}"))?;
        Ok(pairing)
    }

    fn restart_agent(&self) {
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.run_agent_loop(generation).await;
        });
    }

    async fn ensure_registered(&self) -> Result<Registration, String> {
        let snapshot = self.inner.config.lock().clone();
        let backend = snapshot
            .active_backend()
            .cloned()
            .ok_or_else(|| "cloud sync server is not configured".to_string())?;
        let server_url = backend.server_url.clone();
        let response = self
            .inner
            .client
            .post(format!("{server_url}/api/v1/devices/register"))
            .json(&json!({
                "installation_id": snapshot.installation_id,
                "name": desktop_name(),
                "device_token": backend.device_token,
            }))
            .send()
            .await
            .map_err(friendly_network_error)?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        let registration = response
            .json::<Registration>()
            .await
            .map_err(|error| format!("invalid registration response: {error}"))?;
        {
            let mut config = self.inner.config.lock();
            let current = config
                .backends
                .iter_mut()
                .find(|candidate| candidate.id == backend.id)
                .ok_or_else(|| "cloud sync backend changed during registration".to_string())?;
            current.device_id = Some(registration.device_id.clone());
            current.device_token = Some(registration.device_token.clone());
            save_config(&self.inner.config_path, &config)?;
        }
        self.inner.status.lock().device_id = Some(registration.device_id.clone());
        Ok(registration)
    }

    async fn run_agent_loop(&self, generation: u64) {
        let mut backoff = Duration::from_secs(1);
        loop {
            if self.inner.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            match self.run_agent_once(generation).await {
                Ok(()) => {}
                Err(error) => {
                    let mut status = self.inner.status.lock();
                    status.state = "offline".into();
                    status.connected = false;
                    status.sync_enabled = false;
                    status.last_error = Some(error.clone());
                    tracing::warn!(%error, "cloud sync agent disconnected");
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    async fn run_agent_once(&self, generation: u64) -> Result<(), String> {
        let registration = self.ensure_registered().await?;
        if self.inner.generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        let server_url = self
            .inner
            .config
            .lock()
            .active_backend()
            .map(|backend| backend.server_url.clone())
            .ok_or_else(|| "cloud sync server is not configured".to_string())?;
        let ws_url = websocket_url(&format!(
            "{server_url}/api/v1/agent/ws?device_id={}",
            url::form_urlencoded::byte_serialize(registration.device_id.as_bytes())
                .collect::<String>()
        ))?;
        let mut request = ws_url
            .into_client_request()
            .map_err(|error| format!("invalid WebSocket request: {error}"))?;
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {}", registration.device_token))
                .map_err(|_| "invalid device token".to_string())?,
        );
        {
            let mut status = self.inner.status.lock();
            status.state = "connecting".into();
            status.last_error = None;
        }
        let (mut socket, _) = connect_async(request)
            .await
            .map_err(|error| format!("WebSocket connect failed: {error}"))?;
        {
            let mut status = self.inner.status.lock();
            status.connected = true;
            status.state = "waiting_for_pairing".into();
            status.last_error = None;
        }
        let mut sync_enabled = false;
        let mut snapshotted_session_ids = HashSet::new();
        let mut events = self.inner.ctx.bus.subscribe();
        let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            if self.inner.generation.load(Ordering::SeqCst) != generation {
                let _ = socket.close(None).await;
                return Ok(());
            }
            tokio::select! {
                inbound = socket.next() => {
                    let Some(inbound) = inbound else { return Err("server closed the WebSocket".into()); };
                    let inbound = inbound.map_err(|error| format!("WebSocket receive failed: {error}"))?;
                    match inbound {
                        Message::Text(raw) => {
                            let frame: ServerFrame = serde_json::from_str(&raw)
                                .map_err(|error| format!("invalid server frame: {error}"))?;
                            match frame {
                                ServerFrame::Hello { sync_enabled: enabled, binding_count } => {
                                    sync_enabled = enabled;
                                    self.set_binding_status(enabled, binding_count);
                                    if enabled {
                                        snapshotted_session_ids =
                                            self.send_snapshot_and_history(&mut socket).await?;
                                    } else {
                                        snapshotted_session_ids.clear();
                                    }
                                }
                                ServerFrame::PairingBound { binding_count } => {
                                    sync_enabled = true;
                                    self.set_binding_status(true, binding_count);
                                    snapshotted_session_ids =
                                        self.send_snapshot_and_history(&mut socket).await?;
                                }
                                ServerFrame::BindingChanged { sync_enabled: enabled, binding_count } => {
                                    sync_enabled = enabled;
                                    self.set_binding_status(enabled, binding_count);
                                    if enabled {
                                        snapshotted_session_ids =
                                            self.send_snapshot_and_history(&mut socket).await?;
                                    } else {
                                        snapshotted_session_ids.clear();
                                    }
                                }
                                ServerFrame::Command { command_id, local_session_id, kind, payload, expires_at } => {
                                    self.handle_command(
                                        &mut socket,
                                        command_id,
                                        local_session_id,
                                        kind,
                                        payload,
                                        expires_at,
                                    ).await?;
                                }
                                ServerFrame::Pong => {}
                            }
                        }
                        Message::Ping(value) => socket.send(Message::Pong(value)).await
                            .map_err(|error| format!("WebSocket pong failed: {error}"))?,
                        Message::Close(_) => return Err("server closed the WebSocket".into()),
                        _ => {}
                    }
                }
                event = events.recv(), if sync_enabled => {
                    match event {
                        Ok(event) => {
                            // A session may be created after the connection's initial hello.
                            // Refresh the snapshot before its first event so the center can
                            // allocate the cloud session id before persisting that event.
                            if !snapshotted_session_ids.contains(&event.session_id) {
                                snapshotted_session_ids = self.send_snapshot(&mut socket).await?;
                            }
                            if snapshotted_session_ids.contains(&event.session_id) {
                                self.send_event(&mut socket, event).await?;
                            } else {
                                tracing::debug!(
                                    local_session_id = event.session_id,
                                    "cloud sync skipped event for a session absent from the snapshot"
                                );
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            snapshotted_session_ids =
                                self.send_snapshot_and_history(&mut socket).await?;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            return Err("local event bus closed".into());
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    send_json(&mut socket, &json!({"type":"ping"})).await?;
                }
            }
        }
    }

    fn set_binding_status(&self, enabled: bool, binding_count: u64) {
        let mut status = self.inner.status.lock();
        status.connected = true;
        status.sync_enabled = enabled;
        status.binding_count = binding_count;
        status.state = if enabled {
            "syncing"
        } else {
            "waiting_for_pairing"
        }
        .into();
        status.last_error = None;
    }

    async fn send_snapshot<S>(&self, socket: &mut S) -> Result<HashSet<u64>, String>
    where
        S: SinkExt<Message> + Unpin,
        S::Error: std::fmt::Display,
    {
        let sessions = session_snapshots(&self.inner.ctx);
        let session_ids = snapshot_session_ids(&sessions);
        send_json(
            socket,
            &json!({
                "type": "hello",
                "boot_id": self.inner.boot_id,
                "sessions": sessions,
            }),
        )
        .await?;
        Ok(session_ids)
    }

    async fn send_snapshot_and_history<S>(&self, socket: &mut S) -> Result<HashSet<u64>, String>
    where
        S: SinkExt<Message> + Unpin,
        S::Error: std::fmt::Display,
    {
        // Derive replay ids from the exact snapshot sent above. Reading the live
        // session map a second time races with session creation and can replay an
        // event for an id the center has never seen.
        let session_ids = self.send_snapshot(socket).await?;
        for id in &session_ids {
            for event in self.inner.ctx.bus.history_for(*id, 0, 1000) {
                self.send_event(socket, event).await?;
            }
        }
        Ok(session_ids)
    }

    async fn send_event<S>(
        &self,
        socket: &mut S,
        event: kode_bridge::EventEnvelope,
    ) -> Result<(), String>
    where
        S: SinkExt<Message> + Unpin,
        S::Error: std::fmt::Display,
    {
        // Raw terminal frames are high-volume transport data and are not part
        // of the mobile semantic timeline. Sending them can crowd real
        // messages out of bounded history pages and overload the mobile WS.
        if matches!(event.r#type.as_str(), "pty_bytes" | "shell.pty_bytes") {
            return Ok(());
        }
        send_json(
            socket,
            &json!({
                "type": "event",
                "boot_id": self.inner.boot_id,
                "local_session_id": event.session_id,
                "event": event,
            }),
        )
        .await
    }

    async fn handle_command<S>(
        &self,
        socket: &mut S,
        command_id: String,
        local_session_id: u64,
        kind: String,
        payload: Value,
        expires_at: u64,
    ) -> Result<(), String>
    where
        S: SinkExt<Message> + Unpin,
        S::Error: std::fmt::Display,
    {
        if expires_at < now_ms() {
            return self
                .send_command_result(socket, &command_id, "expired", Some("command expired"))
                .await;
        }
        let prior_receipt = {
            let config = self.inner.config.lock();
            config
                .active_backend()
                .and_then(|backend| {
                    backend
                        .command_receipts
                        .iter()
                        .find(|receipt| receipt.id == command_id)
                })
                .cloned()
        };
        if let Some(receipt) = prior_receipt {
            let (status, error) = if receipt.status == "executed" {
                ("executed", None)
            } else {
                (
                    "failed",
                    Some("previous execution outcome unknown; command was not replayed"),
                )
            };
            return self
                .send_command_result(socket, &command_id, status, error)
                .await;
        }

        self.record_command(&command_id, "accepted")?;
        self.send_command_result(socket, &command_id, "accepted", None)
            .await?;
        let result = match kind.as_str() {
            "input" => payload
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "input command is missing text".to_string())
                .and_then(|text| {
                    kode_bridge::submit_text_input(&self.inner.ctx, local_session_id, text)
                        .map_err(|error| error.to_string())
                }),
            "answer" => match payload.get("choice_index").and_then(Value::as_u64) {
                Some(choice) => {
                    let submit = payload
                        .get("submit")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    kode_bridge::submit_answer(
                        &self.inner.ctx,
                        local_session_id,
                        choice as u32,
                        submit,
                    )
                    .await
                    .map_err(|error| error.to_string())
                }
                None => Err("answer command is missing choice_index".into()),
            },
            "plan_response" => payload
                .get("accept")
                .and_then(Value::as_bool)
                .ok_or_else(|| "plan response command is missing accept".to_string())
                .and_then(|accept| {
                    kode_bridge::submit_plan_response(&self.inner.ctx, local_session_id, accept)
                        .map_err(|error| error.to_string())
                }),
            "mode" => match payload.get("mode").and_then(Value::as_str) {
                Some(mode) => kode_bridge::set_session_permission_mode(
                    &self.inner.ctx,
                    local_session_id,
                    mode,
                )
                .await
                .map(|_| ()),
                None => Err("mode command is missing mode".into()),
            },
            _ => Err(format!("unsupported cloud command: {kind}")),
        };
        match result {
            Ok(()) => {
                self.record_command(&command_id, "executed")?;
                self.send_command_result(socket, &command_id, "executed", None)
                    .await
            }
            Err(error) => {
                self.record_command(&command_id, "failed")?;
                self.send_command_result(socket, &command_id, "failed", Some(&error))
                    .await
            }
        }
    }

    async fn send_command_result<S>(
        &self,
        socket: &mut S,
        command_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), String>
    where
        S: SinkExt<Message> + Unpin,
        S::Error: std::fmt::Display,
    {
        send_json(
            socket,
            &json!({
                "type": "command.result",
                "command_id": command_id,
                "status": status,
                "error": error,
            }),
        )
        .await
    }

    fn record_command(&self, command_id: &str, status: &str) -> Result<(), String> {
        let mut config = self.inner.config.lock();
        let receipts = &mut config
            .active_backend_mut()
            .ok_or_else(|| "cloud sync server is not configured".to_string())?
            .command_receipts;
        if let Some(receipt) = receipts.iter_mut().find(|receipt| receipt.id == command_id) {
            receipt.status = status.into();
        } else {
            receipts.push_back(CommandReceipt {
                id: command_id.into(),
                status: status.into(),
            });
        }
        while receipts.len() > MAX_COMMAND_RECEIPTS {
            receipts.pop_front();
        }
        save_config(&self.inner.config_path, &config)
    }
}

#[derive(Debug, Deserialize)]
struct Registration {
    device_id: String,
    device_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ServerFrame {
    #[serde(rename = "server.hello")]
    Hello {
        sync_enabled: bool,
        binding_count: u64,
    },
    #[serde(rename = "pairing.bound")]
    PairingBound { binding_count: u64 },
    #[serde(rename = "binding.changed")]
    BindingChanged {
        sync_enabled: bool,
        binding_count: u64,
    },
    #[serde(rename = "command")]
    Command {
        command_id: String,
        local_session_id: u64,
        kind: String,
        payload: Value,
        expires_at: u64,
    },
    #[serde(rename = "pong")]
    Pong,
}

#[tauri::command]
pub fn cloud_sync_status(manager: State<'_, CloudSyncManager>) -> CloudSyncStatus {
    manager.status()
}

#[tauri::command]
pub async fn cloud_sync_create_pairing(
    manager: State<'_, CloudSyncManager>,
    server_url: String,
) -> Result<CloudPairingPayload, String> {
    manager.configure_and_create_pairing(server_url).await
}

#[tauri::command]
pub fn cloud_sync_activate_backend(
    manager: State<'_, CloudSyncManager>,
    backend_id: String,
) -> Result<CloudSyncStatus, String> {
    manager.activate_backend(&backend_id)
}

fn session_snapshots(ctx: &kode_bridge::Ctx) -> Vec<Value> {
    ctx.sessions
        .lock()
        .values()
        .filter(|session| {
            !matches!(
                session.state.status,
                kode_core::session::state::Status::Exited(_)
            )
        })
        .map(|session| {
            let status = match session.state.status {
                kode_core::session::state::Status::Starting => "starting",
                kode_core::session::state::Status::Idle => "idle",
                kode_core::session::state::Status::Busy => "busy",
                kode_core::session::state::Status::Exited(_) => "exited",
            };
            json!({
                "local_id": session.id,
                "dto": {
                    "id": session.id,
                    "backend_key": session.backend_key,
                    "title": session.state.title,
                    "model": session.state.model,
                    "status": status,
                    "cwd": session.cwd.to_string_lossy(),
                    "session_uuid": session.session_id,
                    "tokens": {
                        "total": session.state.tokens.unwrap_or(0),
                        "input": session.state.tokens_input.unwrap_or(0),
                        "output": session.state.tokens_output.unwrap_or(0),
                        "cached": session.state.tokens_cached.unwrap_or(0),
                    },
                    "context_pct": Value::Null,
                    "cost_usd": session.state.cost_usd,
                }
            })
        })
        .collect()
}

fn snapshot_session_ids(sessions: &[Value]) -> HashSet<u64> {
    sessions
        .iter()
        .filter_map(|session| session.get("local_id").and_then(Value::as_u64))
        .collect()
}

async fn send_json<S>(socket: &mut S, value: &Value) -> Result<(), String>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    socket
        .send(Message::Text(value.to_string()))
        .await
        .map_err(|error| format!("WebSocket send failed: {error}"))
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("kode")
        .join("cloud-sync.json")
}

fn load_config(path: &Path) -> Option<CloudSyncConfig> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn migrate_legacy_backend(config: &mut CloudSyncConfig) {
    if config.backends.is_empty() {
        if let Some(server_url) = config.server_url.take() {
            let id = Uuid::new_v4().to_string();
            config.backends.push(CloudBackendConfig {
                id: id.clone(),
                name: backend_name_from_url(&server_url),
                server_url,
                ssh_host: None,
                ssh_port: None,
                remote_port: None,
                managed: false,
                device_id: config.device_id.take(),
                device_token: config.device_token.take(),
                command_receipts: std::mem::take(&mut config.command_receipts),
            });
            config.active_backend_id = Some(id);
        }
    }
    if config
        .active_backend_id
        .as_ref()
        .is_some_and(|id| !config.backends.iter().any(|backend| &backend.id == id))
    {
        config.active_backend_id = config.backends.first().map(|backend| backend.id.clone());
    }
    if config.active_backend_id.is_none() {
        config.active_backend_id = config.backends.first().map(|backend| backend.id.clone());
    }
}

fn backend_summaries(config: &CloudSyncConfig) -> Vec<CloudBackendSummary> {
    config
        .backends
        .iter()
        .map(|backend| CloudBackendSummary {
            id: backend.id.clone(),
            name: backend.name.clone(),
            server_url: backend.server_url.clone(),
            ssh_host: backend.ssh_host.clone(),
            ssh_port: backend.ssh_port,
            remote_port: backend.remote_port,
            managed: backend.managed,
            active: config.active_backend_id.as_deref() == Some(backend.id.as_str()),
        })
        .collect()
}

fn backend_name_from_url(server_url: &str) -> String {
    url::Url::parse(server_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "Cloud sync".into())
}

fn save_config(path: &Path, config: &CloudSyncConfig) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid cloud sync config path".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create cloud sync config directory: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("serialize cloud sync config: {error}"))?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|error| format!("open cloud sync config: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("write cloud sync config: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync cloud sync config: {error}"))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, bytes).map_err(|error| format!("write cloud sync config: {error}"))?;
    std::fs::rename(&tmp, path).map_err(|error| format!("install cloud sync config: {error}"))
}

pub(crate) fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let parsed =
        url::Url::parse(trimmed).map_err(|error| format!("invalid server URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("server URL must be an http(s) origin".into());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("server URL cannot include query or fragment".into());
    }
    if parsed.path() != "/" {
        return Err("server URL must be an origin without a path".into());
    }
    Ok(trimmed.into())
}

fn websocket_url(http_url: &str) -> Result<String, String> {
    let mut url =
        url::Url::parse(http_url).map_err(|error| format!("invalid server URL: {error}"))?;
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => return Err("server URL must use http or https".into()),
    };
    url.set_scheme(scheme)
        .map_err(|_| "could not build WebSocket URL".to_string())?;
    Ok(url.to_string())
}

fn desktop_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Kode Desktop".into())
}

fn friendly_network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "cloud sync server timed out".into()
    } else if error.is_connect() {
        "cannot connect to cloud sync server".into()
    } else {
        format!("cloud sync request failed: {error}")
    }
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let detail = response
        .json::<Value>()
        .await
        .ok()
        .and_then(|value| {
            value
                .get("detail")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "request rejected".into());
    format!("cloud sync server returned {status}: {detail}")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_converts_server_urls() {
        assert_eq!(
            normalize_server_url("https://sync.example.com/").unwrap(),
            "https://sync.example.com"
        );
        assert_eq!(
            websocket_url("https://sync.example.com/api/v1/agent/ws").unwrap(),
            "wss://sync.example.com/api/v1/agent/ws"
        );
        assert!(normalize_server_url("file:///tmp/server").is_err());
        assert!(normalize_server_url("https://sync.example.com/api").is_err());
    }

    #[test]
    fn snapshot_ids_come_from_the_exact_payload() {
        let sessions = vec![
            json!({"local_id": 7, "dto": {}}),
            json!({"local_id": 9, "dto": {}}),
            json!({"dto": {}}),
        ];
        assert_eq!(snapshot_session_ids(&sessions), HashSet::from([7, 9]));
    }

    #[test]
    fn migrates_legacy_single_backend_without_losing_credentials() {
        let mut config = CloudSyncConfig {
            installation_id: "install-1".into(),
            active_backend_id: None,
            backends: Vec::new(),
            server_url: Some("https://sync.example.com".into()),
            device_id: Some("device-1".into()),
            device_token: Some("secret-token".into()),
            command_receipts: VecDeque::from([CommandReceipt {
                id: "command-1".into(),
                status: "executed".into(),
            }]),
        };

        migrate_legacy_backend(&mut config);

        let backend = config.active_backend().expect("migrated backend");
        assert_eq!(backend.server_url, "https://sync.example.com");
        assert_eq!(backend.device_id.as_deref(), Some("device-1"));
        assert_eq!(backend.device_token.as_deref(), Some("secret-token"));
        assert_eq!(backend.command_receipts.len(), 1);
    }

    #[test]
    fn backend_summaries_mark_only_the_active_backend() {
        let mut config = CloudSyncConfig::default();
        config.backends = vec![
            CloudBackendConfig {
                id: "one".into(),
                name: "One".into(),
                server_url: "https://one.example.com".into(),
                ssh_host: Some("one".into()),
                ssh_port: Some(22),
                remote_port: Some(8787),
                managed: true,
                device_id: None,
                device_token: None,
                command_receipts: VecDeque::new(),
            },
            CloudBackendConfig {
                id: "two".into(),
                name: "Two".into(),
                server_url: "https://two.example.com".into(),
                ssh_host: None,
                ssh_port: None,
                remote_port: None,
                managed: false,
                device_id: None,
                device_token: None,
                command_receipts: VecDeque::new(),
            },
        ];
        config.active_backend_id = Some("two".into());

        let summaries = backend_summaries(&config);
        assert!(!summaries[0].active);
        assert!(summaries[1].active);
        assert!(summaries[0].managed);
    }
}
