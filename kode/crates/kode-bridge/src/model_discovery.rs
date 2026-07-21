//! Runtime model discovery for AI CLI backends.
//!
//! Keep protocol details here so the desktop GUI and the headless bridge expose
//! the same catalogue. Unknown/custom backends deliberately return an error;
//! callers should retain free-form model input as the compatibility fallback.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::{timeout, Duration};

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

async fn discover_codex(backend: &str, command: &str) -> Result<ModelDiscoveryResult, String> {
    let mut child = Command::new(command)
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
        let mut params = json!({"includeHidden":false});
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

async fn discover_codebuddy(backend: &str, command: &str) -> Result<ModelDiscoveryResult, String> {
    let mut child = Command::new(command)
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
        Command::new(command).arg("--help").output(),
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
    match backend {
        "codex" => discover_codex(backend, command).await,
        "codebuddy" => discover_codebuddy(backend, command).await,
        "claude" | "claude-internal" => discover_claude(backend, command).await,
        _ => Err(format!("model discovery is not supported for {backend}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
