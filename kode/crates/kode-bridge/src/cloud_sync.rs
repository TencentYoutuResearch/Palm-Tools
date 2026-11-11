//! Outbound-only centralized session synchronization for the GUI.
//!
//! The server never dials this process. A one-time QR claim enables upload;
//! before that the agent connection carries only registration/heartbeats.
//! Account-relay backends skip registration and pairing: the desktop signs in
//! with its owner's account and uploads only while a phone is viewing it.

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
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};
use kode_relay_protocol::ServerFrame;
use uuid::Uuid;

use crate::account::{
    AccountClient, AccountSession, LoginMethod, LoginMethodInfo, PalmHandoff, PalmxPending, PalmxStatus,
    PendingSignIn,
};

const MAX_COMMAND_RECEIPTS: usize = 512;
/// A connection that stayed up this long resets the reconnect backoff, so a
/// relay closing an expiring token's socket is followed by a quick reconnect.
const STABLE_CONNECTION: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    #[serde(default)]
    pub account_email: Option<String>,
    /// Display label of the active account: name, else address, else a
    /// short account id.
    #[serde(default)]
    pub account_label: Option<String>,
    #[serde(default)]
    pub account_method: Option<LoginMethod>,
    #[serde(default)]
    pub account_name: Option<String>,
    /// HTTPS avatar URL from the account profile.
    #[serde(default)]
    pub account_picture: Option<String>,
}

/// Why a PalmX QR is on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PalmxPurpose {
    SignIn,
    /// Link the palm to the signed-in account.
    Bind,
}

/// What the PalmX dialog shows. `done` means the purpose was fulfilled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PalmxProgress {
    pub state: String,
    pub qr_payload: String,
    pub expires_at: u64,
    pub done: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    /// A user-deployed kode-sync-server paired by QR code.
    #[default]
    SelfHosted,
    /// The multi-account kode-relay; identity comes from an account sign-in.
    AccountRelay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudBackendSummary {
    pub id: String,
    pub name: String,
    pub server_url: String,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub remote_port: Option<u16>,
    pub deployment_kind: Option<String>,
    pub remote_deploy_dir: Option<String>,
    pub managed: bool,
    pub active: bool,
    pub kind: BackendKind,
    pub account_email: Option<String>,
    pub account_label: Option<String>,
    pub account_method: Option<LoginMethod>,
    pub account_picture: Option<String>,
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
    deployment_kind: Option<String>,
    #[serde(default)]
    remote_deploy_dir: Option<String>,
    #[serde(default)]
    managed: bool,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    device_token: Option<String>,
    #[serde(default)]
    command_receipts: VecDeque<CommandReceipt>,
    #[serde(default)]
    kind: BackendKind,
    #[serde(default)]
    account: Option<AccountSession>,
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

#[doc(hidden)]
pub struct Inner {
    ctx: Arc<crate::Ctx>,
    config_path: PathBuf,
    config: Mutex<CloudSyncConfig>,
    status: Mutex<CloudSyncStatus>,
    generation: AtomicU64,
    boot_id: String,
    client: reqwest::Client,
    account: AccountClient,
    pending_sign_in: Mutex<Option<PendingSignIn>>,
    pending_palmx: tokio::sync::Mutex<Option<(PalmxPending, PalmxPurpose)>>,
    pending_palm: tokio::sync::Mutex<Option<PalmHandoff>>,
    /// CloudBase rotates refresh tokens: a second refresh with the same
    /// token fails and signs the account out. One refresh at a time, and
    /// each re-reads the saved session first.
    refresh_lock: tokio::sync::Mutex<()>,
}

impl CloudSyncManager {
    pub fn new(ctx: Arc<crate::Ctx>) -> Self {
        let mut shared = ctx.cloud_sync.lock();
        if let Some(inner) = shared.upgrade() {
            return Self { inner };
        }
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
            account_email: None,
            account_label: None,
            account_method: None,
            account_name: None,
            account_picture: None,
        };
        // The installation id already names this desktop to the relay; it is
        // also its CloudBase device id so sign-ins never evict other devices.
        let account = AccountClient::for_device(config.installation_id.clone());
        let manager = Self {
            inner: Arc::new(Inner {
                ctx: ctx.clone(),
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
                account,
                pending_sign_in: Mutex::new(None),
                pending_palmx: tokio::sync::Mutex::new(None),
                pending_palm: tokio::sync::Mutex::new(None),
                refresh_lock: tokio::sync::Mutex::new(()),
            }),
        };
        *shared = Arc::downgrade(&manager.inner);
        manager
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
        apply_account(&mut status, config.active_backend().and_then(|backend| backend.account.as_ref()));
        status
    }

    pub async fn list_workers(&self) -> Result<Value, String> {
        let (server_url, token) = self.device_http_context()?;
        let response = self
            .inner
            .client
            .get(format!("{server_url}/api/v1/workers"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(friendly_network_error)?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        response
            .json::<Value>()
            .await
            .map_err(|error| format!("invalid Worker directory response: {error}"))
    }

    pub async fn worker_inventory(&self, worker_id: &str) -> Result<Value, String> {
        if !worker_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
        {
            return Err("invalid worker id".into());
        }
        let (server_url, token) = self.device_http_context()?;
        let worker = url::form_urlencoded::byte_serialize(worker_id.as_bytes()).collect::<String>();
        let response = self
            .inner
            .client
            .get(format!("{server_url}/api/v1/workers/{worker}/inventory"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(friendly_network_error)?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        response
            .json::<Value>()
            .await
            .map_err(|error| format!("invalid Worker inventory response: {error}"))
    }

    pub async fn worker_sessions(&self, worker_id: &str) -> Result<Value, String> {
        if !worker_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
        {
            return Err("invalid worker id".into());
        }
        let (server_url, token) = self.device_http_context()?;
        let worker = url::form_urlencoded::byte_serialize(worker_id.as_bytes()).collect::<String>();
        let response = self
            .inner
            .client
            .get(format!("{server_url}/api/v1/workers/{worker}/sessions"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(friendly_network_error)?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        response
            .json::<Value>()
            .await
            .map_err(|error| format!("invalid Worker session response: {error}"))
    }

    fn device_http_context(&self) -> Result<(String, String), String> {
        let config = self.inner.config.lock();
        let backend = config
            .active_backend()
            .ok_or_else(|| "cloud sync server is not configured".to_string())?;
        let token = backend
            .device_token
            .clone()
            .ok_or_else(|| "Worker is not registered with the sync server".to_string())?;
        Ok((backend.server_url.clone(), token))
    }

    /// Emails a sign-in code for the account relay at `server_url`.
    pub async fn account_send_code(&self, server_url: String, email: String) -> Result<u64, String> {
        let server_url = normalize_server_url(&server_url)?;
        let (pending, expires_in) = self.inner.account.send_code(&server_url, &email).await?;
        *self.inner.pending_sign_in.lock() = Some(pending);
        Ok(expires_in)
    }

    /// Completes sign-in with the emailed code and activates the relay.
    pub async fn account_sign_in(&self, code: String) -> Result<CloudSyncStatus, String> {
        let pending = self
            .inner
            .pending_sign_in
            .lock()
            .clone()
            .ok_or_else(|| "request a sign-in code first".to_string())?;
        let session = self.inner.account.sign_in(&pending, &code, now_ms()).await?;
        self.inner.pending_sign_in.lock().take();
        self.store_account_session(&pending.server_url, session)
    }

    /// Saves a signed-in session as the relay's account backend, makes it
    /// active and reconnects. Shared by every sign-in method.
    fn store_account_session(&self, server_url: &str, session: AccountSession) -> Result<CloudSyncStatus, String> {
        {
            let mut config = self.inner.config.lock();
            let existing = config
                .backends
                .iter()
                .find(|backend| backend.kind == BackendKind::AccountRelay && backend.server_url == server_url)
                .map(|backend| backend.id.clone());
            let id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
            let name = format!("Kode account · {}", session.label());
            if let Some(backend) = config.backends.iter_mut().find(|backend| backend.id == id) {
                // A different account on the same relay is a new identity; old
                // receipts belong to the previous one.
                if backend.account.as_ref().map(|a| &a.user_id) != Some(&session.user_id) {
                    backend.command_receipts.clear();
                }
                backend.name = name;
                backend.account = Some(session);
            } else {
                config.backends.push(CloudBackendConfig {
                    id: id.clone(),
                    name,
                    server_url: server_url.to_string(),
                    ssh_host: None,
                    ssh_port: None,
                    remote_port: None,
                    deployment_kind: None,
                    remote_deploy_dir: None,
                    managed: false,
                    device_id: None,
                    device_token: None,
                    command_receipts: VecDeque::new(),
                    kind: BackendKind::AccountRelay,
                    account: Some(session),
                });
            }
            config.active_backend_id = Some(id);
            save_config(&self.inner.config_path, &config)?;
        }
        self.reset_status_for_active_backend();
        self.restart_agent();
        Ok(self.status())
    }

    /// The saved account relay, whether or not it is the active backend.
    fn account_backend(&self) -> Option<CloudBackendConfig> {
        self.inner
            .config
            .lock()
            .backends
            .iter()
            .find(|backend| backend.kind == BackendKind::AccountRelay && backend.account.is_some())
            .cloned()
    }

    /// A fresh access token for the saved account, refreshing if needed.
    async fn account_token(&self) -> Result<(String, String), String> {
        let backend = self.account_backend().ok_or("sign in to a Kode account first")?;
        let session = self.fresh_session(&backend.id).await?;
        Ok((backend.server_url, session.access_token))
    }

    /// Relay URL, fresh access token and this desktop's own device id, for
    /// viewing the account's other devices.
    pub(crate) async fn account_viewer(&self) -> Result<(String, String, String), String> {
        let (server_url, token) = self.account_token().await?;
        Ok((server_url, token, self.inner.config.lock().installation_id.clone()))
    }

    /// The saved session of `backend_id`, refreshed when close to expiry.
    async fn fresh_session(&self, backend_id: &str) -> Result<AccountSession, String> {
        let saved = || {
            self.inner
                .config
                .lock()
                .backends
                .iter()
                .find(|b| b.id == backend_id)
                .and_then(|b| b.account.clone())
                .ok_or_else(|| "sign in to a Kode account first".to_string())
        };
        if !saved()?.needs_refresh(now_ms()) {
            return saved();
        }
        let _guard = self.inner.refresh_lock.lock().await;
        // The GUI and its workbench service are separate processes reading the
        // same config. Refresh tokens are single-use: two processes refreshing
        // together (e.g. both reconnecting after a network change) present the
        // same token and the provider revokes it. Serialize across processes
        // and adopt a session another process already saved.
        let _file_lock = lock_refresh(&self.inner.config_path).await?;
        self.adopt_saved_session(backend_id);
        let session = saved()?;
        if !session.needs_refresh(now_ms()) {
            return Ok(session);
        }
        let session = self.inner.account.refresh(&session, now_ms()).await?;
        let mut config = self.inner.config.lock();
        if let Some(current) = config.backends.iter_mut().find(|b| b.id == backend_id) {
            current.account = Some(session.clone());
        }
        save_config(&self.inner.config_path, &config)?;
        Ok(session)
    }

    /// Take the on-disk session for `backend_id` when another process has
    /// refreshed it since this one loaded the config.
    fn adopt_saved_session(&self, backend_id: &str) {
        let Some(disk) = load_config(&self.inner.config_path).and_then(|config| {
            config.backends.into_iter().find(|b| b.id == backend_id).and_then(|b| b.account)
        }) else {
            return;
        };
        let mut config = self.inner.config.lock();
        if let Some(current) = config.backends.iter_mut().find(|b| b.id == backend_id) {
            if let Some(mine) = current.account.as_ref() {
                if mine.user_id == disk.user_id && disk.expires_at > mine.expires_at {
                    current.account = Some(disk);
                }
            }
        }
    }

    pub async fn account_login_methods(&self, server_url: String) -> Result<Vec<LoginMethodInfo>, String> {
        let server_url = normalize_server_url(&server_url)?;
        self.inner.account.login_methods(&server_url).await
    }

    /// Shows a PalmX QR for signing in, or for linking a palm to the saved
    /// account (`server_url` is then the account's relay).
    pub async fn palmx_start(&self, server_url: Option<String>, purpose: PalmxPurpose) -> Result<PalmxProgress, String> {
        let server_url = match (purpose, server_url) {
            (PalmxPurpose::Bind, _) => self.account_token().await?.0,
            (PalmxPurpose::SignIn, Some(url)) => normalize_server_url(&url)?,
            (PalmxPurpose::SignIn, None) => return Err("enter the account relay URL".into()),
        };
        let pending = self.inner.account.palmx_start(&server_url).await?;
        let progress = PalmxProgress {
            state: "pending".into(),
            qr_payload: pending.qr_payload.clone(),
            expires_at: pending.expires_at,
            done: false,
        };
        *self.inner.pending_palmx.lock().await = Some((pending, purpose));
        Ok(progress)
    }

    /// Advances the PalmX flow one step; the dialog calls this every ~2 s.
    /// The lock serialises polls so a confirmed code is redeemed once.
    pub async fn palmx_poll(&self) -> Result<PalmxProgress, String> {
        let mut slot = self.inner.pending_palmx.lock().await;
        let (pending, purpose) = slot.clone().ok_or("start PalmX sign-in first")?;
        let progress = |state: &str, done: bool| PalmxProgress {
            state: state.into(),
            qr_payload: pending.qr_payload.clone(),
            expires_at: pending.expires_at,
            done,
        };
        let code = match self.inner.account.palmx_poll(&pending).await? {
            PalmxStatus::Pending => return Ok(progress("pending", false)),
            PalmxStatus::Scanned => return Ok(progress("scanned", false)),
            PalmxStatus::Denied => {
                *slot = None;
                return Ok(progress("denied", false));
            }
            PalmxStatus::Expired => {
                *slot = None;
                return Ok(progress("expired", false));
            }
            PalmxStatus::Confirmed { code } => code,
        };
        // The code is single-use whatever happens next.
        *slot = None;
        match purpose {
            PalmxPurpose::SignIn => {
                let session = self.inner.account.palmx_sign_in(&pending, &code, now_ms()).await?;
                self.store_account_session(&pending.server_url, session)?;
            }
            PalmxPurpose::Bind => {
                let (_, token) = self.account_token().await?;
                self.inner.account.palmx_bind(&pending, &code, &token).await?;
            }
        }
        Ok(progress("confirmed", true))
    }

    pub async fn palmx_cancel(&self) {
        self.inner.pending_palmx.lock().await.take();
    }

    /// Signs in with a palm capture run on this Mac.
    pub async fn palm_sign_in(&self, server_url: String, session_id: String) -> Result<CloudSyncStatus, String> {
        let server_url = normalize_server_url(&server_url)?;
        let session = self.inner.account.palm_sign_in(&server_url, &session_id, now_ms()).await?;
        self.store_account_session(&server_url, session)
    }

    /// Shows a `kode://palm-login` QR that a phone approves with a palm scan.
    pub async fn palm_handoff_start(&self, server_url: String) -> Result<PalmxProgress, String> {
        let server_url = normalize_server_url(&server_url)?;
        let handoff = self.inner.account.palm_handoff_start(&server_url, now_ms()).await?;
        let progress = PalmxProgress {
            state: "pending".into(),
            qr_payload: handoff.qr_payload.clone(),
            expires_at: handoff.expires_at,
            done: false,
        };
        *self.inner.pending_palm.lock().await = Some(handoff);
        Ok(progress)
    }

    /// The dialog calls this every ~2 s; the relay releases tokens once.
    pub async fn palm_handoff_poll(&self) -> Result<PalmxProgress, String> {
        let mut slot = self.inner.pending_palm.lock().await;
        let handoff = slot.clone().ok_or("start palm sign-in first")?;
        let progress = |state: &str, done: bool| PalmxProgress {
            state: state.into(),
            qr_payload: handoff.qr_payload.clone(),
            expires_at: handoff.expires_at,
            done,
        };
        if now_ms() / 1000 > handoff.expires_at {
            *slot = None;
            return Ok(progress("expired", false));
        }
        match self.inner.account.palm_handoff_poll(&handoff, now_ms()).await? {
            None => Ok(progress("pending", false)),
            Some(session) => {
                *slot = None;
                self.store_account_session(&handoff.server_url, session)?;
                Ok(progress("confirmed", true))
            }
        }
    }

    pub async fn palm_handoff_cancel(&self) {
        self.inner.pending_palm.lock().await.take();
    }

    /// Sign-in methods linked to the saved account (e.g. `["palmx"]`), plus
    /// `palm` when a palm is enrolled for Kode's own palm sign-in.
    pub async fn account_linked_methods(&self) -> Result<Vec<String>, String> {
        let (server_url, token) = self.account_token().await?;
        let mut linked = self.inner.account.linked_methods(&server_url, &token).await?;
        // Relays without palm answer 404; that just means "not enrolled".
        if self.inner.account.palm_enrolled(&server_url, &token).await.unwrap_or(false) {
            linked.push("palm".into());
        }
        Ok(linked)
    }

    /// Re-reads the account profile so names set on a phone show here.
    pub async fn account_profile(&self) -> Result<CloudSyncStatus, String> {
        self.account_token().await?;
        let backend = self.account_backend().ok_or("sign in to a Kode account first")?;
        let session = backend.account.clone().ok_or("sign in to a Kode account first")?;
        let session = self.inner.account.with_profile(session).await;
        self.save_account(&backend.id, session)
    }

    pub async fn account_set_name(&self, name: String) -> Result<CloudSyncStatus, String> {
        self.account_token().await?;
        let backend = self.account_backend().ok_or("sign in to a Kode account first")?;
        let session = backend.account.clone().ok_or("sign in to a Kode account first")?;
        let session = self.inner.account.set_name(&session, &name).await?;
        self.save_account(&backend.id, session)
    }

    /// Saves profile fields only: tokens may have rotated since `session`
    /// was read, and writing an old refresh token back would sign out.
    fn save_account(&self, backend_id: &str, session: AccountSession) -> Result<CloudSyncStatus, String> {
        {
            let mut config = self.inner.config.lock();
            if let Some(backend) = config.backends.iter_mut().find(|b| b.id == backend_id) {
                if let Some(current) = backend.account.as_mut() {
                    current.name = session.name;
                    current.picture = session.picture;
                    current.email = session.email;
                    backend.name = format!("Kode account · {}", current.label());
                }
            }
            save_config(&self.inner.config_path, &config)?;
        }
        Ok(self.status())
    }

    pub async fn palmx_unbind(&self) -> Result<(), String> {
        let (server_url, token) = self.account_token().await?;
        self.inner.account.palmx_unbind(&server_url, &token).await
    }

    /// Forgets the account backend. Another saved backend becomes active.
    pub fn account_sign_out(&self, backend_id: &str) -> Result<CloudSyncStatus, String> {
        let restart = {
            let mut config = self.inner.config.lock();
            let before = config.backends.len();
            config.backends.retain(|backend| {
                !(backend.id == backend_id && backend.kind == BackendKind::AccountRelay)
            });
            if config.backends.len() == before {
                return Err("account backend was not found".into());
            }
            if config.active_backend_id.as_deref() == Some(backend_id) {
                config.active_backend_id = config.backends.first().map(|backend| backend.id.clone());
            }
            save_config(&self.inner.config_path, &config)?;
            config.active_backend_id.is_some()
        };
        self.reset_status_for_active_backend();
        if restart {
            self.restart_agent();
        } else {
            // Stop the current loop without starting another.
            self.inner.generation.fetch_add(1, Ordering::SeqCst);
        }
        Ok(self.status())
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
        deployment_kind: String,
        remote_deploy_dir: Option<String>,
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
                backend.deployment_kind = Some(deployment_kind);
                backend.remote_deploy_dir = remote_deploy_dir;
                backend.managed = true;
            } else {
                config.backends.push(CloudBackendConfig {
                    id: id.clone(),
                    name,
                    server_url: server_url.clone(),
                    ssh_host: Some(ssh_host),
                    ssh_port: Some(ssh_port),
                    remote_port: Some(remote_port),
                    deployment_kind: Some(deployment_kind),
                    remote_deploy_dir,
                    managed: true,
                    device_id: None,
                    device_token: None,
                    command_receipts: VecDeque::new(),
                    kind: BackendKind::SelfHosted,
                    account: None,
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
        apply_account(&mut status, active.and_then(|backend| backend.account.as_ref()));
    }

    pub async fn configure_and_create_pairing(
        &self,
        server_url: String,
    ) -> Result<CloudPairingPayload, String> {
        let server_url = normalize_server_url(&server_url)?;
        let switched = {
            let mut config = self.inner.config.lock();
            if config.backends.iter().any(|backend| {
                backend.server_url == server_url && backend.kind == BackendKind::AccountRelay
            }) {
                return Err("account relays pair phones by signing in on the phone".into());
            }
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
                        deployment_kind: None,
                        remote_deploy_dir: None,
                        managed: false,
                        device_id: None,
                        device_token: None,
                        command_receipts: VecDeque::new(),
                        kind: BackendKind::SelfHosted,
                        account: None,
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
        tokio::spawn(async move {
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
            let started = tokio::time::Instant::now();
            let result = self.run_agent_once(generation).await;
            if started.elapsed() >= STABLE_CONNECTION {
                backoff = Duration::from_secs(1);
            }
            match result {
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

    /// Device id and bearer token for the agent socket. Self-hosted servers
    /// register the installation; account relays use the owner's token and
    /// name the desktop by its installation id.
    async fn agent_credentials(&self) -> Result<(String, String, BackendKind), String> {
        let (backend, installation_id) = {
            let config = self.inner.config.lock();
            let backend = config
                .active_backend()
                .cloned()
                .ok_or_else(|| "cloud sync server is not configured".to_string())?;
            (backend, config.installation_id.clone())
        };
        if backend.kind == BackendKind::SelfHosted {
            let registration = self.ensure_registered().await?;
            return Ok((registration.device_id, registration.device_token, backend.kind));
        }
        if backend.account.is_none() {
            return Err("sign in to the account relay first".into());
        }
        let session = self.fresh_session(&backend.id).await?;
        self.inner.status.lock().device_id = Some(installation_id.clone());
        Ok((installation_id, session.access_token, backend.kind))
    }

    async fn run_agent_once(&self, generation: u64) -> Result<(), String> {
        let (device_id, token, kind) = self.agent_credentials().await?;
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
        let encode = |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
        let mut agent_url = format!("{server_url}/api/v1/agent/ws?device_id={}", encode(&device_id));
        if kind == BackendKind::AccountRelay {
            agent_url.push_str(&format!("&name={}", encode(&host_name())));
        }
        let ws_url = websocket_url(&agent_url)?;
        let mut request = ws_url
            .into_client_request()
            .map_err(|error| format!("invalid WebSocket request: {error}"))?;
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {token}"))
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
            status.state = idle_state(kind).into();
            status.last_error = None;
        }
        self.send_metadata_hello(&mut socket).await?;
        let mut setup_tasks = futures_util::stream::FuturesUnordered::<
            tokio::task::JoinHandle<(String, u16, Value)>,
        >::new();
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
                Some(result) = setup_tasks.next(), if !setup_tasks.is_empty() => {
                    let (request_id, status, body) = result
                        .map_err(|error| format!("Desktop setup task failed: {error}"))?;
                    send_json(&mut socket, &json!({
                        "type": "setup.result", "request_id": request_id,
                        "boot_id": self.inner.boot_id, "status": status, "body": body,
                    })).await?;
                }
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
                                    self.set_binding_status(kind, enabled, binding_count);
                                    if enabled {
                                        snapshotted_session_ids =
                                            self.send_snapshot_and_history(&mut socket).await?;
                                    } else {
                                        snapshotted_session_ids.clear();
                                    }
                                }
                                ServerFrame::PairingBound { binding_count } => {
                                    sync_enabled = true;
                                    self.set_binding_status(kind, true, binding_count);
                                    snapshotted_session_ids =
                                        self.send_snapshot_and_history(&mut socket).await?;
                                }
                                ServerFrame::BindingChanged { sync_enabled: enabled, binding_count } => {
                                    sync_enabled = enabled;
                                    self.set_binding_status(kind, enabled, binding_count);
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
                                ServerFrame::SetupRequest { request_id, kind, payload, expires_at } => {
                                    if (!sync_enabled && kind != "worker_inventory")
                                        || expires_at <= now_ms()
                                        || setup_tasks.len() >= 8
                                    {
                                        send_json(&mut socket, &json!({
                                            "type":"setup.result", "request_id": request_id,
                                            "boot_id":self.inner.boot_id, "status":409,
                                            "body":{"error":"setup_unavailable", "detail":"Desktop is unavailable or busy; retry shortly"},
                                        })).await?;
                                        continue;
                                    }
                                    // Persist acceptance before spawning. An interrupted create is
                                    // uncertain and must never be replayed after a reconnect.
                                    if kind == "create_session" {
                                        let seen = self.inner.config.lock().active_backend()
                                            .is_some_and(|backend| backend.command_receipts.iter().any(|r| r.id == request_id));
                                        if seen {
                                            send_json(&mut socket, &json!({
                                                "type":"setup.result", "request_id":request_id,
                                                "boot_id":self.inner.boot_id, "status":504,
                                                "body":{"error":"creation_unconfirmed", "detail":"Creation was already accepted; inspect the session list"},
                                            })).await?;
                                            continue;
                                        }
                                        self.record_command(&request_id, "accepted")?;
                                    }
                                    let ctx = Arc::clone(&self.inner.ctx);
                                    setup_tasks.push(tokio::spawn(async move {
                                        let (status, body) = crate::mobile_setup::execute_hosted(ctx, &kind, payload).await;
                                        (request_id, status, body)
                                    }));
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
                    if sync_enabled {
                        snapshotted_session_ids = self.send_snapshot(&mut socket).await?;
                    }
                    send_json(&mut socket, &json!({"type":"ping"})).await?;
                }
            }
        }
    }

    fn set_binding_status(&self, kind: BackendKind, enabled: bool, binding_count: u64) {
        let mut status = self.inner.status.lock();
        status.connected = true;
        status.sync_enabled = enabled;
        status.binding_count = binding_count;
        status.state = if enabled { "syncing" } else { idle_state(kind) }.into();
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
                "kode_version": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "capabilities": crate::worker_inventory::worker_capabilities(),
            }),
        )
        .await?;
        Ok(session_ids)
    }

    async fn send_metadata_hello<S>(&self, socket: &mut S) -> Result<(), String>
    where
        S: SinkExt<Message> + Unpin,
        S::Error: std::fmt::Display,
    {
        send_json(
            socket,
            &json!({
                "type": "hello",
                "boot_id": self.inner.boot_id,
                "sessions": [],
                "kode_version": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "capabilities": crate::worker_inventory::worker_capabilities(),
            }),
        )
        .await
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
            for event in if self.inner.ctx.runtimes.contains(*id) {
                self.inner
                    .ctx
                    .runtimes
                    .history(*id, 0, 10000)
                    .map_err(|e| e.to_string())?
            } else {
                self.inner.ctx.bus.history_for(*id, 0, 1000)
            } {
                self.send_event(socket, event).await?;
            }
        }
        Ok(session_ids)
    }

    async fn send_event<S>(&self, socket: &mut S, event: crate::EventEnvelope) -> Result<(), String>
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
        let result = if self.inner.ctx.runtimes.contains(local_session_id) {
            self.inner
                .ctx
                .runtimes
                .command(local_session_id, &kind, payload.clone(), &command_id)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        } else {
            execute_local_command(&self.inner.ctx, local_session_id, &kind, payload).await
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

pub fn session_snapshots(ctx: &crate::Ctx) -> Vec<Value> {
    let mut snapshots: Vec<Value> = ctx
        .sessions
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
            let mut snapshot = json!({
                "local_id": session.id,
                "dto": {
                    "id": session.id,
                    "backend_key": session.backend_key,
                    "transport_kind": if session.args == ["--acp"] { "acp" } else { "pty" },
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
            });
            if let Some(fields) = crate::permission_snapshot(ctx, session).as_object() {
                snapshot["dto"].as_object_mut().unwrap().extend(fields.clone());
            }
            snapshot
        })
        .collect();
    snapshots.extend(
        ctx.runtimes
            .snapshots()
            .into_iter()
            .filter(|s| {
                s["dto"]["status"] != "exited"
                    && !(s["dto"]["runtime"] == "gui"
                        && s["dto"]["native_process_id"].as_u64().is_some()
                        && s["dto"]["owner_alive"] == false)
            }),
    );
    snapshots
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
    if let Some(path) = std::env::var_os("KODE_CLOUD_SYNC_CONFIG") {
        return PathBuf::from(path);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("kode")
        .join("cloud-sync.json")
}

/// Exclusive lock beside the config, held for one refresh. Released on drop.
async fn lock_refresh(config_path: &Path) -> Result<std::fs::File, String> {
    use fs2::FileExt;
    let path = config_path.with_extension("refresh.lock");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create refresh lock directory: {error}"))?;
    }
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("open refresh lock: {error}"))?;
        file.lock_exclusive().map_err(|error| format!("lock refresh: {error}"))?;
        Ok(file)
    })
    .await
    .map_err(|error| format!("refresh lock task failed: {error}"))?
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
                deployment_kind: None,
                remote_deploy_dir: None,
                managed: false,
                device_id: config.device_id.take(),
                device_token: config.device_token.take(),
                command_receipts: std::mem::take(&mut config.command_receipts),
                kind: BackendKind::SelfHosted,
                account: None,
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
            deployment_kind: backend.deployment_kind.clone(),
            remote_deploy_dir: backend.remote_deploy_dir.clone(),
            managed: backend.managed,
            active: config.active_backend_id.as_deref() == Some(backend.id.as_str()),
            kind: backend.kind,
            account_email: backend
                .account
                .as_ref()
                .map(|account| account.email.clone())
                .filter(|email| !email.is_empty()),
            account_label: backend.account.as_ref().map(AccountSession::label),
            account_method: backend.account.as_ref().map(|account| account.method),
            account_picture: backend
                .account
                .as_ref()
                .map(|account| account.picture.clone())
                .filter(|picture| !picture.is_empty()),
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

pub fn normalize_server_url(raw: &str) -> Result<String, String> {
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

fn apply_account(status: &mut CloudSyncStatus, account: Option<&AccountSession>) {
    status.account_email = account
        .map(|account| account.email.clone())
        .filter(|email| !email.is_empty());
    status.account_label = account.map(AccountSession::label);
    status.account_name = account.map(|account| account.name.clone()).filter(|name| !name.is_empty());
    status.account_picture = account
        .map(|account| account.picture.clone())
        .filter(|picture| !picture.is_empty());
    status.account_method = account.map(|account| account.method);
}

/// Status shown while connected but not uploading: self-hosted servers wait
/// for a QR pairing, account relays for a phone to open this desktop.
fn idle_state(kind: BackendKind) -> &'static str {
    match kind {
        BackendKind::SelfHosted => "waiting_for_pairing",
        BackendKind::AccountRelay => "standby",
    }
}

/// The machine's name for the account device list. GUI processes on macOS
/// usually lack `HOSTNAME`, so ask the OS.
fn host_name() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its full length and gethostname
        // NUL-terminates on success.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
        if ok {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..end]);
            let name = name.trim().trim_end_matches(".local");
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    desktop_name()
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

    /// Two managers stand in for the GUI and its workbench service: separate
    /// in-memory state over one config file. The mock issuer rotates refresh
    /// tokens and, like the real one, revokes a token presented twice.
    #[tokio::test]
    async fn processes_sharing_a_config_refresh_once() {
        use axum::{routing::post, Json, Router};
        use std::sync::atomic::AtomicUsize;
        let calls = Arc::new(AtomicUsize::new(0));
        let used = Arc::new(Mutex::new(std::collections::HashSet::<String>::new()));
        let app = Router::new().route("/auth/v1/token", post({
            let (calls, used) = (calls.clone(), used.clone());
            move |Json(body): Json<Value>| async move {
                let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                // Hold the response so a racing caller would overlap.
                tokio::time::sleep(Duration::from_millis(150)).await;
                let token = body["refresh_token"].as_str().unwrap_or_default().to_string();
                if !used.lock().insert(token) {
                    return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_grant"})));
                }
                (axum::http::StatusCode::OK, Json(json!({"access_token": format!("access-{n}"), "refresh_token": format!("refresh-{n}"), "expires_in": 7200})))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });

        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("cloud-sync.json");
        std::fs::write(&config_path, json!({
            "installation_id": "install-race",
            "active_backend_id": "acct",
            "backends": [{
                "id": "acct", "name": "Account", "server_url": "https://relay.example.com",
                "kind": "account_relay",
                "account": {"issuer": issuer, "email": "", "user_id": "alice",
                    "access_token": "expired", "refresh_token": "refresh-0", "expires_at": 1}
            }]
        }).to_string()).unwrap();
        std::env::set_var("KODE_CLOUD_SYNC_CONFIG", &config_path);
        let gui = CloudSyncManager::new(crate::build_test_ctx(kode_core::config::Config::default(), "race-gui".into()));
        let service = CloudSyncManager::new(crate::build_test_ctx(kode_core::config::Config::default(), "race-svc".into()));
        std::env::remove_var("KODE_CLOUD_SYNC_CONFIG");

        let (a, b) = tokio::join!(gui.fresh_session("acct"), service.fresh_session("acct"));
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "only one process may spend the refresh token");
        assert_eq!(a.access_token, "access-1");
        assert_eq!(b.access_token, "access-1");
        let disk = load_config(&config_path).unwrap();
        assert_eq!(disk.backends[0].account.as_ref().unwrap().refresh_token, "refresh-1");
    }

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

    #[cfg(unix)]
    #[tokio::test]
    async fn cloud_excludes_dead_gui_owners_but_keeps_offline_dsh_history() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = crate::build_test_ctx(Default::default(), "test".into());
        let path = dir.path().join("runtime.sqlite");
        ctx.runtimes.open(&path).unwrap();
        for (runtime, pid) in [("gui", i32::MAX as u64), ("dsh", 0)] {
            let input = serde_json::from_value(json!({
                "runtime": runtime, "boot_id": "test",
                "sessions": [{
                    "session_id": "history",
                    "dto": {"status": "idle", "native_process_id": pid},
                    "events": [{"key": "1", "kind": "message", "payload": {"text": "retained"}}]
                }]
            })).unwrap();
            ctx.runtimes.publish(&ctx, input).unwrap();
        }
        let db = rusqlite::Connection::open(path).unwrap();
        db.execute("UPDATE runtime_hosts SET seen=0", []).unwrap();
        let snapshots = session_snapshots(&ctx);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0]["dto"]["runtime"], "dsh");
        assert_eq!(snapshots[0]["dto"]["runtime_online"], false);
        let saved = ctx.runtimes.snapshots();
        assert_eq!(saved.len(), 2);
        for session in saved {
            assert_eq!(ctx.runtimes.history(session["local_id"].as_u64().unwrap(), 0, 10).unwrap().len(), 1);
        }
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

    /// The real desktop agent against the real relay: account token auth,
    /// device listing, and the viewer gate turning uploads on and off.
    #[tokio::test]
    async fn desktop_agent_streams_to_the_account_relay_only_while_viewed() {
        use kode_relay::{build_router, identity::StaticVerifier, RelayState, RelayTimings};

        let verifier = StaticVerifier::new([("tok-alice".to_string(), "alice".to_string())]);
        let relay = RelayState::new(
            verifier,
            RelayTimings {
                viewer_lease: Duration::from_millis(500),
                sweep_interval: Duration::from_millis(50),
                ..RelayTimings::default()
            },
        );
        relay.spawn_sweeper();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = build_router(relay);
        tokio::spawn(async move { axum::serve(listener, router).await });

        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("cloud-sync.json");
        std::fs::write(
            &config_path,
            json!({
                "installation_id": "install-e2e",
                "active_backend_id": "acct",
                "backends": [{
                    "id": "acct", "name": "Account", "server_url": base,
                    "kind": "account_relay",
                    "account": {
                        "issuer": "https://id.example.com", "email": "a@example.com",
                        "user_id": "alice", "access_token": "tok-alice",
                        "refresh_token": "r", "expires_at": now_ms() + 3_600_000
                    }
                }]
            })
            .to_string(),
        )
        .unwrap();
        std::env::set_var("KODE_CLOUD_SYNC_CONFIG", &config_path);
        let ctx = crate::build_test_ctx(kode_core::config::Config::default(), "relay-e2e".into());
        let manager = CloudSyncManager::new(ctx);
        std::env::remove_var("KODE_CLOUD_SYNC_CONFIG");
        manager.start_saved();

        let wait_for = |state: &'static str| {
            let manager = manager.clone();
            async move {
                for _ in 0..100 {
                    if manager.status().state == state {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                panic!("desktop never reached {state}: {:?}", manager.status());
            }
        };
        wait_for("standby").await;
        assert_eq!(manager.status().account_email.as_deref(), Some("a@example.com"));

        let http = reqwest::Client::new();
        let devices: Value = http
            .get(format!("{base}/api/v1/account/devices"))
            .bearer_auth("tok-alice")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(devices["devices"][0]["device_id"], "install-e2e");
        assert_eq!(devices["devices"][0]["online"], true);

        let sessions = http
            .get(format!("{base}/api/v1/sessions"))
            .bearer_auth("tok-alice")
            .header("X-Kode-Device", "install-e2e")
            .send()
            .await
            .unwrap();
        assert_eq!(sessions.status(), 200);
        wait_for("syncing").await;
        wait_for("standby").await;
    }

    #[test]
    fn configs_written_before_account_relays_stay_self_hosted() {
        let config: CloudSyncConfig = serde_json::from_value(json!({
            "installation_id": "install-1",
            "active_backend_id": "b",
            "backends": [{"id": "b", "name": "Home", "server_url": "https://sync.example.com"}]
        }))
        .expect("legacy config");
        let backend = config.active_backend().unwrap();
        assert_eq!(backend.kind, BackendKind::SelfHosted);
        assert!(backend.account.is_none());
        assert_eq!(idle_state(BackendKind::SelfHosted), "waiting_for_pairing");
        assert_eq!(idle_state(BackendKind::AccountRelay), "standby");
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
                deployment_kind: Some("standalone".into()),
                remote_deploy_dir: None,
                managed: true,
                device_id: None,
                device_token: None,
                command_receipts: VecDeque::new(),
                kind: BackendKind::SelfHosted,
                account: None,
            },
            CloudBackendConfig {
                id: "two".into(),
                name: "Two".into(),
                server_url: "https://two.example.com".into(),
                ssh_host: None,
                ssh_port: None,
                remote_port: None,
                deployment_kind: None,
                remote_deploy_dir: None,
                managed: false,
                device_id: None,
                device_token: None,
                command_receipts: VecDeque::new(),
                kind: BackendKind::SelfHosted,
                account: None,
            },
        ];
        config.active_backend_id = Some("two".into());

        let summaries = backend_summaries(&config);
        assert!(!summaries[0].active);
        assert!(summaries[1].active);
        assert!(summaries[0].managed);
    }
}

/// Execute against the bridge that owns a native CLI, without creating another runtime.
pub async fn execute_local_command(
    ctx: &crate::Ctx,
    id: u64,
    kind: &str,
    payload: Value,
) -> Result<(), String> {
    match kind {
        "input" => match payload.get("text").and_then(Value::as_str) {
            Some(text) => crate::submit_text_input(ctx, id, text)
                .await
                .map_err(|error| error.to_string()),
            None => Err("input command is missing text".into()),
        },
        "interrupt" => crate::interrupt_session(ctx, id).map_err(|error| error.to_string()),
        "delete" => crate::delete_session(ctx, id),
        "answer" if payload.get("response").is_some() => {
            match (ctx.acp.get(id), payload["request_id"].as_str()) {
                (Some(client), Some(request_id)) => {
                    client
                        .respond(request_id, payload["response"].clone())
                        .await
                }
                _ => Err("Structured response requires an ACP session and request_id".into()),
            }
        }
        "answer" => match payload.get("choice_index").and_then(Value::as_u64) {
            Some(choice) => {
                let submit = payload
                    .get("submit")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                crate::submit_question_answer(
                    ctx,
                    id,
                    payload.get("question_id").and_then(Value::as_str),
                    choice as u32,
                    payload.get("free_text").and_then(Value::as_str),
                    submit,
                )
                .await
                .map_err(|error| error.to_string())
            }
            None => Err("answer command is missing choice_index".into()),
        },
        "plan_response" => match payload.get("accept").and_then(Value::as_bool) {
            Some(accept) => {
                crate::respond_plan(
                    ctx,
                    id,
                    payload.get("plan_id").and_then(Value::as_str),
                    accept,
                )
                .await
            }
            None => Err("plan response command is missing accept".into()),
        },
        "model" => match payload.get("model").and_then(Value::as_str) {
            Some(model) => crate::set_session_model(ctx, id, model).await,
            None => Err("model command is missing model".into()),
        },
        "mode" => match payload.get("mode").and_then(Value::as_str) {
            Some(mode) => crate::set_session_permission_mode(ctx, id, mode)
                .await
                .map(|_| ()),
            None => Err("mode command is missing mode".into()),
        },
        _ => Err(format!("unsupported cloud command: {kind}")),
    }
}
