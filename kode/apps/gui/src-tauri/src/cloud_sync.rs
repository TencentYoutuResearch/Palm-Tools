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
