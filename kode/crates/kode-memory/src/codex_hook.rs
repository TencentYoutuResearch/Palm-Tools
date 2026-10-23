//! Codex command hook entrypoint.
//!
//! Codex hooks currently execute command handlers only. This module adapts the
//! existing kode-memory prompt-only workflow to Codex by:
//! - returning memory guidance as `SessionStart` additional developer context;
//! - relaying session/prompt/tool lifecycle events to kode GUI through `KODE_HOOK_SOCK`;
//! - conservatively continuing `Stop` when an explicit memory trigger appears
//!   but no memory proposal was made.

use std::collections::HashSet;
#[cfg(all(unix, not(test)))]
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

const CODEX_BACKENDS: &[&str] = &["codex", "tcodex"];

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
    // Hooks are installed in Codex's user configuration so upgrades remain
    // automatic. Outside a Kode-owned Codex process they must be invisible:
    // no prompt injection, no Stop blocking, and no relay side effects.
    let Some(backend) = crate::runtime_context::active_backend_for(CODEX_BACKENDS) else {
        return Ok(());
    };
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    if let Some(output) = handle_json(&input, &backend)? {
        println!("{output}");
    }
    Ok(())
}

fn handle_json(input: &str, backend: &str) -> Result<Option<String>> {
    if input.trim().is_empty() {
        return Ok(None);
    }
    let hook: HookInput = serde_json::from_str(input).context("parse Codex hook stdin JSON")?;

    match hook.hook_event_name.as_str() {
        "SessionStart" => {
            relay_to_kode(input)?;
            session_start_output(&hook, backend)
        }
        "Stop" => stop_output(&hook, backend),
        "PermissionRequest" | "UserPromptSubmit" | "PreToolUse" => {
            relay_to_kode(input)?;
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn session_start_output(hook: &HookInput, backend: &str) -> Result<Option<String>> {
    let cwd = hook.cwd.as_deref().unwrap_or_else(|| Path::new(""));
    let prompt = crate::prompt::build(cwd, backend);
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

fn stop_output(hook: &HookInput, backend: &str) -> Result<Option<String>> {
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

    let (search_available, proposal_seen) = memory_tool_evidence(&transcript);
    if !search_available || proposal_seen || !contains_any(&searchable, MEMORY_TRIGGER_MARKERS) {
        return Ok(None);
    }

    let cwd = hook.cwd.as_deref().unwrap_or_else(|| Path::new(""));
    let scope = project_scope(cwd);
    let reason = format!(
        "本轮出现了显式 memory/规范触发词，但 transcript 中没有看到 memory_propose。请先用 memory_search 在 scope=\"{scope}\" 查重；确有长期价值时调用 memory_propose(author=\"{backend}\", scope=\"{scope}\", title=短英文标题, body=结论+why)。若工具不可用、已有等价 fact、MCP out_of_energy 或判断不值得沉淀，直接结束，不要反复查找不存在的工具。"
    );

    Ok(Some(
        json!({
            "decision": "block",
            "reason": reason
        })
        .to_string(),
    ))
}

/// Tool names in messages are not evidence that a session has working MCP tools.
fn memory_tool_evidence(transcript: &str) -> (bool, bool) {
    let mut search_calls = HashSet::new();
    let mut search_available = false;
    let mut proposal_seen = false;
    for line in transcript.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if entry["type"] != "response_item" {
            continue;
        }
        let payload = &entry["payload"];
        match payload["type"].as_str() {
            Some("function_call") => {
                let name = payload["name"].as_str().unwrap_or("");
                if matches!(name, "memory_propose" | "mcp__memory__memory_propose") {
                    proposal_seen = true;
                }
                if matches!(name, "memory_search" | "mcp__memory__memory_search") {
                    if let Some(id) = payload["call_id"].as_str() {
                        search_calls.insert(id.to_string());
                    }
                }
            }
            Some("function_call_output") => {
                if !payload["call_id"]
                    .as_str()
                    .is_some_and(|id| search_calls.contains(id))
                {
                    continue;
                }
                // The memory MCP returns a JSON search-hit array (including []).
                // Error strings, discovery results, and unmatched calls fail open.
                search_available = memory_search_result_succeeded(&payload["output"]);
            }
            _ => {}
        }
    }
    (search_available, proposal_seen)
}

fn memory_search_result_succeeded(output: &Value) -> bool {
    let parsed = output
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let output = parsed.as_ref().unwrap_or(output);
    if output.get("isError").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if output.is_array() {
        return true;
    }
    output
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|content| {
            content.iter().any(|block| {
                block["text"]
                    .as_str()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .is_some_and(|value| value.is_array())
            })
        })
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

#[cfg(test)]
fn relay_to_kode(_input: &str) -> Result<()> {
    // Unit tests exercise parsing/output, never a developer's live host socket.
    Ok(())
}

#[cfg(not(test))]
fn relay_to_kode(input: &str) -> Result<()> {
    let Ok(sock) = std::env::var("KODE_HOOK_SOCK") else {
        return Ok(());
    };
    if sock.is_empty() {
        return Ok(());
    }
    if crate::runtime_context::active_backend_for(CODEX_BACKENDS).is_none() {
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

#[cfg(all(unix, not(test)))]
fn write_unix_line(path: &Path, line: &str) -> Result<()> {
    let mut stream = match std::os::unix::net::UnixStream::connect(path) {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    Ok(())
}

#[cfg(all(not(unix), not(test)))]
fn write_unix_line(_path: &Path, _line: &str) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search_transcript() -> tempfile::NamedTempFile {
        use std::io::Write;
        let mut transcript = tempfile::NamedTempFile::new().unwrap();
        writeln!(transcript, "{}", json!({
            "type": "response_item",
            "payload": {"type":"function_call","name":"mcp__memory__memory_search","call_id":"search"}
        })).unwrap();
        writeln!(
            transcript,
            "{}",
            json!({
                "type": "response_item",
                "payload": {"type":"function_call_output","call_id":"search","output":"[]"}
            })
        )
        .unwrap();
        transcript
    }

    #[test]
    fn codex_family_requires_bound_kode_backend() {
        for backend in ["codex", "tcodex"] {
            assert_eq!(
                crate::runtime_context::active_backend_for_values(
                    Some("1"),
                    Some("42"),
                    Some(backend),
                    CODEX_BACKENDS
                ),
                Some(backend)
            );
            for (host, session_id) in [
                (None, Some("42")),
                (Some("1"), None),
                (Some("0"), Some("42")),
            ] {
                assert!(crate::runtime_context::active_backend_for_values(
                    host,
                    session_id,
                    Some(backend),
                    CODEX_BACKENDS
                )
                .is_none());
            }
        }
        for backend in ["tclaude", "claude", "custom-codex"] {
            assert!(crate::runtime_context::active_backend_for_values(
                Some("1"),
                Some("42"),
                Some(backend),
                CODEX_BACKENDS
            )
            .is_none());
        }
    }

    #[test]
    fn tcodex_session_start_and_stop_use_actual_backend_author() {
        let start = handle_json(
            r#"{"hook_event_name":"SessionStart","cwd":"/tmp/kode"}"#,
            "tcodex",
        )
        .unwrap()
        .unwrap();
        let start: Value = serde_json::from_str(&start).unwrap();
        let context = start["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(context.contains("backend=`tcodex`"));
        assert!(context.contains("author=\"tcodex\""));
        assert!(!context.contains("author=\"codex\""));

        let transcript = search_transcript();
        let stop = handle_json(
            &json!({"hook_event_name":"Stop","cwd":"/tmp/kode","last_assistant_message":"记住这条规范","transcript_path":transcript.path()}).to_string(),
            "tcodex",
        ).unwrap().unwrap();
        let stop: Value = serde_json::from_str(&stop).unwrap();
        let reason = stop["reason"].as_str().unwrap();
        assert_eq!(stop["decision"], "block");
        assert!(reason.contains("author=\"tcodex\""));
        assert!(!reason.contains("author=\"codex\""));
        assert!(reason.contains("scope=\"project:kode\""));
        assert!(handle_json(
            r#"{"hook_event_name":"Stop","stop_hook_active":true}"#,
            "tcodex"
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn rewrites_tcodex_session_id_without_changing_rollout_path() {
        let input = r#"{"session_id":"tcodex-uuid","transcript_path":"/home/test/.tcodex/sessions/rollout.jsonl","hook_event_name":"SessionStart"}"#;
        let payload: Value = serde_json::from_str(&rewrite_payload(input, Some("44"))).unwrap();
        assert_eq!(payload["session_id"], "44");
        assert_eq!(payload["codex_session_uuid"], "tcodex-uuid");
        assert_eq!(
            payload["transcript_path"],
            "/home/test/.tcodex/sessions/rollout.jsonl"
        );
    }

    #[test]
    fn tcodex_lifecycle_events_relay_without_prompt_output() {
        for event in ["PermissionRequest", "UserPromptSubmit", "PreToolUse"] {
            let input = json!({"hook_event_name": event, "session_id": "tcodex-uuid"}).to_string();
            assert!(handle_json(&input, "tcodex").unwrap().is_none());
        }
    }

    #[test]
    fn session_start_returns_additional_context() {
        let out = handle_json(
            r#"{"hook_event_name":"SessionStart","cwd":"/tmp/kode","session_id":"abc"}"#,
            "codex",
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
        let out = handle_json(
            r#"{"hook_event_name":"Stop","stop_hook_active":true}"#,
            "codex",
        )
        .unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn stop_blocks_on_explicit_memory_trigger_without_propose() {
        let transcript = search_transcript();
        let out = handle_json(
            &json!({"hook_event_name":"Stop","cwd":"/tmp/kode","last_assistant_message":"用户说：记住，以后都用 X。","transcript_path":transcript.path()}).to_string(),
            "codex",
        )
        .unwrap()
        .unwrap();
        assert!(out.contains(r#""decision":"block""#));
        assert!(out.contains("memory_search"));
        assert!(out.contains("project:kode"));
    }

    #[test]
    fn stop_noops_when_memory_propose_already_seen() {
        use std::io::Write;
        let mut transcript = search_transcript();
        writeln!(transcript, "{}", json!({
            "type": "response_item",
            "payload": {"type":"function_call","name":"mcp__memory__memory_propose","call_id":"propose"}
        })).unwrap();
        let out = handle_json(
            &json!({"hook_event_name":"Stop","last_assistant_message":"记住这条。","transcript_path":transcript.path()}).to_string(),
            "codex",
        )
        .unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn stop_noops_without_working_memory_tools() {
        for path in [None, Some("/missing/transcript.jsonl")] {
            let input = json!({
                "hook_event_name":"Stop", "last_assistant_message":"记住这条规范",
                "transcript_path":path
            });
            assert!(handle_json(&input.to_string(), "codex").unwrap().is_none());
        }
    }

    #[test]
    fn memory_evidence_ignores_mentions_discovery_and_failed_searches() {
        assert_eq!(
            memory_tool_evidence(
                r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"text":"记住，memory_search / memory_propose"}]}}"#
            ),
            (false, false)
        );
        let call = json!({"type":"response_item","payload":{"type":"function_call","name":"mcp__memory__memory_search","call_id":"search"}});
        for output in [
            json!("tool not found"),
            json!({"isError":true,"content":[{"text":"[]"}]}),
            json!({"error":"connection failed"}),
        ] {
            let result = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"search","output":output}});
            assert_eq!(
                memory_tool_evidence(&format!("{call}\n{result}")),
                (false, false)
            );
        }
        let discovery = json!({"type":"response_item","payload":{"type":"function_call","name":"tool_search","call_id":"search","arguments":"memory_search"}});
        let result = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"search","output":"[]"}});
        assert_eq!(
            memory_tool_evidence(&format!("{discovery}\n{result}")),
            (false, false)
        );
        assert!(memory_search_result_succeeded(&json!({
            "content":[{"type":"text","text":"[]"}]
        })));
    }

    #[test]
    fn stop_does_not_treat_proposal_mentions_as_real_calls() {
        let transcript = search_transcript();
        let input = json!({
            "hook_event_name":"Stop","last_assistant_message":"记住这条。已调用 memory_propose。",
            "transcript_path":transcript.path()
        });
        assert!(handle_json(&input.to_string(), "codex").unwrap().is_some());
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
