use std::path::PathBuf;

use super::*;

#[test]
fn bridge_history_coalesces_meta_without_evicting_messages() {
    let bus = BridgeBus::new();
    let mut live = bus.subscribe();
    bus.emit(EventEnvelope::new(
        7,
        "message",
        json!({"id":"m1","role":"assistant","text":"kept"}),
    ));
    bus.emit(EventEnvelope::new(
        7,
        "meta",
        json!({"model":"gpt-5.6-sol","tokens":1,"title":"analysis"}),
    ));
    // Coalescing is history-only. Live consumers still receive the original
    // message/meta events rather than a synthesized snapshot.
    assert_eq!(live.try_recv().unwrap().r#type, "message");
    assert_eq!(live.try_recv().unwrap().payload["tokens"], 1);

    for tokens in 2..=1200 {
        bus.emit(EventEnvelope::new(
            7,
            "meta",
            json!({"model":null,"tokens":tokens,"title":null}),
        ));
    }

    let history = bus.history_for(7, 0, 1000);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].r#type, "message");
    assert_eq!(history[0].payload["text"], "kept");
    assert_eq!(history[1].r#type, "meta");
    assert_eq!(history[1].payload["model"], "gpt-5.6-sol");
    assert_eq!(history[1].payload["title"], "analysis");
    assert_eq!(history[1].payload["tokens"], 1200);
}

fn config_with_fake_codebuddy() -> Config {
    let mut config = Config::default();
    let backend = config
        .backends
        .get_mut("codebuddy")
        .expect("default config should include codebuddy");
    backend.command = "/bin/sh".to_string();
    backend.args = vec!["-c".to_string(), "sleep 5".to_string()];
    backend.model_flag = None;
    backend.permission_mode_flag = None;
    backend.default_model = None;
    config
}

#[test]
fn answer_input_selects_and_confirms_the_choice() {
    assert_eq!(answer_input(0), b"\r");
    assert_eq!(answer_input(3), b"\x1b[B\x1b[B\x1b[B\r");
}

#[test]
fn mobile_text_input_strips_only_trailing_line_endings() {
    assert_eq!(text_input_body("hello\n"), "hello");
    assert_eq!(text_input_body("hello\r\n"), "hello");
    assert_eq!(text_input_body("first\nsecond\n"), "first\nsecond");
    assert_eq!(text_input_body("\n"), "");
    assert_eq!(text_input_body("plain text"), "plain text");
}

#[tokio::test]
async fn mobile_text_input_submits_with_a_separate_carriage_return() {
    use std::collections::HashMap;

    let root = std::env::temp_dir().join(format!(
        "kode-bridge-mobile-input-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let captured = root.join("input.bin");

    let mut backends = HashMap::new();
    backends.insert(
        "capture".to_string(),
        BackendConfig {
            command: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                format!(
                    "stty raw -echo; dd bs=1 count=6 of='{}' 2>/dev/null",
                    captured.display()
                ),
            ],
            default_model: None,
            model_flag: None,
            permission_mode_flag: None,
            mcp_setup: None,
            enabled: None,
        },
    );
    let ctx = build_test_ctx(
        Config {
            default_backend: "capture".to_string(),
            backends,
            ui: kode_core::config::UiConfig::default(),
        },
        "test-mobile-input".to_string(),
    );
    let session = create_session(
        axum::Extension(Arc::clone(&ctx)),
        axum::Json(CreateSessionReq {
            backend_key: "capture".to_string(),
            cwd: Some(
                std::env::current_dir()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            ),
            cols: Some(80),
            rows: Some(24),
            permission_mode: None,
            model: None,
            resume_session_uuid: None,
            memory_context: None,
            extra_args: None,
            prompt: None,
            headless: false,
            term_theme: None,
        }),
    )
    .await
    .expect("capture session should start");

    // Give the child enough time to switch the slave PTY into raw mode.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let status = post_input(
        axum::Extension(Arc::clone(&ctx)),
        axum::extract::Path(session.id),
        axum::Json(InputReq {
            text: Some("hello\n".to_string()),
            bytes_b64: None,
        }),
    )
    .await
    .expect("mobile text input should be accepted");
    assert_eq!(status, StatusCode::NO_CONTENT);

    let mut bytes = Vec::new();
    for _ in 0..50 {
        if let Ok(found) = std::fs::read(&captured) {
            if found.len() >= 6 {
                bytes = found;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(bytes, b"hello\r");

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn create_session_sanitizes_requested_model() {
    assert_eq!(
        sanitize_requested_model(Some("Claude-Opus-4.8-1M Note: The model was saved")).as_deref(),
        Some("Claude-Opus-4.8-1M")
    );
    assert_eq!(sanitize_requested_model(Some("auto")), None);
    assert_eq!(sanitize_requested_model(Some(" \n ")), None);
    assert_eq!(sanitize_requested_model(None), None);
}

#[test]
fn git_history_helpers_parse_summary_additions() {
    let branches = parse_git_branches(
        "refs/heads/main\x1fmain\x1f*\nrefs/remotes/origin/HEAD\x1forigin/HEAD\x1f \nrefs/remotes/origin/dev\x1forigin/dev\x1f ",
    );
    assert_eq!(branches.len(), 2);
    assert!(branches[0].current);
    assert!(!branches[0].remote);
    assert_eq!(branches[1].name, "origin/dev");
    assert!(branches[1].remote);

    let commits = parse_git_commits(
        "0123456789abcdef\x1f0123456\x1fAlice\x1f1720000000\x1fadd git history\x1fabcdef0 1111111\x1fHEAD -> main, origin/main, tag: v1\n",
    );
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].short_hash, "0123456");
    assert_eq!(commits[0].subject, "add git history");
    assert_eq!(commits[0].parents, vec!["abcdef0", "1111111"]);
    assert_eq!(
        commits[0].decorations,
        vec!["HEAD", "main", "origin/main", "tag: v1"]
    );

    let labels = parse_commit_decorations(
        "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1",
    );
    assert_eq!(labels, vec!["HEAD", "main", "origin/main", "tag: v1"]);

    let detail = parse_commit_detail(
        "0123456",
        "full message\n\nbody\x1e\nM\tapps/gui/src/lib/WorkspacePanel.svelte\nA\tnew-file.txt\n",
    );
    assert_eq!(detail.message, "full message\n\nbody");
    assert_eq!(detail.files.len(), 2);
    assert_eq!(detail.files[0].status, "M");

    assert!(is_valid_commit_hash("0123456"));
    assert!(!is_valid_commit_hash("main"));
}

/// 新增的 `/api/v1/memory/recent` 路由(GUI Browse 面板远端历史入口)契约:
/// 已 approve 的 fact 应能通过 memory_recent handler 拉出,形态与 /search 一致
/// (hits 数组,带 id/body/snippet/scope 等)。
#[tokio::test]
async fn memory_recent_returns_approved_facts() {
    use kode_memory::{store::Verdict, Scope};

    let root = std::env::temp_dir().join(format!(
        "kode-bridge-mem-recent-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).unwrap();

    // 直接构造一个带 memory vault 的 Ctx(build_test_ctx 的 memory 是 None)
    let store = kode_memory::MemoryStore::open(&root).expect("open store");
    let budget = kode_memory::BudgetStore::open(&root).expect("open budget");
    let mem = Arc::new(MemoryHandle {
        root: root.clone(),
        store: tokio::sync::Mutex::new(store),
        budget: tokio::sync::Mutex::new(budget),
    });

    // propose 一条 → review 通过 → 进 facts 表
    {
        let mut store = mem.store.lock().await;
        let res = store
            .propose(
                "tester",
                None,
                Scope::parse("shared").unwrap(),
                "recent route smoke fact",
                vec!["smoke".into()],
                None,
                Some(0.9),
                None,
                true,
                None,
                None,
            )
            .expect("propose");
        let id = match res {
            kode_memory::store::ProposeResult::Accepted { id } => id,
            other => panic!("unexpected propose result: {other:?}"),
        };
        store.review(&id, Verdict::Approve).expect("approve");
    }

    let base = build_test_ctx(Config::default(), "t".into());
    let ctx = Arc::new(Ctx {
        config: base.config.clone(),
        sessions: Arc::clone(&base.sessions),
        core_tx: base.core_tx.clone(),
        next_id: Arc::clone(&base.next_id),
        bus: Arc::clone(&base.bus),
        token: Arc::clone(&base.token),
        shells: Arc::clone(&base.shells),
        memory: Some(mem),
        listen_addr: Arc::clone(&base.listen_addr),
        hook_relay_socket: None,
    });

    let Json(body) = memory_recent(
        axum::Extension(Arc::clone(&ctx)),
        axum::extract::Query(MemoryRecentQuery {
            scope: None,
            since_hours: None,
            limit: None,
        }),
    )
    .await
    .expect("memory_recent should succeed");

    let hits = body.get("hits").and_then(|v| v.as_array()).expect("hits");
    assert!(
        hits.iter().any(|h| h
            .get("snippet")
            .and_then(|s| s.as_str())
            .map(|s| s.contains("recent route smoke fact"))
            .unwrap_or(false)),
        "recent should include the approved fact, got: {body}"
    );

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn resume_meta_snapshot_reads_codebuddy_history_for_cwd() {
    let root = std::env::temp_dir().join(format!(
        "kode-bridge-resume-meta-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let old_home = std::env::var_os("HOME");
    std::fs::create_dir_all(&root).unwrap();
    std::env::set_var("HOME", &root);

    let cwd = PathBuf::from("/srv/work/demo");
    let sid = "11111111-2222-3333-4444-555555555555";
    let dir = root
        .join(".codebuddy")
        .join("projects")
        .join("srv-work-demo");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(format!("{sid}.jsonl")),
        concat!(
            r#"{"type":"ai-title","aiTitle":"Remote resume"}"#,
            "\n",
            r#"{"type":"message","role":"assistant","providerData":{"requestModelName":"claude-opus-4.7","usage":{"totalTokens":42}}}"#,
            "\n",
            r#"{"type":"message","role":"assistant","providerData":{"requestModelName":"claude-opus-4.7","usage":{"totalTokens":58}}}"#,
            "\n",
        ),
    )
    .unwrap();

    let meta = resume_meta_snapshot("codebuddy", &cwd, Some(sid)).unwrap();
    assert_eq!(meta.title.as_deref(), Some("Remote resume"));
    assert_eq!(meta.model.as_deref(), Some("claude-opus-4.7"));
    assert_eq!(meta.total_tokens, Some(58));

    match old_home {
        Some(v) => std::env::set_var("HOME", v),
        None => std::env::remove_var("HOME"),
    }
    let _ = std::fs::remove_dir_all(root);
}

/// SpecOps 通过 bridge HTTP API 创建 session 后，
/// bus 上必须 emit `session.created` 事件，让 GUI 前端能创建对应 tab。
#[tokio::test]
async fn create_session_emits_session_created_on_bus() {
    let config = config_with_fake_codebuddy();
    let token = "test-token-create-session".to_string();
    let ctx = build_test_ctx(config, token);
    let mut rx = ctx.bus.subscribe();

    // 模拟 SpecOps 通过 HTTP API 调用 create_session
    let req = CreateSessionReq {
        backend_key: "codebuddy".to_string(),
        cwd: Some(
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        ),
        cols: Some(80),
        rows: Some(24),
        permission_mode: Some("bypass".to_string()),
        model: None,
        resume_session_uuid: None,
        memory_context: None,
        extra_args: None,
        prompt: Some("test specops prompt".to_string()),
        headless: false,
        term_theme: None,
    };

    let response = create_session(axum::Extension(Arc::clone(&ctx)), axum::Json(req))
        .await
        .expect("create_session should succeed");

    let session_id = response.id;

    // 应该能从 bus 拿到 session.created 事件
    let env = rx
        .try_recv()
        .expect("session.created should be emitted on bus");
    assert_eq!(env.r#type, "session.created");
    assert_eq!(env.session_id, session_id);

    let payload = env.payload;
    assert_eq!(payload["id"], session_id);
    assert_eq!(payload["backend_key"], "codebuddy");
    assert_eq!(payload["status"], "starting");
    assert!(payload["cwd"].is_string());
}

/// SpecOps Open session 通过 bridge focus endpoint 请求 GUI 聚焦对应 tab。
#[tokio::test]
async fn focus_session_emits_focus_requested_on_bus() {
    let config = config_with_fake_codebuddy();
    let token = "test-token-focus-session".to_string();
    let ctx = build_test_ctx(config, token);
    let req = CreateSessionReq {
        backend_key: "codebuddy".to_string(),
        cwd: Some(
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        ),
        cols: Some(80),
        rows: Some(24),
        permission_mode: Some("bypass".to_string()),
        model: None,
        resume_session_uuid: None,
        memory_context: None,
        extra_args: None,
        prompt: Some("test focus prompt".to_string()),
        headless: false,
        term_theme: None,
    };
    let response = create_session(axum::Extension(Arc::clone(&ctx)), axum::Json(req))
        .await
        .expect("create_session should succeed");
    let session_id = response.id;
    let _ = ctx.bus.subscribe().try_recv();
    let mut rx = ctx.bus.subscribe();

    let status = post_focus(
        axum::Extension(Arc::clone(&ctx)),
        axum::extract::Path(session_id),
    )
    .await
    .expect("focus should succeed");
    assert_eq!(status, StatusCode::NO_CONTENT);

    let env = rx.try_recv().expect("focus event should be emitted on bus");
    assert_eq!(env.r#type, "session.focus_requested");
    assert_eq!(env.session_id, session_id);
    // payload 携带 session DTO,供 GUI 在 tab 缺失时补建。
    assert_eq!(env.payload["id"], session_id);
    assert_eq!(env.payload["backend_key"], "codebuddy");
}

#[test]
fn transcript_filter_keeps_prose_drops_only_control() {
    // Empty is always dropped.
    assert!(is_control_line("agent", ""));
    // Injected tags dropped for either role.
    assert!(is_control_line("agent", "<system-reminder>foo"));
    assert!(is_control_line("user", "<command-name>/clear"));
    assert!(is_control_line("user", "<local-command-stdout>"));
    assert!(is_control_line("user", "<user-prompt-submit-hook>"));
    // Ordinary prose starting with '<' is KEPT (this was the bug).
    assert!(!is_control_line("agent", "<div> is an HTML tag"));
    assert!(!is_control_line("agent", "> quoted reply"));
    // Slash / C-b are control only for the user.
    assert!(is_control_line("user", "/model"));
    assert!(is_control_line("user", "C-b c"));
    // An assistant reply that starts with a path or C-b is real content.
    assert!(!is_control_line(
        "agent",
        "/Users/foo/bar.rs:12 is the spot"
    ));
    assert!(!is_control_line("agent", "C-b is the tmux prefix key"));
}

/// Transcript parsing must surface tool invocations (function_call /
/// function_call_result) as `tool_use` / `tool_result` entries, while skipping
/// protocol-level tools (AskUserQuestion etc.) that have their own cards.
#[test]
fn transcript_includes_tool_use() {
    // A miniature but representative codebuddy jsonl: one assistant message,
    // one Grep tool call + its result, and one AskUserQuestion call that must
    // NOT appear in the transcript (it surfaces as its own card).
    let lines = [
        r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I'll search the repo."}]}"#,
        r#"{"type":"function_call","callId":"call_abc","name":"Grep","arguments":"{\"pattern\":\"foo\"}","providerData":{"argumentsDisplayText":"pattern=foo"}}"#,
        r#"{"type":"function_call_result","name":"Grep","callId":"call_abc","status":"completed","output":{"type":"text","text":"src/lib.rs:10: let foo = 1;"}}"#,
        r#"{"type":"function_call","callId":"call_def","name":"AskUserQuestion","arguments":"{\"questions\":[{\"question\":\"which?\"}]}"#,
        r#"}"#,
        // Unrelated line types should be skipped silently.
        r#"{"type":"ai-title","aiTitle":"demo"}"#,
    ];
    let messages = parse_transcript_lines(lines);
    // message → kind=text
    let text_msg = messages
        .iter()
        .find(|m| m.get("kind").and_then(|v| v.as_str()) == Some("text"))
        .expect("text entry should exist");
    assert_eq!(text_msg["role"], "agent");
    assert_eq!(text_msg["text"], "I'll search the repo.");
    // Grep function_call → kind=tool_use, tool=Grep
    let tool_use = messages
        .iter()
        .find(|m| m.get("kind").and_then(|v| v.as_str()) == Some("tool_use"))
        .expect("tool_use entry should exist");
    assert_eq!(tool_use["tool"], "Grep");
    assert_eq!(tool_use["tool_call_id"], "call_abc");
    assert_eq!(tool_use["summary"], "pattern=foo");
    assert_eq!(tool_use["status"], "running");
    // Grep function_call_result → kind=tool_result, preview non-empty
    let tool_result = messages
        .iter()
        .find(|m| m.get("kind").and_then(|v| v.as_str()) == Some("tool_result"))
        .expect("tool_result entry should exist");
    assert_eq!(tool_result["tool"], "Grep");
    assert_eq!(tool_result["tool_call_id"], "call_abc");
    assert!(tool_result["preview"]
        .as_str()
        .unwrap_or("")
        .contains("src/lib.rs"));
    assert_eq!(tool_result["status"], "ok");
    // AskUserQuestion (protocol-level) must NOT appear anywhere in messages.
    assert!(
        messages
            .iter()
            .all(|m| m.get("tool").and_then(|v| v.as_str()) != Some("AskUserQuestion")),
        "AskUserQuestion should be filtered out, got: {messages:?}"
    );
}

#[cfg(test)]
mod build_session_env_tests {
    use crate::{build_session_env, build_test_ctx};
    use kode_core::config::Config;

    #[tokio::test]
    async fn includes_all_three_when_socket_set() {
        let config = Config::default();
        let ctx = build_test_ctx(config, "tok".into());
        // 模拟 hook_relay_socket 已设
        let mut ctx = (*ctx).clone();
        ctx.hook_relay_socket = Some(std::path::PathBuf::from("/tmp/test-hook.sock"));
        let env = build_session_env(&ctx, 42, None);
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"KODE_HOOK_SOCK"), "missing KODE_HOOK_SOCK");
        assert!(keys.contains(&"KODE_SESSION_ID"), "missing KODE_SESSION_ID");
        assert!(
            keys.contains(&"KODE_MEMORY_ROOT"),
            "missing KODE_MEMORY_ROOT"
        );
        assert_eq!(
            env.iter()
                .find(|(k, _)| k == "TERM_THEME")
                .map(|(_, v)| v.as_str()),
            Some("dark")
        );
        assert_eq!(
            env.iter()
                .find(|(k, _)| k == "COLORFGBG")
                .map(|(_, v)| v.as_str()),
            Some("15;0")
        );
        let sock = env.iter().find(|(k, _)| k == "KODE_HOOK_SOCK").unwrap();
        assert_eq!(sock.1, "/tmp/test-hook.sock");
        let sid = env.iter().find(|(k, _)| k == "KODE_SESSION_ID").unwrap();
        assert_eq!(sid.1, "42");
    }

    #[tokio::test]
    async fn omits_sock_when_none() {
        let config = Config::default();
        let ctx = build_test_ctx(config, "tok".into());
        // hook_relay_socket = None(build_test_ctx 默认)
        let env = build_session_env(&ctx, 7, Some("light"));
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(
            !keys.contains(&"KODE_HOOK_SOCK"),
            "should not have KODE_HOOK_SOCK"
        );
        assert!(keys.contains(&"KODE_SESSION_ID"));
        assert!(keys.contains(&"KODE_MEMORY_ROOT"));
        let sid = env.iter().find(|(k, _)| k == "KODE_SESSION_ID").unwrap();
        assert_eq!(sid.1, "7");
        assert_eq!(
            env.iter()
                .find(|(k, _)| k == "TERM_THEME")
                .map(|(_, v)| v.as_str()),
            Some("light")
        );
        assert_eq!(
            env.iter()
                .find(|(k, _)| k == "COLORFGBG")
                .map(|(_, v)| v.as_str()),
            Some("0;15")
        );
    }
}
