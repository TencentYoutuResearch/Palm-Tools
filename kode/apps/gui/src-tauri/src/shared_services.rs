//! Owner-requested MCP setup for GUI CLIs. The managed launcher is inactive
//! outside Kode and obtains only its own session credential at runtime.
use kode_core::config::{BackendConfig, McpSetupSpec};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::State;

#[derive(Serialize)]
pub struct Outcome {
    backend: String,
    success: bool,
    error: Option<String>,
}
fn root() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("KODE_WORKBENCH_CONNECTION") {
        return PathBuf::from(path)
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Invalid workbench connection path".into());
    }
    Ok(dirs::config_dir()
        .ok_or("Configuration directory unavailable")?
        .join("kode"))
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
async fn launcher() -> Result<PathBuf, String> {
    let root = root()?;
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::env::current_exe().map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let path = root.join("shared-session-mcp");
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let body = format!(
            "#!/bin/sh\nexec {} --kode-session-mcp \"$@\"\n",
            quote(&exe.to_string_lossy())
        );
        tokio::fs::write(&path, body)
            .await
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(path)
    }
}
fn launcher_args() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["--kode-session-mcp"]
    } else {
        vec![]
    }
}

async fn command(cli: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let mut process = tokio::process::Command::new(cli);
    process.args(args).kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(15), process.output())
        .await
        .map_err(|_| format!("{cli} MCP configuration timed out"))?
        .map_err(|e| format!("Could not start {cli}: {e}"))
}
async fn configure(spec: &McpSetupSpec, launcher: &Path) -> Result<(), String> {
    const NAME: &str = "kode-shared-services";
    if let McpSetupSpec::JsonMerge { config_path } = spec {
        let path = if let Some(suffix) = config_path.strip_prefix("~/") {
            dirs::home_dir()
                .ok_or("Home directory unavailable")?
                .join(suffix)
        } else {
            PathBuf::from(config_path)
        };
        let mut value: Value = match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid MCP configuration: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(e.to_string()),
        };
        let object = value
            .as_object_mut()
            .ok_or("MCP configuration must be an object")?;
        let servers = object
            .entry("mcpServers")
            .or_insert(json!({}))
            .as_object_mut()
            .ok_or("mcpServers must be an object")?;
        if let Some(existing) = servers.get(NAME) {
            if existing["command"].as_str() != launcher.to_str() {
                return Err("An unmanaged kode-shared-services MCP entry already exists; rename it before configuring".into());
            }
        }
        servers.insert(
            NAME.into(),
            json!({"command":launcher,"args":launcher_args()}),
        );
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        let temporary = path.with_extension("kode-shared.tmp");
        tokio::fs::write(
            &temporary,
            serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::rename(temporary, path)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let cli = spec.cli().ok_or("Backend has no MCP setup command")?;
    let path = launcher.to_str().ok_or("MCP launcher path is not UTF-8")?;
    let existing = command(cli, &["mcp", "get", NAME]).await?;
    if existing.status.success() {
        if !String::from_utf8_lossy(&existing.stdout).contains(path) {
            return Err("An unmanaged kode-shared-services MCP entry already exists; rename it before configuring".into());
        }
        return Ok(());
    }
    let mut args = match spec {
        McpSetupSpec::Codex { .. } => vec!["mcp", "add", NAME, "--", path],
        McpSetupSpec::Claude { .. } => vec!["mcp", "add", "-s", "user", NAME, "--", path],
        McpSetupSpec::Codebuddy { .. } => vec!["mcp", "add", "-s", "user", NAME, path],
        McpSetupSpec::JsonMerge { .. } => unreachable!(),
    };
    args.extend(launcher_args());
    let output = command(cli, &args).await?;
    if !output.status.success() {
        return Err(format!(
            "{cli} rejected MCP setup (exit {}). Check this Agent's MCP support and retry.",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".into())
        ));
    }
    Ok(())
}
static SETUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn setup(backends: HashMap<String, BackendConfig>) -> Result<Vec<Outcome>, String> {
    let _guard = SETUP.lock().await;
    let launcher = launcher().await?;
    let marker = root()?.join("shared-mcp.json");
    let mut configured = tokio::fs::read(&marker)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["backends"].as_array().cloned())
        .unwrap_or_default();
    let mut outcomes = vec![];
    for (key, backend) in backends
        .into_iter()
        .filter(|(_, backend)| backend.is_enabled())
    {
        let Some(spec) = backend.mcp_setup else {
            continue;
        };
        let result = configure(&spec, &launcher).await;
        if result.is_ok() && !configured.contains(&json!(key)) {
            configured.push(json!(key));
        }
        outcomes.push(Outcome {
            backend: key,
            success: result.is_ok(),
            error: result.err(),
        });
    }
    tokio::fs::write(
        &marker,
        serde_json::to_vec(&json!({"backends":configured})).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(outcomes)
}
#[tauri::command]
pub async fn setup_shared_services(
    state: State<'_, crate::state::AppState>,
) -> Result<Vec<Outcome>, String> {
    // Ensure the backend is ready before modifying an Agent's MCP launcher.
    crate::backend_runtime::call("/integrations", None).await?;
    let backends = state.ctx.backend_configs.read().clone();
    setup(backends).await
}
pub fn start_saved(backends: HashMap<String, BackendConfig>) {
    tauri::async_runtime::spawn(async move {
        if root()
            .ok()
            .is_some_and(|root| root.join("shared-mcp.json").exists())
        {
            if let Err(error) = setup(backends).await {
                tracing::warn!(%error,"Shared MCP setup unavailable");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn json_setup_is_idempotent_preserves_user_entries_and_rejects_collisions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mcp.json");
        tokio::fs::write(
            &path,
            br#"{"userSetting":true,"mcpServers":{"personal":{"command":"user-server"}}}"#,
        )
        .await
        .unwrap();
        let spec = McpSetupSpec::JsonMerge {
            config_path: path.to_string_lossy().into_owned(),
        };
        let launcher = root.path().join("shared-session-mcp");
        configure(&spec, &launcher).await.unwrap();
        configure(&spec, &launcher).await.unwrap();
        let bytes = tokio::fs::read(&path).await.unwrap();
        let config: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(config["userSetting"], true);
        assert_eq!(config["mcpServers"]["personal"]["command"], "user-server");
        assert_eq!(config["mcpServers"].as_object().unwrap().len(), 2);
        assert!(configure(&spec, &root.path().join("other-launcher"))
            .await
            .unwrap_err()
            .contains("unmanaged"));
        assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    }
}
