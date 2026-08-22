//! Cursor Agent command hook entrypoint(`kode-memory cursor-hook`).
//!
//! Cursor `~/.cursor/hooks.json` 的 command hook 把 JSON 打到 stdin。payload
//! 里的 chat uuid 字段随事件不同: `sessionStart` 用 `session_id`,
//! `afterAgentResponse` / `stop` 用 `conversation_id`。本 bridge:
//! - 把 `$KODE_SESSION_ID` 写进 `session_id`,让 HookRelay 能路由到 tab;
//! - 把 `conversation_id` 复制到 `session_uuid`;
//! - 若能找到对应 `meta.json`,填 `transcript_path` 供 tail retarget;
//! - 用 CLI 传入的 event 名补上 `hook_event_name`(Cursor 不一定带这个字段)。
//!
//! Cursor 给 hook 的 env **不会**继承 cursor-agent 进程的 `KODE_*`。所以:
//! - socket 默认 `/tmp/kode-hook.sock`(与 HookRelay 固定路径一致);
//! - `sessionStart` 向 stdout 回写 `env`,把 sock / tab id 注入后续 hook;
//! - 有 token 的事件额外落 `~/.kode/usage/cursor.jsonl`,给模型用量面板用。

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{json, Value};

/// 与 `kode_bridge::hook_relay::HOOK_SOCKET_PATH` 保持一致。
const DEFAULT_HOOK_SOCK: &str = "/tmp/kode-hook.sock";

/// `kode-memory cursor-hook [event]` 入口。
pub fn run(event: Option<&str>) -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let tab_id = std::env::var("KODE_SESSION_ID").ok();
    let rewritten = rewrite_payload(&input, tab_id.as_deref(), event);
    let inferred = infer_event_name(
        &serde_json::from_str(&rewritten).unwrap_or_else(|_| json!({})),
        event,
    );
    persist_usage(&rewritten)?;
    if inferred == "sessionStart" {
        write_session_start_env(tab_id.as_deref())?;
    }
    relay_rewritten(&rewritten)
}

fn relay_rewritten(rewritten: &str) -> Result<()> {
    let sock = hook_sock_path();
    if sock.is_empty() {
        return Ok(());
    }
    write_unix_line(Path::new(&sock), rewritten)
}

fn hook_sock_path() -> String {
    std::env::var("KODE_HOOK_SOCK")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_HOOK_SOCK.to_string())
}

fn rewrite_payload(input: &str, tab_id: Option<&str>, event: Option<&str>) -> String {
    let mut payload: Value = serde_json::from_str(input).unwrap_or_else(|_| json!({}));

    // Cursor's documented sessionStart input names the conversation UUID
    // `session_id`; response/stop hooks name the same value `conversation_id`.
    // Capture it before replacing session_id with kode's numeric tab id.
    let cursor_session_uuid = payload
        .get("conversation_id")
        .or_else(|| payload.get("session_uuid"))
        .or_else(|| payload.get("session_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if let Some(session_uuid) = cursor_session_uuid {
        payload["session_uuid"] = Value::String(session_uuid.clone());
        if payload.get("transcript_path").is_none() {
            if let Some(path) = find_cursor_meta_path(&session_uuid) {
                payload["transcript_path"] = Value::String(path.display().to_string());
            }
        }
    }

    if let Some(tab_id) = tab_id {
        if !tab_id.is_empty() {
            payload["session_id"] = Value::String(tab_id.to_string());
        }
    }

    let inferred = infer_event_name(&payload, event);
    if !inferred.is_empty() {
        payload["hook_event_name"] = Value::String(inferred);
    }

    payload.to_string()
}

fn infer_event_name(payload: &Value, event: Option<&str>) -> String {
    if let Some(event) = event.filter(|s| !s.is_empty()) {
        return event.to_string();
    }
    if let Some(name) = payload
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return name.to_string();
    }
    if payload.get("input_tokens").is_some() || payload.get("output_tokens").is_some() {
        return "afterAgentResponse".into();
    }
    "sessionStart".into()
}

fn write_session_start_env(tab_id: Option<&str>) -> Result<()> {
    let mut env = serde_json::Map::new();
    env.insert("KODE_HOOK_SOCK".into(), json!(hook_sock_path()));
    if let Some(tab_id) = tab_id.filter(|s| !s.is_empty()) {
        env.insert("KODE_SESSION_ID".into(), json!(tab_id));
    }
    let out = json!({ "env": env });
    let mut stdout = std::io::stdout();
    stdout.write_all(out.to_string().as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

fn persist_usage(rewritten: &str) -> Result<()> {
    let payload: Value = serde_json::from_str(rewritten).unwrap_or_else(|_| json!({}));
    let input = json_u64(&payload, "input_tokens");
    let output = json_u64(&payload, "output_tokens");
    let cached = json_u64(&payload, "cache_read_tokens");
    if input == 0 && output == 0 && cached == 0 {
        return Ok(());
    }
    let Some(path) = cursor_usage_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let record = json!({
        "timestamp": payload.get("timestamp").cloned().unwrap_or_else(|| json!(now_rfc3339())),
        "model": payload.get("model").cloned().unwrap_or(Value::Null),
        "input_tokens": input,
        "output_tokens": output,
        "cache_read_tokens": cached,
        "generation_id": payload.get("generation_id"),
        "conversation_id": payload.get("conversation_id").cloned()
            .or_else(|| payload.get("session_uuid").cloned()),
    });
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{record}")?;
    Ok(())
}

fn cursor_usage_path() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("KODE_CURSOR_USAGE_FILE") {
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    Some(
        dirs::home_dir()?
            .join(".kode")
            .join("usage")
            .join("cursor.jsonl"),
    )
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn json_u64(doc: &Value, key: &str) -> u64 {
    doc.get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|n| n as u64)))
        .unwrap_or(0)
}

fn find_cursor_meta_path(session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let root = home.join(".cursor").join("chats");
    let workspaces = std::fs::read_dir(&root).ok()?;
    for workspace in workspaces.flatten() {
        let candidate = workspace.path().join(session_id).join("meta.json");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn write_unix_line(path: &Path, line: &str) -> Result<()> {
    let mut stream = match std::os::unix::net::UnixStream::connect(path) {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    Ok(())
}

#[cfg(not(unix))]
fn write_unix_line(_path: &Path, _line: &str) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_conversation_id_and_tab_id() {
        let input = r#"{"conversation_id":"e3e9a409-7742-49e5-97ef-e3adccf24df9","model":"grok-4.6","input_tokens":100,"output_tokens":20}"#;
        let out = rewrite_payload(input, Some("42"), Some("afterAgentResponse"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_id"], "42");
        assert_eq!(v["session_uuid"], "e3e9a409-7742-49e5-97ef-e3adccf24df9");
        assert_eq!(v["hook_event_name"], "afterAgentResponse");
        assert_eq!(v["input_tokens"], 100);
        assert_eq!(v["model"], "grok-4.6");
    }

    #[test]
    fn preserves_session_start_uuid_before_replacing_session_id() {
        let input =
            r#"{"session_id":"44c2880d-36c7-4d21-9fb8-55c28eec8c63","composer_mode":"agent"}"#;
        let out = rewrite_payload(input, Some("42"), Some("sessionStart"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_id"], "42");
        assert_eq!(v["session_uuid"], "44c2880d-36c7-4d21-9fb8-55c28eec8c63");
        assert_eq!(v["hook_event_name"], "sessionStart");
    }

    #[test]
    fn keeps_existing_session_uuid_when_tab_id_is_unavailable() {
        let input = r#"{"session_id":"44c2880d-36c7-4d21-9fb8-55c28eec8c63"}"#;
        let out = rewrite_payload(input, None, Some("sessionStart"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_uuid"], "44c2880d-36c7-4d21-9fb8-55c28eec8c63");
        assert_eq!(v["session_id"], "44c2880d-36c7-4d21-9fb8-55c28eec8c63");
    }

    #[test]
    fn infers_after_agent_response_from_token_fields() {
        let input = r#"{"conversation_id":"abc","input_tokens":10}"#;
        let out = rewrite_payload(input, Some("7"), None);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hook_event_name"], "afterAgentResponse");
    }

    #[test]
    fn persist_usage_writes_token_line() {
        let path = std::env::temp_dir().join(format!(
            "kode-cursor-usage-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::env::set_var("KODE_CURSOR_USAGE_FILE", &path);
        persist_usage(
            r#"{"hook_event_name":"stop","model":"grok-4.6","input_tokens":11,"output_tokens":2,"generation_id":"g1"}"#,
        )
        .unwrap();
        persist_usage(r#"{"hook_event_name":"sessionStart"}"#).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).ok();
        std::env::remove_var("KODE_CURSOR_USAGE_FILE");
        assert!(text.contains("\"input_tokens\":11"));
        assert!(text.contains("grok-4.6"));
        assert_eq!(text.lines().count(), 1);
    }
}
