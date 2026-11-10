//! Desktop bindings proxy cloud ownership to the shared Kode service.
pub use kode_bridge::cloud_sync::{
    normalize_server_url, CloudBackendSummary, CloudPairingPayload, CloudSyncStatus,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

pub struct CloudSyncManager {
    ctx: Arc<kode_bridge::Ctx>,
}
impl CloudSyncManager {
    pub fn new(ctx: Arc<kode_bridge::Ctx>) -> Self {
        Self { ctx }
    }
    pub fn start_saved(&self) {
        crate::backend_runtime::start(self.ctx.clone());
    }
    pub async fn status(&self) -> Result<CloudSyncStatus, String> {
        decode(crate::backend_runtime::call("/cloud/status", None).await?)
    }
    pub async fn configure_and_create_pairing(
        &self,
        server_url: String,
    ) -> Result<CloudPairingPayload, String> {
        decode(
            crate::backend_runtime::call("/cloud/pair", Some(json!({"server_url":server_url})))
                .await?,
        )
    }
    pub async fn activate_backend(&self, backend_id: &str) -> Result<CloudSyncStatus, String> {
        decode(
            crate::backend_runtime::call("/cloud/activate", Some(json!({"backend_id":backend_id})))
                .await?,
        )
    }
    pub async fn upsert_managed_backend(
        &self,
        name: String,
        server_url: String,
        ssh_host: String,
        ssh_port: u16,
        remote_port: u16,
        deployment_kind: String,
        remote_deploy_dir: Option<String>,
    ) -> Result<CloudBackendSummary, String> {
        decode(crate::backend_runtime::call("/cloud/backend",Some(json!({"name":name,"server_url":server_url,"ssh_host":ssh_host,"ssh_port":ssh_port,"remote_port":remote_port,"deployment_kind":deployment_kind,"remote_deploy_dir":remote_deploy_dir}))).await?)
    }
    pub async fn account_send_code(&self, server_url: String, email: String) -> Result<Value, String> {
        crate::backend_runtime::call(
            "/cloud/account/code",
            Some(json!({"server_url":server_url,"email":email})),
        )
        .await
    }
    pub async fn account_sign_in(&self, code: String) -> Result<CloudSyncStatus, String> {
        decode(crate::backend_runtime::call("/cloud/account/sign_in", Some(json!({"code":code}))).await?)
    }
    pub async fn account_call(&self, path: &str, body: Value) -> Result<Value, String> {
        crate::backend_runtime::call(path, Some(body)).await
    }
    pub async fn account_sign_out(&self, backend_id: String) -> Result<CloudSyncStatus, String> {
        decode(
            crate::backend_runtime::call(
                "/cloud/account/sign_out",
                Some(json!({"backend_id":backend_id})),
            )
            .await?,
        )
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn cloud_sync_status(
    manager: State<'_, CloudSyncManager>,
) -> Result<CloudSyncStatus, String> {
    manager.status().await
}
#[tauri::command]
pub async fn cloud_sync_create_pairing(
    manager: State<'_, CloudSyncManager>,
    server_url: String,
) -> Result<CloudPairingPayload, String> {
    manager.configure_and_create_pairing(server_url).await
}
#[tauri::command]
pub async fn cloud_sync_activate_backend(
    manager: State<'_, CloudSyncManager>,
    backend_id: String,
) -> Result<CloudSyncStatus, String> {
    manager.activate_backend(&backend_id).await
}
#[tauri::command]
pub async fn cloud_account_send_code(
    manager: State<'_, CloudSyncManager>,
    server_url: String,
    email: String,
) -> Result<Value, String> {
    manager.account_send_code(server_url, email).await
}
#[tauri::command]
pub async fn cloud_account_sign_in(
    manager: State<'_, CloudSyncManager>,
    code: String,
) -> Result<CloudSyncStatus, String> {
    manager.account_sign_in(code).await
}
#[tauri::command]
pub async fn cloud_account_sign_out(
    manager: State<'_, CloudSyncManager>,
    backend_id: String,
) -> Result<CloudSyncStatus, String> {
    manager.account_sign_out(backend_id).await
}
#[tauri::command]
pub async fn cloud_account_methods(
    manager: State<'_, CloudSyncManager>,
    server_url: String,
) -> Result<Value, String> {
    manager.account_call("/cloud/account/methods", json!({"server_url":server_url})).await
}
#[tauri::command]
pub async fn cloud_account_linked(manager: State<'_, CloudSyncManager>) -> Result<Value, String> {
    manager.account_call("/cloud/account/linked", json!({})).await
}
#[tauri::command]
pub async fn cloud_palmx_start(
    manager: State<'_, CloudSyncManager>,
    server_url: Option<String>,
    purpose: String,
) -> Result<Value, String> {
    manager
        .account_call("/cloud/account/palmx/start", json!({"server_url":server_url,"purpose":purpose}))
        .await
}
#[tauri::command]
pub async fn cloud_palmx_poll(manager: State<'_, CloudSyncManager>) -> Result<Value, String> {
    manager.account_call("/cloud/account/palmx/poll", json!({})).await
}
#[tauri::command]
pub async fn cloud_palmx_cancel(manager: State<'_, CloudSyncManager>) -> Result<Value, String> {
    manager.account_call("/cloud/account/palmx/cancel", json!({})).await
}
/// The relay this machine signs in to by default, read at runtime: the
/// `KODE_RELAY_URL` environment variable, else `[account] relay_url` in
/// `config.toml` (`~/Library/Application Support/kode/` on macOS), else empty (users enter one).
#[tauri::command]
pub fn account_default_relay() -> String {
    std::env::var("KODE_RELAY_URL")
        .ok()
        .or_else(|| kode_core::config::Config::load().account.relay_url)
        .map(|url| url.trim().to_string())
        .unwrap_or_default()
}
#[tauri::command]
pub async fn cloud_account_profile(manager: State<'_, CloudSyncManager>) -> Result<Value, String> {
    manager.account_call("/cloud/account/profile", json!({})).await
}
#[tauri::command]
pub async fn cloud_account_set_name(manager: State<'_, CloudSyncManager>, name: String) -> Result<Value, String> {
    manager.account_call("/cloud/account/name", json!({"name":name})).await
}
#[tauri::command]
pub async fn cloud_palm_sign_in(
    manager: State<'_, CloudSyncManager>,
    server_url: String,
    session_id: String,
) -> Result<Value, String> {
    manager
        .account_call("/cloud/account/palm/sign_in", json!({"server_url":server_url,"session_id":session_id}))
        .await
}
#[tauri::command]
pub async fn cloud_palm_start(manager: State<'_, CloudSyncManager>, server_url: String) -> Result<Value, String> {
    manager.account_call("/cloud/account/palm/start", json!({"server_url":server_url})).await
}
#[tauri::command]
pub async fn cloud_palm_poll(manager: State<'_, CloudSyncManager>) -> Result<Value, String> {
    manager.account_call("/cloud/account/palm/poll", json!({})).await
}
#[tauri::command]
pub async fn cloud_palm_cancel(manager: State<'_, CloudSyncManager>) -> Result<Value, String> {
    manager.account_call("/cloud/account/palm/cancel", json!({})).await
}
#[tauri::command]
pub async fn cloud_palmx_unbind(manager: State<'_, CloudSyncManager>) -> Result<Value, String> {
    manager.account_call("/cloud/account/palmx/unbind", json!({})).await
}
/// Other devices on the signed-in account; `request` is a
/// `kode_bridge::remote_devices::Request` validated by the service.
#[tauri::command]
pub async fn cloud_account_devices(manager: State<'_, CloudSyncManager>, request: Value) -> Result<Value, String> {
    manager.account_call("/cloud/account/devices", request).await
}
