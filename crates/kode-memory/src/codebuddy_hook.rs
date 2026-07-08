//! CodeBuddy / Claude command hook entrypoint(`kode-memory codebuddy-hook`)。
//!
//! kode GUI 给 codebuddy/claude 注入的 hook command 走这个 bridge,而不是裸 `cat | nc`。
//! 原因:codebuddy hook payload 的 `session_id` 是 codebuddy 自己的真实 session uuid
//! (字符串),而 kode 的 HookRelay 用 `session_id` parse u64 来路由到对应 tab(KODE_SESSION_ID)。
//! 裸转发会让 relay parse 失败丢弃事件(历史 Bug:codebuddy 的 attention/mode hook 实际不工作)。
//!
//! 本 bridge 在转发前:
//! - 把原始 `session_id`(codebuddy 真实 uuid)另存到 `codebuddy_session_uuid` 字段;
//! - 把 `session_id` 改写成 `$KODE_SESSION_ID`(kode tab id),让 relay 能 parse u64 路由;
//! - 保留 `transcript_path`(codebuddy 给的确切 jsonl 路径)/ `source` / `model` 等字段。
//!
//! 这样 relay 收到 SessionStart 时,既知道是哪个 tab(改写后的 session_id = tab id),
//! 又知道该 tab 当前绑定的真实 codebuddy session(codebuddy_session_uuid)及其 jsonl 文件
//! (transcript_path)。SessionStart 在 `--resume` / `/resume` / `/clear` 时都会触发
//! (source 分别为 resume / clear),是 kode 权威跟踪 tab↔session 绑定的信号。

use std::io::{Read, Write};
use std::path::Path;

use anyhow::Result;
use serde_json::{json, Value};

/// `kode-memory codebuddy-hook` 子命令入口。读 stdin JSON,改写后转发到 relay。
pub fn run() -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    relay_to_kode(&input)
}

/// 改写 payload 并转发到 `$KODE_HOOK_SOCK`。非 kode 环境(无 env)直接 no-op。
fn relay_to_kode(input: &str) -> Result<()> {
    let Ok(sock) = std::env::var("KODE_HOOK_SOCK") else {
        return Ok(());
    };
    if sock.is_empty() {
        return Ok(());
    }

    let tab_id = std::env::var("KODE_SESSION_ID").ok();
    let rewritten = rewrite_payload(input, tab_id.as_deref());
    write_unix_line(Path::new(&sock), &rewritten)
}

/// 把原始 hook JSON 改写为 relay 可路由的形式(纯函数,供测试)。
///
/// - 原始 `session_id`(codebuddy uuid)→ 复制到 `codebuddy_session_uuid`;
/// - `session_id` ← `tab_id`(来自 `$KODE_SESSION_ID`);`None`/空时保持原值
///   (relay 仍会因 parse u64 失败而跳过,但不至于崩)。
/// - 其余字段(transcript_path / source / model / hook_event_name ...)原样保留。
/// - 输入非法 JSON 时退化成只带 session_id 的对象,保证 relay 收到合法行。
fn rewrite_payload(input: &str, tab_id: Option<&str>) -> String {
    let mut payload: Value = serde_json::from_str(input).unwrap_or_else(|_| json!({}));

    // 保留 codebuddy 真实 uuid
    if let Some(orig) = payload.get("session_id").cloned() {
        if orig.is_string() {
            payload["codebuddy_session_uuid"] = orig;
        }
    }

    // session_id 改写成 kode tab id(供 relay parse u64 路由)
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
    fn rewrites_session_id_to_tab_id_and_preserves_uuid() {
        let input = r#"{"session_id":"094f83f6-uuid","transcript_path":"/p/094f83f6-uuid.jsonl","hook_event_name":"SessionStart","source":"resume","model":"opus"}"#;
        let out = rewrite_payload(input, Some("42"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_id"], "42"); // 改写成 tab id
        assert_eq!(v["codebuddy_session_uuid"], "094f83f6-uuid"); // 真实 uuid 保留
        assert_eq!(v["transcript_path"], "/p/094f83f6-uuid.jsonl");
        assert_eq!(v["source"], "resume");
        assert_eq!(v["model"], "opus");
        assert_eq!(v["hook_event_name"], "SessionStart");
    }

    #[test]
    fn handles_invalid_json_gracefully() {
        let out = rewrite_payload("not json", Some("7"));
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_id"], "7");
    }

    #[test]
    fn missing_tab_id_keeps_original_session_id() {
        let input = r#"{"session_id":"abc","hook_event_name":"PreToolUse"}"#;
        let out = rewrite_payload(input, None);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["session_id"], "abc");
        assert_eq!(v["codebuddy_session_uuid"], "abc");
    }
}
