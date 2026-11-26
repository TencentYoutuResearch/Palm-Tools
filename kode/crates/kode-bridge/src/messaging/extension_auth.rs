//! Check the selected CLI profile's own MCP registry; credentials stay in that CLI.
use super::{extension_files, extension_targets, extensions, Hub};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{process::Command, sync::Mutex, time::timeout};

static LOGIN: Mutex<()> = Mutex::const_new(());

async fn cli(profile: &Value, args: &[String], seconds: u64, capture: bool) -> Result<String> {
    let exe = profile["executable"].as_str().context("CLI 未配置")?;
    let mut command = Command::new(exe);
    command
        .args(args)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(env) = profile["env"].as_object() {
        command.envs(env.iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v))));
    }
    for key in [
        "KODE_BRIDGE_TOKEN",
        "KODE_MESSAGING_ADMIN_TOKEN_FILE",
        "KODE_MESSAGING_TOKEN_FILE",
        "KODE_SESSION_ID",
    ] {
        command.env_remove(key);
    }
    command.stdout(if capture {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let child = command.spawn().context("无法启动 Agent CLI")?;
    let output = timeout(Duration::from_secs(seconds), child.wait_with_output())
        .await
        .context("MCP 操作超时")??;
    if !output.status.success() {
        bail!("MCP 操作未完成（{}）", output.status);
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn codex_status(row: &Value) -> &'static str {
    if row["enabled"] == false {
        return "manual";
    }
    match row["auth_status"].as_str() {
        Some("not_logged_in") => "login-required",
        Some("o_auth" | "bearer_token") => "authorized",
        Some("unsupported") => "not-required",
        _ => "unknown",
    }
}

fn claude_status(text: &str) -> &'static str {
    let Some(line) = text.lines().find_map(|s| s.trim().strip_prefix("Status:")) else {
        return "unknown";
    };
    let status = line.to_lowercase();
    if status.contains("needs authentication") {
        "login-required"
    } else if status.contains("✓ connected") {
        "connected"
    } else {
        "unknown"
    }
}

fn cursor_status(text: &str, name: &str) -> &'static str {
    let state = text.lines().find_map(|s| {
        s.split_once(": ")
            .filter(|(id, _)| *id == name)
            .map(|(_, value)| value)
    });
    match state.and_then(|s| s.split_whitespace().next()) {
        Some("ready") => "connected",
        Some("requires_authentication") => "login-required",
        Some("disabled" | "not") => "manual",
        _ => "unknown",
    }
}

pub(super) async fn execute(hub: &Hub, input: &Value) -> Result<Value> {
    let login = input["action"] == "mcp-login";
    let _lease = if login {
        Some(LOGIN.try_lock().context("另一个 MCP 授权正在进行")?)
    } else {
        None
    };
    let rows = query(hub, input, login).await?;
    if login {
        // Login completion alone does not prove credentials were stored in this CLI profile.
        let result = query(hub, input, false).await?;
        let confirmed = result["rows"].as_array().is_some_and(|rows| {
            rows.iter().any(|row| {
                row["packageKey"] == input["packageKey"]
                    && row["name"] == input["name"]
                    && matches!(
                        row["status"].as_str(),
                        Some("connected" | "authorized" | "not-required")
                    )
            })
        });
        if !confirmed {
            bail!("CLI 尚未确认此 MCP 的授权，请刷新状态或重试");
        }
        Ok(result)
    } else {
        Ok(rows)
    }
}

async fn query(hub: &Hub, input: &Value, login: bool) -> Result<Value> {
    let data = extensions::state(hub)?;
    let source = data["sources"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["id"] == input["id"]))
        .context("来源不存在")?;
    let agents = hub.store.document("agents")?;
    // The desktop exposes its native DSH profile even before any profiles are saved.
    let native_dsh = json!({"id":"builtin-dsh","type":"dsh"});
    let profile = agents["value"]["profiles"]
        .as_array()
        .and_then(|s| s.iter().find(|p| p["id"] == input["profileId"]))
        .or_else(|| (input["profileId"] == "builtin-dsh").then_some(&native_dsh))
        .context("Agent 不存在")?;
    let (target, _) = extension_targets::for_profile(profile).context("Agent 未配置同步目标")?;
    let synced = source.get("syncedTargets").unwrap_or(&source["targets"]);
    if !synced
        .as_array()
        .is_some_and(|s| s.iter().any(|t| t.as_str() == Some(&target)))
    {
        bail!("此来源尚未同步到所选 Agent");
    }
    let kind = profile["type"].as_str().unwrap_or("");
    let release_root = hub
        .extensions
        .root
        .join("sources")
        .join(source["id"].as_str().context("missing source id")?)
        .join("releases")
        .join(source["release"].as_str().context("请先同步此来源")?)
        .join("package")
        .canonicalize()?;
    let mut catalog: Option<Vec<Value>> = None;
    let mut cursor_list: Option<String> = None;
    let mut rows = vec![];
    let mut matched = false;
    for pkg in source["packages"].as_array().into_iter().flatten() {
        let key = &pkg["path"];
        if pkg["enabled"] == false || login && input["packageKey"] != *key {
            continue;
        }
        let plugin = source["plugins"][kind]
            .as_array()
            .into_iter()
            .flatten()
            .find(|plugin| {
                key.as_str()
                    .zip(plugin["path"].as_str())
                    .is_some_and(|(key, path)| Path::new(path) == release_root.join(key))
            });
        for server in pkg["mcp"].as_array().into_iter().flatten() {
            let name = server["name"].as_str().context("MCP 名称缺失")?;
            if login && input["name"].as_str() != Some(name) {
                continue;
            }
            let mut args = vec![];
            let mut identifier = name.to_owned();
            let mut status = "manual";
            if server["type"] == "stdio" {
                status = "not-required";
            } else if let Some(plugin) = plugin {
                let path = plugin["path"].as_str().context("插件路径缺失")?;
                if kind == "codex" {
                    let entries = match &catalog {
                        Some(items) => items,
                        None => catalog.insert(
                            cli(
                                profile,
                                &["mcp".into(), "list".into(), "--json".into()],
                                15,
                                true,
                            )
                            .await
                            .ok()
                            .and_then(|s| serde_json::from_str(&s).ok())
                            .unwrap_or_default(),
                        ),
                    };
                    let endpoint = extension_files::mcp_endpoint(Path::new(path), kind, name);
                    if let Some(row) = entries.iter().find(|r| {
                        r["name"] == name
                            && endpoint
                                .as_deref()
                                .is_some_and(|url| r["transport"]["url"].as_str() == Some(url))
                    }) {
                        status = codex_status(row);
                    }
                } else if kind == "cursor" {
                    // Cursor's headless login only handles servers in its MCP config.
                    // Match the actual endpoint before opening a same-named server.
                    let home = profile["env"]["HOME"]
                        .as_str()
                        .map(Path::new)
                        .unwrap_or(&hub.extensions.home);
                    let config = std::fs::read(home.join(".cursor/mcp.json"))
                        .ok()
                        .and_then(|s| serde_json::from_slice::<Value>(&s).ok());
                    let endpoint = extension_files::mcp_endpoint(Path::new(path), kind, name);
                    if endpoint.as_ref().is_some_and(|url| {
                        config
                            .as_ref()
                            .is_some_and(|c| c["mcpServers"][name]["url"].as_str() == Some(url))
                    }) {
                        let list = match &cursor_list {
                            Some(text) => text,
                            None => cursor_list.insert(
                                cli(profile, &["mcp".into(), "list".into()], 25, true)
                                    .await
                                    .unwrap_or_default(),
                            ),
                        };
                        status = cursor_status(list, name);
                    }
                } else if kind == "claude" {
                    args = vec!["--plugin-dir".into(), path.to_owned()];
                    identifier =
                        format!("plugin:{}:{}", plugin["name"].as_str().unwrap_or(""), name);
                    let mut get = args.clone();
                    get.extend(["mcp".into(), "get".into(), identifier.clone()]);
                    status = cli(profile, &get, 15, true)
                        .await
                        .ok()
                        .map(|s| claude_status(&s))
                        .unwrap_or("unknown");
                }
            }
            if login {
                matched = true;
                if status == "login-required" {
                    args.extend(["mcp".into(), "login".into(), "--".into(), identifier]);
                    cli(profile, &args, 120, false).await?;
                } else if !matches!(status, "authorized" | "connected" | "not-required") {
                    bail!("请在该 CLI 内检查 MCP 授权");
                }
            }
            rows.push(json!({"packageKey":key,"name":name,"status":status}));
        }
    }
    if login && !matched {
        bail!("未找到已启用的 MCP");
    }
    Ok(json!({"rows":rows}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_requires_explicit_cli_evidence() {
        assert_eq!(
            codex_status(&json!({"auth_status":"not_logged_in"})),
            "login-required"
        );
        assert_eq!(
            codex_status(&json!({"auth_status":"not_logged_in","enabled":false})),
            "manual"
        );
        assert_eq!(
            claude_status("Description: needs authentication"),
            "unknown"
        );
        assert_eq!(
            claude_status("  Status: ⚠ Needs authentication"),
            "login-required"
        );
    }
}
