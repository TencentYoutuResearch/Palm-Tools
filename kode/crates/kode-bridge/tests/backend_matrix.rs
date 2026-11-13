//! kode-bridge 层的全 backend 统一矩阵(语义解析 / 能力映射)。
//!
//! 与 `kode-core/src/backend_matrix.rs` 同构,数据源同样是 `Config::default()`
//! 的 17 个 backend。`semantic.rs` 里已有大量按单 backend 的 `parse_line`
//! 单测,这里补的是「统一矩阵视图」:一次遍历覆盖全部 backend 的
//! key → Backend 变体映射、transcript 行解析结果、脏行鲁棒性。
//! 新增 backend 忘记登记会由 golden 断言立刻暴露。

use std::collections::BTreeSet;

use kode_bridge::semantic::parse_line;
use kode_core::config::Config;
use kode_core::session::jsonl_tail::Backend;

/// 与 `Config::default()` 的 key 集一一对应的 golden 清单(17 项,字典序)。
const BACKEND_KEYS: &[&str] = &[
    "amp",
    "antigravity",
    "claude",
    "claude-internal",
    "codebuddy",
    "codex",
    "copilot",
    "cursor",
    "droid",
    "gemini",
    "grok",
    "kimi",
    "kiro",
    "opencode",
    "pi",
    "tclaude",
    "tcodex",
];

/// 每个内置 key 是否进入 semantic 层、映射到哪个 transcript 解析器。
/// `None` = 没有 jsonl tail(9 个 preset);`Opencode` = 有变体但解析为空,
/// 结构化事件走 ACP;`Kimi` = 只接 metadata tail,语义解析为空。
const EXPECTED_KIND: &[(&str, Option<Backend>)] = &[
    ("amp", None),
    ("antigravity", None),
    ("claude", Some(Backend::Claude)),
    ("claude-internal", Some(Backend::Claude)),
    ("codebuddy", Some(Backend::Codebuddy)),
    ("codex", Some(Backend::Codex)),
    ("copilot", None),
    ("cursor", Some(Backend::Cursor)),
    ("droid", None),
    ("gemini", None),
    ("grok", None),
    ("kimi", Some(Backend::Kimi)),
    ("kiro", None),
    ("opencode", Some(Backend::Opencode)),
    ("pi", None),
    ("tclaude", Some(Backend::Tclaude)),
    ("tcodex", Some(Backend::Tcodex)),
];

#[test]
fn backend_keys_match_golden() {
    let cfg = Config::default();
    let config: BTreeSet<&str> = cfg.backends.keys().map(String::as_str).collect();
    let golden: BTreeSet<&str> = BACKEND_KEYS.iter().copied().collect();
    let expected: BTreeSet<&str> = EXPECTED_KIND.iter().map(|(key, _)| *key).collect();
    assert_eq!(golden.len(), 17, "BACKEND_KEYS has a duplicate or wrong size");
    assert_eq!(config, golden, "update BACKEND_KEYS when adding a backend");
    assert_eq!(expected, golden, "update EXPECTED_KIND when adding a backend");
    assert_eq!(config.len(), 17);
}

#[test]
fn semantic_kind_mapping_all() {
    for (key, expected) in EXPECTED_KIND {
        assert_eq!(
            Backend::from_backend_key(key),
            *expected,
            "{key} semantic parser mapping changed"
        );
    }
}

/// 每个有解析器的 Backend 变体各喂一行该格式的 transcript,断事件类型;
/// opencode / kimi 对任意行返回空(opencode 走 ACP,kimi 尚未解析语义)。
#[test]
fn transcript_line_matrix_all() {
    let fixtures: &[(Backend, &str, &str)] = &[
        (
            Backend::Codebuddy,
            r#"{"type":"message","role":"user","content":"hi"}"#,
            "message",
        ),
        (
            Backend::Claude,
            r#"{"type":"user","message":{"role":"user","content":"hi there"}}"#,
            "message",
        ),
        (
            Backend::Tclaude,
            r#"{"type":"user","message":{"role":"user","content":"hi there"}}"#,
            "message",
        ),
        (
            Backend::Codex,
            r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","duration_ms":1,"last_agent_message":"done"}}"#,
            "session.turn_finished",
        ),
        (
            Backend::Tcodex,
            r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","duration_ms":1,"last_agent_message":"done"}}"#,
            "session.turn_finished",
        ),
        (
            Backend::Cursor,
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\nhi\n</user_query>"}]}}"#,
            "message",
        ),
        (Backend::Opencode, r#"{"anything":1}"#, ""),
        (
            Backend::Kimi,
            r#"{"type":"turn.prompt","agentId":"main","input":[{"type":"text","text":"hi"}]}"#,
            "",
        ),
    ];
    for (backend, line, expected_type) in fixtures {
        let events = parse_line(7, *backend, line);
        if expected_type.is_empty() {
            assert!(
                events.is_empty(),
                "{backend:?} should not parse transcript lines"
            );
        } else {
            assert!(
                !events.is_empty(),
                "{backend:?} should parse its own transcript line"
            );
            assert_eq!(events[0].r#type, *expected_type, "{backend:?}");
            assert_eq!(events[0].session_id, 7, "{backend:?} session id");
        }
    }
}

/// 所有 Backend 变体面对脏行都返回空,不 panic、不产出假事件。
#[test]
fn every_backend_rejects_garbage_lines() {
    for kind in [
        Backend::Codebuddy,
        Backend::Claude,
        Backend::Tclaude,
        Backend::Codex,
        Backend::Tcodex,
        Backend::Cursor,
        Backend::Opencode,
        Backend::Kimi,
    ] {
        for line in ["not json", "{}", "[]"] {
            assert!(
                parse_line(1, kind, line).is_empty(),
                "{kind:?} should ignore {line:?}"
            );
        }
    }
}
