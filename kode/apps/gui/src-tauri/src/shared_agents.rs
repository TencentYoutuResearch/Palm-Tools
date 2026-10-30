//! Desktop adapter for the same Agent registry used by dsh.
use crate::state::AppState;
use kode_bridge::messaging::agents::Catalog;
use serde_json::Value;

pub async fn refresh(state: &AppState) -> Result<Catalog, String> {
    request(state, None).await
}

pub async fn change(state: &AppState, command: Value) -> Result<Catalog, String> {
    request(state, Some(command)).await
}

async fn request(state: &AppState, command: Option<Value>) -> Result<Catalog, String> {
    let (client, url, token) = crate::workbench_state::connection()
        .await
        .map_err(|error| error.to_string())?;
    let url = format!(
        "{}/agents",
        url.trim_end_matches("/documents/session-index")
    );
    let request = match command {
        Some(command) => client.post(url).json(&command),
        None => client.get(url),
    };
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Agent registry rejected the request: {}",
            response.text().await.unwrap_or_default()
        ));
    }
    let catalog: Catalog = response.json().await.map_err(|error| error.to_string())?;
    *state.ctx.backend_configs.write() = catalog.backends.clone();
    *state.protocol_ctx.agent_backends.write() = Some(catalog.clone());
    Ok(catalog)
}

pub async fn configuration(
    key: &str,
    thread: Option<&str>,
) -> Result<kode_core::BackendConfig, String> {
    let (client, url, token) = crate::workbench_state::connection()
        .await
        .map_err(|error| error.to_string())?;
    let url = format!(
        "{}/agents",
        url.trim_end_matches("/documents/session-index")
    );
    let catalog: Catalog = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let mut backend = kode_bridge::messaging::agents::resolve(&catalog, key, thread)
        .map_err(|error| error.to_string())?;
    // Shared custom CodeBuddy definitions predate explicit ACP capabilities.
    if backend.acp.is_none() && backend.protocol_key(key) == "codebuddy" {
        backend.acp = Some(kode_core::config::AcpSpec::flag());
    }
    Ok(backend)
}

pub async fn bind_native(commands: Vec<Value>) -> Result<(), String> {
    if commands.is_empty() {
        return Ok(());
    }
    let (client, url, token) = crate::workbench_state::connection()
        .await
        .map_err(|error| error.to_string())?;
    let url = format!(
        "{}/agents",
        url.trim_end_matches("/documents/session-index")
    );
    for command in commands {
        client
            .post(&url)
            .bearer_auth(&token)
            .json(&command)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
