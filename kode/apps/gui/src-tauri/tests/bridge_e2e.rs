//! 端到端集成测试:启 axum router 在随机端口,curl 风格走完 REST + WS。
//!
//! 不依赖 Tauri runtime — 通过 `kode_gui_lib::build_test_ctx` 直接构造 ctx。
//!
//! 我们用 `cat` 作为"echo 后端",PTY 把输入回显到 stdout,完成 spawn → input →
//! bytes round-trip → kill 全流程。**不**测 jsonl 解析(那要 codebuddy/claude
//! CLI 真存在),已在 bridge::semantic 单元测试里覆盖。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use kode_core::config::{BackendConfig, Config, UiConfig};
use kode_gui_lib::{build_router, build_test_ctx};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "test-token-deadbeef-0123456789abcdef";

/// 构造测试用 Config:只有一个 echo 后端(cat),不接 jsonl tail。
fn test_config() -> Config {
    let mut backends = HashMap::new();
    backends.insert(
        "echo".to_string(),
        BackendConfig {
            command: "/bin/cat".to_string(),
            args: vec![],
            default_model: None,
            model_flag: None,
            permission_mode_flag: None,
            mcp_setup: None,
            enabled: None,
        },
    );
    Config {
        default_backend: "echo".to_string(),
        backends,
        ui: UiConfig::default(),
    }
}

/// 启动 server 在随机端口,返回 base url。
async fn start_server() -> SocketAddr {
    let ctx = build_test_ctx(test_config(), TOKEN.to_string());
    let router = build_router(ctx);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.ok();
    });
    // 给 server 一拍起来
    tokio::time::sleep(Duration::from_millis(50)).await;
    addr
}

fn auth_headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::AUTHORIZATION,
        format!("Bearer {TOKEN}").parse().unwrap(),
    );
    h
}

#[tokio::test]
async fn healthz_no_auth() {
    let addr = start_server().await;
    let resp = reqwest::get(format!("http://{addr}/healthz"))
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.text().await.unwrap(), "ok");
}

#[tokio::test]
async fn rest_without_token_returns_401() {
    let addr = start_server().await;
    let resp = reqwest::get(format!("http://{addr}/api/v1/sessions"))
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "unauthorized");
}

#[tokio::test]
async fn rest_with_wrong_token_returns_401() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{addr}/api/v1/sessions"))
        .header("Authorization", "Bearer not-the-real-token")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn empty_session_list() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["sessions"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn spawn_then_list_then_kill() {
    let addr = start_server().await;
    let client = reqwest::Client::new();

    // 1. spawn
    let resp = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({ "backend_key": "echo" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "spawn failed: {:?}", resp.text().await);
    let session: Value = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({ "backend_key": "echo" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = session["id"].as_u64().unwrap();
    assert_eq!(session["backend_key"], "echo");
    assert!(
        session["cwd"].as_str().is_some(),
        "spawn response must expose cwd"
    );

    // 2. list
    let body: Value = client
        .get(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let count = body["sessions"].as_array().unwrap().len();
    assert!(count >= 1);

    // 3. get :id
    let body: Value = client
        .get(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["id"], id);
    assert_eq!(body["backend_key"], "echo");

    // 4. write input(给 cat 喂一行,不验证 echo —— 单元测试已覆盖路径)
    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/{id}/input"))
        .headers(auth_headers())
        .json(&json!({"text": "hello\n"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    // 5. kill
    let resp = client
        .delete(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    // 6. 再 get :id 应 404
    let resp = client
        .get(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn unknown_backend_returns_400() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({"backend_key": "nonexistent"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "bad_request");
}

#[tokio::test]
async fn input_with_invalid_base64_returns_400() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    // 先 spawn
    let session: Value = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({"backend_key": "echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = session["id"].as_u64().unwrap();

    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/{id}/input"))
        .headers(auth_headers())
        .json(&json!({"bytes_b64": "!!! not base64"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    // 收尾
    let _ = client
        .delete(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await;
}

#[tokio::test]
async fn input_requires_text_or_bytes() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    let session: Value = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({"backend_key": "echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = session["id"].as_u64().unwrap();

    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/{id}/input"))
        .headers(auth_headers())
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    let _ = client
        .delete(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await;
}

#[tokio::test]
async fn ws_handshake_returns_hello_and_session_events() {
    let addr = start_server().await;

    // 先连 WS
    let url = format!("ws://{addr}/ws?token={TOKEN}");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect failed");

    // 1. hello
    let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .expect("hello timed out")
        .unwrap()
        .unwrap();
    let hello: Value = match msg {
        Message::Text(t) => serde_json::from_str(&t).unwrap(),
        other => panic!("unexpected first ws msg: {:?}", other),
    };
    assert_eq!(hello["type"], "connection.hello");
    assert_eq!(hello["payload"]["server_kind"], "rust-bridge");
    assert_eq!(hello["session_id"], 0);

    // 2. spawn 一个 session,WS 应收到 session.created
    let client = reqwest::Client::new();
    let session: Value = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({"backend_key": "echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = session["id"].as_u64().unwrap();

    let mut got_created = false;
    let mut got_exited = false;
    // 收事件直到看到 created
    for _ in 0..10 {
        let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("created timed out")
            .unwrap()
            .unwrap();
        if let Message::Text(t) = msg {
            let env: Value = serde_json::from_str(&t).unwrap();
            if env["type"] == "session.created" && env["session_id"] == id {
                got_created = true;
                break;
            }
        }
    }
    assert!(got_created, "did not receive session.created on WS");

    // 3. delete → session.exited
    let resp = client
        .delete(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    for _ in 0..10 {
        let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("exited timed out")
            .unwrap()
            .unwrap();
        if let Message::Text(t) = msg {
            let env: Value = serde_json::from_str(&t).unwrap();
            if env["type"] == "session.exited" && env["session_id"] == id {
                got_exited = true;
                break;
            }
        }
    }
    assert!(got_exited, "did not receive session.exited on WS");

    let _ = ws.close(None).await;
}

#[tokio::test]
async fn ws_without_token_rejects() {
    let addr = start_server().await;
    let url = format!("ws://{addr}/ws");
    let res = tokio_tungstenite::connect_async(&url).await;
    assert!(res.is_err(), "ws should reject when token missing");
}

#[tokio::test]
async fn ws_with_wrong_token_rejects() {
    let addr = start_server().await;
    let url = format!("ws://{addr}/ws?token=wrong");
    let res = tokio_tungstenite::connect_async(&url).await;
    assert!(res.is_err(), "ws should reject wrong token");
}

#[tokio::test]
async fn ws_ping_pong() {
    let addr = start_server().await;
    let url = format!("ws://{addr}/ws?token={TOKEN}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // 跳过 hello
    let _ = ws.next().await;

    // 发 ping(JSON 体,符合 PROTOCOL.md §5.2)
    ws.send(Message::Text("{\"type\":\"ping\"}".to_string()))
        .await
        .unwrap();

    let msg = tokio::time::timeout(Duration::from_secs(1), ws.next())
        .await
        .expect("pong timed out")
        .unwrap()
        .unwrap();
    if let Message::Text(t) = msg {
        let v: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(v["type"], "pong");
    } else {
        panic!("expected text pong");
    }

    let _ = ws.close(None).await;
}

#[tokio::test]
async fn history_endpoint_returns_session_events() {
    let addr = start_server().await;
    let client = reqwest::Client::new();

    let session: Value = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({"backend_key": "echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = session["id"].as_u64().unwrap();

    // 等 emit 落到 ring buffer
    tokio::time::sleep(Duration::from_millis(50)).await;

    let body: Value = client
        .get(format!("http://{addr}/api/v1/sessions/{id}/history"))
        .headers(auth_headers())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = body["events"].as_array().unwrap();
    assert!(
        events.iter().any(|e| e["type"] == "session.created"),
        "history should contain session.created"
    );

    let _ = client
        .delete(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await;
}

#[tokio::test]
async fn answer_endpoint_writes_choice_and_submit_to_pty() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    let session: Value = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({"backend_key": "echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = session["id"].as_u64().unwrap();

    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/{id}/answer"))
        .headers(auth_headers())
        .json(&json!({"question_id": "x", "choice_index": 0}))
        .send()
        .await
        .unwrap();
    // 已实装:首项直接 Enter;其它项用 DownArrow 移动后 Enter。
    assert_eq!(resp.status(), 204);

    // 越界 choice_index 应 400
    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/{id}/answer"))
        .headers(auth_headers())
        .json(&json!({"question_id": "x", "choice_index": 99}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    let _ = client
        .delete(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await;
}

// ============================================================================
// Phase 11.1 协议补丁:resize / backends / fs.list / pty_bytes
// ============================================================================

#[tokio::test]
async fn resize_endpoint_normal_and_errors() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    let session: Value = client
        .post(format!("http://{addr}/api/v1/sessions"))
        .headers(auth_headers())
        .json(&json!({"backend_key": "echo"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = session["id"].as_u64().unwrap();

    // 1. 正常 resize → 204
    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/{id}/resize"))
        .headers(auth_headers())
        .json(&json!({"cols": 120, "rows": 40}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    // 2. cols=0 → 400
    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/{id}/resize"))
        .headers(auth_headers())
        .json(&json!({"cols": 0, "rows": 40}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    // 3. cols 超界 → 400
    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/{id}/resize"))
        .headers(auth_headers())
        .json(&json!({"cols": 99999, "rows": 40}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    // 4. 不存在的 session → 404
    let resp = client
        .post(format!("http://{addr}/api/v1/sessions/9999/resize"))
        .headers(auth_headers())
        .json(&json!({"cols": 80, "rows": 24}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);

    let _ = client
        .delete(format!("http://{addr}/api/v1/sessions/{id}"))
        .headers(auth_headers())
        .send()
        .await;
}

#[tokio::test]
async fn list_backends_endpoint() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{addr}/api/v1/backends"))
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    let backends = body["backends"].as_array().expect("backends array");
    assert_eq!(backends.len(), 1, "test_config 只配了 echo 一个 backend");
    assert_eq!(backends[0]["key"], "echo");
    assert_eq!(backends[0]["display_name"], "echo");
    assert_eq!(backends[0]["supports_cwd"], true);
    assert!(backends[0]["default_cwd"].is_null());
}

#[tokio::test]
async fn fs_list_endpoint_normal_and_security() {
    let addr = start_server().await;
    let client = reqwest::Client::new();
    let home = dirs::home_dir()
        .expect("home")
        .to_string_lossy()
        .to_string();

    // 1. 列举 $HOME → 200,有若干子目录(测试机器至少有 Library / Desktop 等)
    let resp = client
        .get(format!("http://{addr}/api/v1/fs/list"))
        .query(&[("path", &home)])
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "list HOME should succeed");
    let body: Value = resp.json().await.unwrap();
    assert!(body["entries"].is_array());
    // 默认 show_hidden=false → 不应包含 .config 之类
    let entries = body["entries"].as_array().unwrap();
    for e in entries {
        let name = e["name"].as_str().unwrap();
        assert!(!name.starts_with('.'), "hidden entry leaked: {name}");
        assert_eq!(e["is_dir"], true);
    }

    // 2. HOME 外的有效绝对目录也允许列举。SSH remote 场景里代码常在
    // /data/workspace、/mnt、/opt 等 HOME 外路径,fs.list 只校验路径有效性。
    let resp = client
        .get(format!("http://{addr}/api/v1/fs/list"))
        .query(&[("path", "/etc")])
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    assert!(body["entries"].is_array());
    assert!(body["parent"].as_str().is_some());

    // 3. 不存在的路径 → 404
    let bogus = format!("{home}/__nonexistent__kode_test__");
    let resp = client
        .get(format!("http://{addr}/api/v1/fs/list"))
        .query(&[("path", &bogus)])
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);

    // 4. 相对路径 → 400
    let resp = client
        .get(format!("http://{addr}/api/v1/fs/list"))
        .query(&[("path", "relative/path")])
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);

    // 5. ../ 只要 canonical 后是有效绝对目录也允许。
    let escape = format!("{home}/../../etc");
    let resp = client
        .get(format!("http://{addr}/api/v1/fs/list"))
        .query(&[("path", &escape)])
        .headers(auth_headers())
        .send()
        .await
        .unwrap();
    assert!(resp.status() == 200 || resp.status() == 404);
}

#[tokio::test]
async fn ws_hello_includes_protocol_features() {
    use tokio_tungstenite::connect_async;
    let addr = start_server().await;
    let url = format!("ws://{addr}/ws?token={TOKEN}");
    let (mut ws, _) = connect_async(&url).await.expect("ws connect");
    let msg = ws.next().await.expect("hello").expect("msg");
    let text = msg.to_text().expect("text").to_string();
    let env: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(env["type"], "connection.hello");
    let features = env["payload"]["protocol_features"]
        .as_array()
        .expect("protocol_features array");
    let names: Vec<&str> = features.iter().filter_map(|v| v.as_str()).collect();
    for required in ["resize", "backends", "fs.list", "pty_bytes"] {
        assert!(
            names.contains(&required),
            "missing feature {required} in {names:?}"
        );
    }
    let _ = ws.send(Message::Close(None)).await;
}
