//! Phase 11.3 端到端集成测试:RemoteTransport 连一个真起的 axum router(等价于
//! 用户家里跑的 Rust bridge),验证完整链路:
//!
//!   - REST 路径:spawn → write → resize → kill 都能往返
//!   - WS 路径:server 推 pty_bytes → RemoteTransport 收到 → core_tx 灌 → 由测试
//!     直接观察 CoreEvent::PtyBytes
//!
//! 测试 server 用 `kode_gui_lib::build_router` + `build_test_ctx`(echo backend = /bin/cat)
//! —— 这与 `tests/bridge_e2e.rs` 同源,只是这里是从 *客户端* 视角去打它。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use kode_core::{
    config::{BackendConfig, Config, UiConfig},
    CoreEvent, EndpointId, SessionTransport, SpawnSpec, TransportError,
};
use kode_gui_lib::{
    build_router, build_test_ctx, start_remote_tasks, RemoteConfig, RemoteTransport,
};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

const TOKEN: &str = "remote-test-token-deadbeef-0123456789abcdef";

fn echo_config() -> Config {
    let mut backends = HashMap::new();
    backends.insert(
        "echo".to_string(),
        BackendConfig {
            command: "/bin/cat".into(),
            args: vec![],
            default_model: None,
            model_flag: None,
            permission_mode_flag: None,
            mcp_setup: None,
            enabled: None,
        },
    );
    Config {
        default_backend: "echo".into(),
        backends,
        ui: UiConfig::default(),
    }
}

/// 启一个 mock kode-server,回 base_url。axum router 在随机端口,token 校验复用
/// build_test_ctx 注入的固定 token。
async fn start_mock_server() -> String {
    let ctx = build_test_ctx(echo_config(), TOKEN.into());
    let router = build_router(ctx);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.ok();
    });
    // 给 server 一拍起来
    tokio::time::sleep(Duration::from_millis(50)).await;
    format!("http://{addr}")
}

fn make_remote(
    base_url: String,
    token: &str,
) -> (Arc<RemoteTransport>, mpsc::UnboundedReceiver<CoreEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let cfg = RemoteConfig {
        id: "test-host".into(),
        base_url,
        token: token.into(),
        // 测试场景缩短重连等待,避免 tokio test 超 30s
        reconnect_backoff_secs: vec![1],
        ssh: None,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    let counter = Arc::new(AtomicU64::new(1));
    let alloc = Arc::new(move || counter.fetch_add(1, Ordering::Relaxed));
    let transport = Arc::new(RemoteTransport::new(cfg, tx, alloc));
    start_remote_tasks(&transport);
    (transport, rx)
}

#[tokio::test]
async fn spawn_then_write_then_kill_round_trip() {
    let base = start_mock_server().await;
    let (t, _rx) = make_remote(base, TOKEN);

    let spawned = t
        .spawn(SpawnSpec {
            backend_key: "echo".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            resume_session_uuid: None,
            permission_mode: None,
            model: None,
            memory_context: None,
            terminal_dark: None,
        })
        .await
        .expect("spawn ok");
    assert!(spawned.id > 0);
    assert_eq!(spawned.backend_key, "echo");

    // write_input → server PTY (cat) 收到 → 通过 WS 回 pty_bytes
    t.write_input(spawned.id, b"hello\n")
        .await
        .expect("write ok");

    // resize 200/204 路径
    t.resize(spawned.id, 100, 30).await.expect("resize ok");

    // kill 路径
    t.kill(spawned.id).await.expect("kill ok");

    // 二次 kill 应该幂等(404 视作成功)
    t.kill(spawned.id).await.expect("second kill is idempotent");
}

#[tokio::test]
async fn ws_relays_pty_bytes_into_core_tx() {
    let base = start_mock_server().await;
    let (t, mut rx) = make_remote(base, TOKEN);

    let spawned = t
        .spawn(SpawnSpec {
            backend_key: "echo".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            resume_session_uuid: None,
            permission_mode: None,
            model: None,
            memory_context: None,
            terminal_dark: None,
        })
        .await
        .expect("spawn ok");

    // 给 WS 客户端连接 server 的时间(connect_async + 第一次接收 hello)
    tokio::time::sleep(Duration::from_millis(150)).await;

    // 写一段独特字符串,cat 会原样 echo 回来 → server emit pty_bytes → 我们这边收到
    let payload = b"kode-remote-roundtrip-marker";
    t.write_input(spawned.id, payload).await.expect("write ok");

    // 等 PTY echo + WS 推送(coalesce 8ms,留足 200ms)
    let mut got_marker = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(CoreEvent::PtyBytes { id, bytes })) => {
                assert_eq!(id, spawned.id);
                if bytes.windows(payload.len()).any(|w| w == payload) {
                    got_marker = true;
                    break;
                }
            }
            Ok(Some(other)) => {
                // session.exited / meta 可能也来,跳过继续找 PtyBytes
                eprintln!("non-PtyBytes event: {other:?}");
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    assert!(got_marker, "expected to see echo marker via WS pty_bytes");

    let _ = t.kill(spawned.id).await;
}

#[tokio::test]
async fn ws_relays_session_exited_into_core_tx() {
    let base = start_mock_server().await;
    let (t, mut rx) = make_remote(base, TOKEN);

    let spawned = t
        .spawn(SpawnSpec {
            backend_key: "echo".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            resume_session_uuid: None,
            permission_mode: None,
            model: None,
            memory_context: None,
            terminal_dark: None,
        })
        .await
        .expect("spawn ok");

    tokio::time::sleep(Duration::from_millis(100)).await;

    // 触发 server 端的 session.exited:DELETE → server emit "deleted_by_api"
    t.kill(spawned.id).await.expect("kill ok");

    let mut got_exited = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(CoreEvent::PtyExited { id, .. })) if id == spawned.id => {
                got_exited = true;
                break;
            }
            Ok(Some(_)) => continue,
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    assert!(got_exited, "expected PtyExited via WS session.exited relay");
}

#[tokio::test]
async fn unknown_backend_returns_bad_request() {
    let base = start_mock_server().await;
    let (t, _rx) = make_remote(base, TOKEN);

    let err = t
        .spawn(SpawnSpec {
            backend_key: "no-such-backend".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            resume_session_uuid: None,
            permission_mode: None,
            model: None,
            memory_context: None,
            terminal_dark: None,
        })
        .await
        .expect_err("should fail");
    match err {
        TransportError::BadRequest(d) => assert!(
            d.contains("no-such-backend") || d.contains("backend"),
            "expected backend-related detail, got {d:?}"
        ),
        other => panic!("expected BadRequest, got {other:?}"),
    }
}

#[tokio::test]
async fn wrong_token_yields_internal_error_with_auth_prefix() {
    let base = start_mock_server().await;
    let (t, _rx) = make_remote(base, "wrong-token");

    let err = t
        .spawn(SpawnSpec {
            backend_key: "echo".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            resume_session_uuid: None,
            permission_mode: None,
            model: None,
            memory_context: None,
            terminal_dark: None,
        })
        .await
        .expect_err("should fail");
    let msg = err.to_string();
    assert!(
        msg.contains("auth") || msg.contains("401"),
        "expected auth-related error, got: {msg}"
    );
}

#[tokio::test]
async fn endpoint_id_matches_config() {
    let base = start_mock_server().await;
    let (t, _rx) = make_remote(base, TOKEN);
    assert_eq!(
        t.endpoint_id(),
        EndpointId::Remote {
            id: "test-host".into()
        }
    );
}

#[tokio::test]
async fn resize_below_minimum_propagates_to_server_validation() {
    // RemoteTransport 不像 LocalTransport 那样客户端做最小尺寸检查 —
    // 协议契约说 cols/rows<=0 由 server 返 400(11.1.1 规则),客户端应透传错误。
    // 也即:server 实际是 i32<=0 / >10000 → 400;u16=0 这边 reqwest 会传过去
    // **以正常 200 形式**(我们用的是 u16,序列化成 0,server 拿到看到 0 拒)。
    let base = start_mock_server().await;
    let (t, _rx) = make_remote(base, TOKEN);

    let spawned = t
        .spawn(SpawnSpec {
            backend_key: "echo".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            resume_session_uuid: None,
            permission_mode: None,
            model: None,
            memory_context: None,
            terminal_dark: None,
        })
        .await
        .unwrap();

    // u16=0 → server 看到 0 → 返 400 → TransportError::BadRequest
    let err = t
        .resize(spawned.id, 0, 0)
        .await
        .expect_err("resize 0x0 should fail at server");
    assert!(matches!(err, TransportError::BadRequest(_)));

    let _ = t.kill(spawned.id).await;
}
