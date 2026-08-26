//! Codex command hook entrypoint.
//!
//! Codex hooks currently execute command handlers only. This module adapts the
//! existing kode-memory prompt-only workflow to Codex by:
//! - returning memory guidance as `SessionStart` additional developer context;
//! - relaying session/prompt/tool lifecycle events to kode GUI through `KODE_HOOK_SOCK`;
//! - conservatively continuing `Stop` when an explicit memory trigger appears
//!   but no memory proposal was made.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

const MEMORY_TOOL_MARKERS: &[&str] = &["memory_propose", "mcp__memory__memory_propose"];

const MEMORY_TRIGGER_MARKERS: &[&str] = &[
    "记住",
    "以后都",
    "以后用",
    "以后不要",
    "别再",
    "不要再",
    "这是规范",
    "这个规范",
    "就这么定",
    "用户拍板",
    "remember",
    "always use",
    "never again",
];

#[derive(Debug, Deserialize)]
struct HookInput {
    #[serde(default)]
    hook_event_name: String,
    #[serde(default)]
    cwd: Option<PathBuf>,
    #[serde(default)]
    transcript_path: Option<PathBuf>,
    #[serde(default)]
    stop_hook_active: bool,
    #[serde(default)]
    last_assistant_message: Option<String>,
}

/// Run from the `kode-memory codex-hook` CLI subcommand.
pub fn run() -> Result<()> {
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    if let Some(output) = handle_json(&input)? {
        println!("{output}");
    }
    Ok(())
}

fn handle_json(input: &str) -> Result<Option<String>> {
    if input.trim().is_empty() {
        return Ok(None);
    }
    let hook: HookInput = serde_json::from_str(input).context("parse Codex hook stdin JSON")?;

    match hook.hook_event_name.as_str() {
        "SessionStart" => {
            relay_to_kode(input)?;
            session_start_output(&hook)
        }
        "Stop" => stop_output(&hook),
        "PermissionRequest" | "UserPromptSubmit" | "PreToolUse" => {
            relay_to_kode(input)?;
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn session_start_output(hook: &HookInput) -> Result<Option<String>> {
    let cwd = hook.cwd.as_deref().unwrap_or_else(|| Path::new(""));
    let prompt = crate::prompt::build(cwd, "codex");
    if prompt.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(
        json!({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": prompt
            }
        })
        .to_string(),
    ))
}

fn stop_output(hook: &HookInput) -> Result<Option<String>> {
    if hook.stop_hook_active {
        return Ok(None);
    }

    let transcript = read_transcript_excerpt(hook.transcript_path.as_deref())?;
    let mut searchable = String::new();
    searchable.push_str(&transcript);
    if let Some(last) = &hook.last_assistant_message {
        searchable.push('\n');
        searchable.push_str(last);
    }

    if contains_any(&searchable, MEMORY_TOOL_MARKERS)
        || !contains_any(&searchable, MEMORY_TRIGGER_MARKERS)
    {
        return Ok(None);
    }

    let cwd = hook.cwd.as_deref().unwrap_or_else(|| Path::new(""));
    let scope = project_scope(cwd);
    let reason = format!(
        "本轮出现了显式 memory/规范触发词，但 transcript 中没有看到 memory_propose。请先用 memory_search 在 scope=\"{scope}\" 查重；确有长期价值时调用 memory_propose(author=\"codex\", scope=\"{scope}\", title=短英文标题, body=结论+why)。若已有等价 fact、MCP out_of_energy 或判断不值得沉淀，说明原因后直接结束。"
    );

    Ok(Some(
        json!({
            "decision": "block",
            "reason": reason
        })
        .to_string(),
    ))
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    let lower = haystack.to_lowercase();
    needles
        .iter()
        .any(|needle| lower.contains(&needle.to_lowercase()))
}

fn read_transcript_excerpt(path: Option<&Path>) -> Result<String> {
    let Some(path) = path else {
        return Ok(String::new());
    };
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Ok(String::new()),
    };
    const MAX_BYTES: usize = 1024 * 1024;
    let start = bytes.len().saturating_sub(MAX_BYTES);
    Ok(String::from_utf8_lossy(&bytes[start..]).to_string())
}

fn project_scope(cwd: &Path) -> String {
    cwd.file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| format!("project:{s}"))
        .unwrap_or_else(|| "shared".to_string())
}

fn relay_to_kode(input: &str) -> Result<()> {
    let Ok(sock) = std::env::var("KODE_HOOK_SOCK") else {
        return Ok(());
    };
    if sock.is_empty() {
        return Ok(());
    }
    if std::env::var("KODE_BACKEND_KEY").is_ok_and(|backend| backend != "codex") {
        return Ok(());
    }

    let tab_id = std::env::var("KODE_SESSION_ID").ok();
    let rewritten = rewrite_payload(input, tab_id.as_deref());
    write_unix_line(Path::new(&sock), &rewritten)
}

/// 把 Codex hook payload 改写成 GUI relay 可路由的形式。
///
/// Codex 原始 `session_id` 是 rollout/session uuid；GUI HookRelay 的 `session_id`
/// 是 kode tab id(u64)。这里保留原 uuid 到 `codex_session_uuid`，再把 `session_id`
/// 改成 `$KODE_SESSION_ID`，使 `SessionStart.transcript_path` 能精确 retarget 对应 tab。
fn rewrite_payload(input: &str, tab_id: Option<&str>) -> String {
    let mut payload: Value = serde_json::from_str(input).unwrap_or_else(|_| json!({}));

    if let Some(orig) = payload.get("session_id").cloned() {
        if orig.is_string() {
            payload["codex_session_uuid"] = orig;
        }
    }

    if let Some(tab_id) = tab_id {
        if !tab_id.is_empty() {
            payload["session_id"] = Value::String(tab_id.to_string());
        }
    }

    payload.to_string()
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
    fn session_start_returns_additional_context() {
        let out = handle_json(
            r#"{"hook_event_name":"SessionStart","cwd":"/tmp/kode","session_id":"abc"}"#,
        )
        .unwrap()
        .unwrap();
        assert!(out.contains("hookSpecificOutput"));
        assert!(out.contains("SessionStart"));
        assert!(out.contains("project:kode"));
        assert!(out.contains("<kode-memory>"));
    }

    #[test]
    fn stop_noops_when_already_active() {
        let out = handle_json(r#"{"hook_event_name":"Stop","stop_hook_active":true}"#).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn stop_blocks_on_explicit_memory_trigger_without_propose() {
        let out = handle_json(
            r#"{"hook_event_name":"Stop","cwd":"/tmp/kode","last_assistant_message":"用户说：记住，以后都用 X。"}"#,
        )
        .unwrap()
        .unwrap();
        assert!(out.contains(r#""decision":"block""#));
        assert!(out.contains("memory_search"));
        assert!(out.contains("project:kode"));
    }

    #[test]
    fn stop_noops_when_memory_propose_already_seen() {
        let out = handle_json(
            r#"{"hook_event_name":"Stop","last_assistant_message":"记住这条。已调用 memory_propose。"}"#,
        )
        .unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn rewrites_session_id_to_tab_id_and_preserves_codex_uuid() {
        let input = r#"{"session_id":"codex-uuid","transcript_path":"/p/rollout.jsonl","hook_event_name":"SessionStart","source":"startup","model":"gpt-5"}"#;
        let out = rewrite_payload(input, Some("42"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_id"], "42");
        assert_eq!(v["codex_session_uuid"], "codex-uuid");
        assert_eq!(v["transcript_path"], "/p/rollout.jsonl");
        assert_eq!(v["hook_event_name"], "SessionStart");
    }

    #[test]
    fn missing_tab_id_keeps_original_codex_session_id() {
        let input = r#"{"session_id":"codex-uuid","hook_event_name":"UserPromptSubmit"}"#;
        let out = rewrite_payload(input, None);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_id"], "codex-uuid");
        assert_eq!(v["codex_session_uuid"], "codex-uuid");
    }
}
