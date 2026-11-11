//! Runtime model discovery for AI CLI backends.
//!
//! Keep protocol details here so the desktop GUI and the headless bridge expose
//! the same catalogue. Unknown/custom backends deliberately return an error;
//! callers should retain free-form model input as the compatibility fallback.

use kode_core::config::BackendConfig;
use kode_core::session::jsonl_tail::Backend;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{timeout, Duration};

const MODEL_CACHE_TTL_SECS: u64 = 24 * 60 * 60;

fn cli_command(program: &str) -> Command {
    let resolved = kode_core::pty::resolve_spawn_command(program);
    #[cfg(windows)]
    if matches!(
        std::path::Path::new(&resolved)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("cmd" | "bat")
    ) {
        // Rust's CreateProcess path does not execute npm .cmd shims directly.
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C"]).arg(resolved);
        return command;
    }
    Command::new(resolved)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelDiscoveryResult {
    pub backend: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub custom_allowed: bool,
    pub models: Vec<DiscoveredModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone)]
struct ProcessCacheEntry {
    cached_at: u64,
    result: ModelDiscoveryResult,
}

#[derive(Serialize, Deserialize)]
struct DiskCacheEntry {
    cached_at: u64,
    result: ModelDiscoveryResult,
}

fn process_cache() -> &'static Mutex<HashMap<String, ProcessCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ProcessCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn discovery_locks() -> &'static Mutex<HashMap<String, Arc<AsyncMutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn cache_is_fresh(cached_at: u64) -> bool {
    now_secs().saturating_sub(cached_at) <= MODEL_CACHE_TTL_SECS
}

fn disk_cache_path(cache_key: &str) -> Option<PathBuf> {
    dirs::cache_dir().map(|root| {
        root.join("kode")
            .join("model-catalog")
            .join(format!("{cache_key}.json"))
    })
}

fn discovery_cache_key(backend: &str, config: &BackendConfig) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"kode-model-catalog-v1\0");
    hasher.update(backend.as_bytes());
    hasher.update(serde_json::to_vec(config).unwrap_or_default());
    let resolved = kode_core::pty::resolve_spawn_command(&config.command);
    if let Ok(metadata) = fs::metadata(&resolved) {
        hasher.update(metadata.len().to_le_bytes());
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                hasher.update(duration.as_nanos().to_le_bytes());
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

fn cached_discovery(cache_key: &str) -> Option<ModelDiscoveryResult> {
    if let Some(entry) = process_cache().lock().get(cache_key) {
        if cache_is_fresh(entry.cached_at) {
            return Some(entry.result.clone());
        }
    }
    let path = disk_cache_path(cache_key)?;
    let entry: DiskCacheEntry = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if !cache_is_fresh(entry.cached_at) {
        return None;
    }
    process_cache().lock().insert(
        cache_key.to_string(),
        ProcessCacheEntry {
            cached_at: entry.cached_at,
            result: entry.result.clone(),
        },
    );
    Some(entry.result)
}

fn store_discovery(cache_key: &str, result: &ModelDiscoveryResult) {
    let cached_at = now_secs();
    process_cache().lock().insert(
        cache_key.to_string(),
        ProcessCacheEntry {
            cached_at,
            result: result.clone(),
        },
    );
    let Some(path) = disk_cache_path(cache_key) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let entry = DiskCacheEntry {
        cached_at,
        result: result.clone(),
    };
    if let Ok(bytes) = serde_json::to_vec(&entry) {
        let _ = fs::write(path, bytes);
    }
}

fn key_lock(cache_key: &str) -> Arc<AsyncMutex<()>> {
    discovery_locks()
        .lock()
        .entry(cache_key.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

async fn write_line(child: &mut Child, value: Value) -> Result<(), String> {
    let stdin = child.stdin.as_mut().ok_or("backend stdin unavailable")?;
    stdin
        .write_all(value.to_string().as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

async fn read_json_for_id(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: i64,
) -> Result<Value, String> {
    timeout(Duration::from_secs(8), async {
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("id").and_then(Value::as_i64) == Some(id) {
                    return v.get("result").cloned().ok_or_else(|| {
                        v.get("error")
                            .cloned()
                            .unwrap_or(Value::String("missing result".into()))
                            .to_string()
                    });
                }
            }
        }
        Err("backend exited before responding".into())
    })
    .await
    .map_err(|_| "model discovery timed out".to_string())?
}

fn parse_codex_models(result: &Value) -> Vec<DiscoveredModel> {
    result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m
                .get("model")
                .or_else(|| m.get("id"))?
                .as_str()?
                .to_string();
            Some(DiscoveredModel {
                label: m
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                description: m
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                is_default: m.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                id,
            })
        })
        .collect()
}

async fn discover_codex(
    backend: &str,
    command: &str,
    args: &[String],
) -> Result<ModelDiscoveryResult, String> {
    let mut child = cli_command(command)
        .args(args)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start {command}: {e}"))?;
    let stdout = child.stdout.take().ok_or("backend stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    write_line(&mut child, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"kode","title":"Kode","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}})).await?;
    let _ = read_json_for_id(&mut lines, 1).await?;
    write_line(&mut child, json!({"jsonrpc":"2.0","method":"initialized"})).await?;
    let mut request_id = 2_i64;
    let mut cursor: Option<String> = None;
    let mut models = Vec::new();
    loop {
        let mut params = json!({"includeHidden":false,"limit":100});
        if let Some(value) = cursor.as_ref() {
            params["cursor"] = Value::String(value.clone());
        }
        write_line(
            &mut child,
            json!({"jsonrpc":"2.0","id":request_id,"method":"model/list","params":params}),
        )
        .await?;
        let result = read_json_for_id(&mut lines, request_id).await?;
        models.extend(parse_codex_models(&result));
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
        request_id += 1;
    }
    let _ = child.kill().await;
    if models.is_empty() {
        return Err("Codex returned no models".into());
    }
    Ok(ModelDiscoveryResult {
        backend: backend.into(),
        source: "codex-app-server".into(),
        version: None,
        custom_allowed: true,
        models,
        warning: None,
    })
}

fn parse_codebuddy_models(result: &Value) -> Vec<DiscoveredModel> {
    let payload = result
        .get("response")
        .and_then(|v| v.get("response"))
        .unwrap_or(result);
    payload
        .get("availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m
                .get("modelId")
                .or_else(|| m.get("id"))?
                .as_str()?
                .to_string();
            Some(DiscoveredModel {
                label: m
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                description: m
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                is_default: m.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                id,
            })
        })
        .collect()
}

async fn discover_codebuddy(backend: &str, command: &str, args: &[String]) -> Result<ModelDiscoveryResult, String> {
    let mut child = cli_command(command)
        .args(args)
        .args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("cannot start {command}: {e}"))?;
    let stdout = child.stdout.take().ok_or("backend stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    write_line(&mut child, json!({"type":"control_request","request_id":"kode-models","request":{"subtype":"get_available_models"}})).await?;
    let response = timeout(Duration::from_secs(20), async {
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let request_id = v
                    .get("request_id")
                    .or_else(|| v.get("response").and_then(|r| r.get("request_id")))
                    .and_then(Value::as_str);
                if request_id == Some("kode-models") {
                    return Ok::<Value, String>(v);
                }
            }
        }
        Err::<Value, String>("CodeBuddy exited before responding".into())
    })
    .await
    .map_err(|_| "model discovery timed out".to_string())??;
    let _ = child.kill().await;
    let models = parse_codebuddy_models(&response);
    if models.is_empty() {
        return Err("CodeBuddy returned no models".into());
    }
    Ok(ModelDiscoveryResult {
        backend: backend.into(),
        source: "codebuddy-control".into(),
        version: None,
        custom_allowed: true,
        models,
        warning: None,
    })
}

async fn discover_claude(backend: &str, command: &str) -> Result<ModelDiscoveryResult, String> {
    let output = timeout(
        Duration::from_secs(5),
        cli_command(command)
            .arg("--help")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Claude capability check timed out".to_string())?
    .map_err(|e| e.to_string())?;
    let help = String::from_utf8_lossy(&output.stdout);
    if !help.contains("--model") {
        return Ok(ModelDiscoveryResult {
            backend: backend.into(),
            source: "claude-capability".into(),
            version: None,
            custom_allowed: false,
            models: vec![],
            warning: Some(
                "This Claude CLI does not advertise --model; backend default will be used.".into(),
            ),
        });
    }
    let models = ["default", "sonnet", "opus", "haiku"]
        .into_iter()
        .map(|id| DiscoveredModel {
            id: id.into(),
            label: id.into(),
            description: None,
            is_default: id == "default",
        })
        .collect();
    Ok(ModelDiscoveryResult {
        backend: backend.into(),
        source: "claude-aliases".into(),
        version: None,
        custom_allowed: true,
        models,
        warning: Some("Claude exposes aliases rather than a model-list API.".into()),
    })
}

pub async fn discover_models(backend: &str, command: &str) -> Result<ModelDiscoveryResult, String> {
    discover_models_with_args(backend, backend, command, &[]).await
}

/// Probe the same command and Codex options used to launch this agent, including
/// provider/profile selection and an optional `env ... codex` wrapper.
pub async fn discover_models_with_config(
    backend: &str,
    config: &BackendConfig,
) -> Result<ModelDiscoveryResult, String> {
    discover_models_with_args(
        backend,
        config.protocol_key(backend),
        &config.command,
        &config.args,
    )
    .await
}

pub async fn discover_models_with_config_cached(
    backend: &str,
    config: &BackendConfig,
    force: bool,
) -> Result<ModelDiscoveryResult, String> {
    let cache_key = discovery_cache_key(backend, config);
    if !force {
        if let Some(result) = cached_discovery(&cache_key) {
            return Ok(result);
        }
    }
    let lock = key_lock(&cache_key);
    let _guard = lock.lock().await;
    if !force {
        if let Some(result) = cached_discovery(&cache_key) {
            return Ok(result);
        }
    }
    let result = discover_models_with_config(backend, config).await?;
    store_discovery(&cache_key, &result);
    Ok(result)
}

async fn discover_models_with_args(
    backend: &str,
    protocol: &str,
    command: &str,
    args: &[String],
) -> Result<ModelDiscoveryResult, String> {
    match Backend::from_backend_key(protocol) {
        Some(Backend::Codex | Backend::Tcodex) => discover_codex(backend, command, args).await,
        Some(Backend::Codebuddy) => discover_codebuddy(backend, command, args).await,
        Some(Backend::Claude) => discover_claude(backend, command).await,
        Some(Backend::Tclaude) => discover_tclaude(command).await,
        Some(Backend::Cursor) => discover_cursor(backend, command).await,
        _ => Err(format!("model discovery is not supported for {backend}")),
    }
}

async fn discover_tclaude(command: &str) -> Result<ModelDiscoveryResult, String> {
    // The wrapper validates model ids before forwarding --help, and reports
    // its account-specific catalogue. Upstream aliases (opus/sonnet) are not
    // accepted by this wrapper, so returning Claude's aliases is incorrect.
    let output = timeout(
        Duration::from_secs(10),
        cli_command(command)
            .args(["--model", "kode-model-discovery", "--", "--help"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "tclaude model discovery timed out".to_string())?
    .map_err(|e| e.to_string())?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let models = parse_tclaude_models(&text);
    if models.is_empty() {
        return Err("tclaude did not report its available models; check its desktop login".into());
    }
    Ok(ModelDiscoveryResult {
        backend: "tclaude".into(),
        source: "tclaude-model-validation".into(),
        version: None,
        custom_allowed: false,
        models,
        warning: None,
    })
}

fn parse_tclaude_models(text: &str) -> Vec<DiscoveredModel> {
    text.lines()
        .find_map(|line| line.strip_prefix("Available models: "))
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:/[]".contains(&b))
        })
        .map(|id| DiscoveredModel {
            id: id.into(),
            label: id.into(),
            description: None,
            is_default: false,
        })
        .collect()
}

fn parse_cursor_models(text: &str) -> Vec<DiscoveredModel> {
    text.lines()
        .filter_map(|line| {
            let (id, label) = line.trim().split_once(" - ")?;
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))
            {
                return None;
            }
            let is_default =
                label.ends_with(" (default)") || label.ends_with(" (current, default)");
            let label = [" (current, default)", " (default)", " (current)"]
                .iter()
                .find_map(|suffix| label.strip_suffix(suffix))
                .unwrap_or(label);
            Some(DiscoveredModel {
                id: id.into(),
                label: label.into(),
                description: None,
                is_default,
            })
        })
        .collect()
}

async fn discover_cursor(backend: &str, command: &str) -> Result<ModelDiscoveryResult, String> {
    let output = timeout(
        Duration::from_secs(20),
        cli_command(command)
            .arg("--list-models")
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Cursor model discovery timed out".to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Cursor could not load models; check its desktop login".into());
    }
    let models = parse_cursor_models(&String::from_utf8_lossy(&output.stdout));
    if models.is_empty() {
        return Err("Cursor returned no models".into());
    }
    Ok(ModelDiscoveryResult {
        backend: backend.into(),
        source: "cursor-cli".into(),
        version: None,
        custom_allowed: true,
        models,
        warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_npm_shims_run_through_cmd_exe() {
        let command = cli_command(r"C:\tools\tcodex.cmd");
        let program = command.as_std().get_program().to_string_lossy();
        assert_eq!(
            std::path::Path::new(program.as_ref())
                .file_name()
                .and_then(|name| name.to_str()),
            Some("cmd.exe")
        );
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..3], ["/D", "/S", "/C"]);
        assert_eq!(args[3], r"C:\tools\tcodex.cmd");
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires an installed and authenticated tcodex CLI"]
    async fn windows_live_tcodex_discovery_returns_the_catalogue() {
        let result = discover_models("tcodex", "tcodex").await.unwrap();
        assert!(result.models.len() > 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_agents_keep_their_profile_and_wrapper_environment() {
        // The fixture rejects missing/misordered launch options. No installed
        // CLI, login, global environment mutation, or model request is needed.
        let script = r#"
test "$1" = --profile && test "$2" = "$KODE_MODEL_FIXTURE" || exit 11
test "$3" = app-server && test "$4" = --stdio || exit 12
read -r initialize
printf '%s\n' '{"id":1,"result":{}}'
read -r initialized
read -r list
printf '{"id":2,"result":{"data":[{"id":"%s","isDefault":true}]}}\n' "$KODE_MODEL_FIXTURE"
"#;
        for (agent, profile) in [
            ("native-codex", "native"),
            ("gateway-codex", "gateway"),
            ("tcodex", "tencent"),
        ] {
            let mut config = kode_core::config::Config::default()
                .backend("codex")
                .unwrap()
                .clone();
            config.command = "/usr/bin/env".into();
            config.args = vec![
                format!("KODE_MODEL_FIXTURE={profile}"),
                "/bin/sh".into(),
                "-c".into(),
                script.into(),
                "fixture".into(),
                "--profile".into(),
                profile.into(),
            ];
            let result = discover_models_with_config(agent, &config).await.unwrap();
            assert_eq!(result.backend, agent);
            assert_eq!(result.source, "codex-app-server");
            assert_eq!(result.models[0].id, profile);
        }
    }

    #[tokio::test]
    #[cfg(not(windows))]
    async fn t_cli_model_discovery_routes_to_compatible_protocols() {
        // Capability probes use local fixtures, never an installed AI CLI.
        // tclaude requires its account catalogue, not upstream aliases.
        let claude = discover_models("tclaude", "/bin/echo").await.unwrap_err();
        assert!(claude.contains("did not report its available models"));
        let missing = std::env::temp_dir().join(format!("missing-tcodex-{}", uuid::Uuid::new_v4()));
        let codex = discover_models("tcodex", missing.to_str().unwrap())
            .await
            .unwrap_err();
        assert!(codex.starts_with("cannot start"));
        assert!(!codex.contains("not supported"));
    }

    #[test]
    fn cursor_catalogue_preserves_variants_and_default() {
        let models = parse_cursor_models("Available models\n\nauto - Auto (default)\ngrok-4.7-high-fast - Grok 4.7 High Fast (current)\nTip: use --model <id> to switch.");
        assert_eq!(models.len(), 2);
        assert!(models[0].is_default);
        assert_eq!(models[1].label, "Grok 4.7 High Fast");
    }

    #[test]
    fn tclaude_uses_full_account_model_ids() {
        let models = parse_tclaude_models("model invalid is not available.\nAvailable models: claude-sonnet-5-5[1m], claude-opus-5-5[1m], opusplan\n");
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "claude-sonnet-5-5[1m]");
    }

    #[test]
    fn parses_codex_model_list() {
        let models = parse_codex_models(
            &json!({"data":[{"id":"gpt-5.4","displayName":"GPT-5.4","description":"Fast","isDefault":true}]}),
        );
        assert_eq!(
            models,
            vec![DiscoveredModel {
                id: "gpt-5.4".into(),
                label: "GPT-5.4".into(),
                description: Some("Fast".into()),
                is_default: true
            }]
        );
    }

    #[test]
    fn parses_codebuddy_control_response() {
        let models = parse_codebuddy_models(
            &json!({"type":"control_response","response":{"subtype":"success","response":{"availableModels":[{"modelId":"x","name":"Model X"}]}}}),
        );
        assert_eq!(models[0].id, "x");
        assert_eq!(models[0].label, "Model X");
    }

    #[test]
    fn model_cache_key_tracks_backend_configuration() {
        let mut config = kode_core::config::Config::default()
            .backend("codex")
            .unwrap()
            .clone();
        let first = discovery_cache_key("tcodex", &config);
        config.args.push("--profile".into());
        config.args.push("work".into());
        let second = discovery_cache_key("tcodex", &config);
        assert_ne!(first, second);
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires an installed and authenticated tcodex CLI"]
    async fn live_tcodex_model_cache_reuses_the_catalogue() {
        let config = kode_core::config::Config::default()
            .backend("tcodex")
            .unwrap()
            .clone();
        let started = std::time::Instant::now();
        let first = discover_models_with_config_cached("tcodex", &config, true)
            .await
            .unwrap();
        let cold = started.elapsed();
        let started = std::time::Instant::now();
        let warm = discover_models_with_config_cached("tcodex", &config, false)
            .await
            .unwrap();
        eprintln!(
            "tcodex model catalogue: cold={:?} warm={:?} models={}",
            cold,
            started.elapsed(),
            warm.models.len()
        );
        assert_eq!(first.models, warm.models);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }
}
