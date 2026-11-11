//! End-to-end relay tests over real sockets. A fake desktop agent speaks the
//! agent protocol; the phone side uses the REST routes and `/ws`.

use std::{sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
    MaybeTlsStream, WebSocketStream,
};

use crate::{build_router, identity::StaticVerifier, RelayState, RelayTimings, DEVICE_HEADER};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const ALICE: &str = "tok-alice";
const ALICE_PHONE: &str = "tok-alice-phone";
const BOB: &str = "tok-bob";
const WAIT: Duration = Duration::from_secs(3);

struct Harness {
    base: String,
    verifier: Arc<StaticVerifier>,
    state: RelayState,
    http: reqwest::Client,
}

async fn harness() -> Harness {
    let verifier = StaticVerifier::new([
        (ALICE.to_string(), "alice".to_string()),
        (ALICE_PHONE.to_string(), "alice".to_string()),
        (BOB.to_string(), "bob".to_string()),
    ]);
    let timings = RelayTimings {
        viewer_lease: Duration::from_millis(400),
        snapshot_wait: Duration::from_secs(2),
        setup_timeout: Duration::from_secs(2),
        reverify_interval: Duration::from_millis(200),
        sweep_interval: Duration::from_millis(50),
        ..RelayTimings::default()
    };
    let state =
        RelayState::new(verifier.clone(), timings).with_issuer("https://issuer.example.com");
    state.spawn_sweeper();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = build_router(state.clone());
    tokio::spawn(async move { axum::serve(listener, router).await });
    Harness {
        base: format!("http://{addr}"),
        verifier,
        state,
        http: reqwest::Client::new(),
    }
}

impl Harness {
    async fn connect(&self, path: &str, token: &str) -> Result<Socket, String> {
        let mut request = format!("{}{}", self.base.replacen("http", "ws", 1), path)
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        connect_async(request)
            .await
            .map(|(socket, _)| socket)
            .map_err(|error| error.to_string())
    }

    async fn agent(&self, token: &str, device: &str) -> Agent {
        let socket = self
            .connect(
                &format!("/api/v1/agent/ws?device_id={device}&name=Desk"),
                token,
            )
            .await
            .expect("agent connects");
        let mut agent = Agent { socket };
        let hello = agent.frame().await;
        assert_eq!(hello["type"], "server.hello");
        assert_eq!(hello["sync_enabled"], false, "nobody is viewing yet");
        agent
    }

    async fn phone(&self, token: &str, device: &str) -> Socket {
        let mut socket = self
            .connect(&format!("/ws?device_id={device}"), token)
            .await
            .expect("phone connects");
        let hello = next_json(&mut socket).await;
        assert_eq!(hello["type"], "connection.hello");
        socket
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        token: &str,
        device: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(token)
            .header(DEVICE_HEADER, device);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect("request");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str, token: &str, device: &str) -> (u16, Value) {
        self.call(reqwest::Method::GET, path, token, device, None)
            .await
    }
}

struct Agent {
    socket: Socket,
}

impl Agent {
    async fn frame(&mut self) -> Value {
        loop {
            let frame = next_json(&mut self.socket).await;
            if frame["type"] != "pong" {
                return frame;
            }
        }
    }

    async fn send(&mut self, value: Value) {
        self.socket
            .send(Message::Text(value.to_string()))
            .await
            .expect("agent send");
    }

    /// Waits for the viewer gate and answers an enable with a snapshot.
    async fn expect_gate(&mut self, enabled: bool, sessions: Value) {
        let frame = self.frame().await;
        assert_eq!(frame["type"], "binding.changed", "unexpected {frame}");
        assert_eq!(frame["sync_enabled"], enabled);
        if enabled {
            self.send(json!({"type": "hello", "boot_id": "boot-1", "sessions": sessions}))
                .await;
        }
    }
}

async fn next_json(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("frame before timeout")
            .expect("socket open")
            .expect("frame");
        if let Message::Text(raw) = message {
            return serde_json::from_str(&raw).expect("json frame");
        }
    }
}

async fn assert_quiet(socket: &mut Socket) {
    let next = tokio::time::timeout(Duration::from_millis(300), socket.next()).await;
    assert!(next.is_err(), "expected no frame, got {next:?}");
}

fn session(local_id: u64, title: &str) -> Value {
    json!({"local_id": local_id, "dto": {"id": local_id, "title": title, "status": "idle"}})
}

#[tokio::test]
async fn rest_activity_opens_the_stream_and_the_lease_closes_it() {
    let h = harness().await;
    let mut agent = h.agent(ALICE, "desk").await;

    let list = tokio::spawn({
        let base = h.base.clone();
        async move {
            reqwest::Client::new()
                .get(format!("{base}/api/v1/sessions"))
                .bearer_auth(ALICE_PHONE)
                .header(DEVICE_HEADER, "desk")
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    });
    agent.expect_gate(true, json!([session(7, "build")])).await;
    let listed = list.await.unwrap();
    assert_eq!(listed["sessions"][0]["title"], "build");
    assert_eq!(
        listed["sessions"][0]["id"], 1,
        "phone ids are relay-assigned"
    );

    // No socket and no further REST calls: the lease expires and the
    // desktop is told to stop uploading.
    agent.expect_gate(false, json!([])).await;
}

#[tokio::test]
async fn phone_socket_keeps_streaming_until_it_closes() {
    let h = harness().await;
    let mut agent = h.agent(ALICE, "desk").await;
    let mut phone = h.phone(ALICE_PHONE, "desk").await;
    agent.expect_gate(true, json!([session(7, "build")])).await;
    let created = next_json(&mut phone).await;
    assert_eq!(created["type"], "session.created");
    assert_eq!(created["payload"]["title"], "build");

    agent
        .send(
            json!({"type": "event", "boot_id": "boot-1", "local_session_id": 7,
            "event": {"session_id": 7, "ts": 10, "type": "message", "payload": {"text": "hi"}}}),
        )
        .await;
    agent
        .send(
            json!({"type": "event", "boot_id": "boot-1", "local_session_id": 7,
            "event": {"session_id": 7, "ts": 11, "type": "pty_bytes", "payload": {}}}),
        )
        .await;
    let message = next_json(&mut phone).await;
    assert_eq!(message["type"], "message");
    assert_eq!(message["session_id"], created["session_id"]);
    assert_quiet(&mut phone).await;

    // Still viewing well past the lease: the gate stays open.
    tokio::time::sleep(Duration::from_millis(600)).await;
    phone.close(None).await.unwrap();
    agent.expect_gate(false, json!([])).await;
}

#[tokio::test]
async fn accounts_are_isolated_even_with_identical_device_ids() {
    let h = harness().await;
    let mut alice_agent = h.agent(ALICE, "desk").await;
    // Same device id in another account is a different desktop, not a conflict.
    let mut bob_agent = h.agent(BOB, "desk").await;
    let _bob_only = h.agent(BOB, "bob-laptop").await;

    let (_, alice_devices) = h.get("/api/v1/account/devices", ALICE_PHONE, "desk").await;
    let ids: Vec<&str> = alice_devices["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["device_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["desk"]);

    let mut alice_phone = h.phone(ALICE_PHONE, "desk").await;
    alice_agent
        .expect_gate(true, json!([session(1, "alice-secret")]))
        .await;
    let _ = next_json(&mut alice_phone).await;
    let mut bob_phone = h.phone(BOB, "desk").await;
    bob_agent
        .expect_gate(true, json!([session(1, "bob-work")]))
        .await;
    let bob_created = next_json(&mut bob_phone).await;
    assert_eq!(bob_created["payload"]["title"], "bob-work");

    alice_agent
        .send(json!({"type": "event", "boot_id": "boot-1", "local_session_id": 1,
            "event": {"session_id": 1, "ts": 20, "type": "message", "payload": {"text": "alice only"}}}))
        .await;
    assert_eq!(
        next_json(&mut alice_phone).await["payload"]["text"],
        "alice only"
    );
    assert_quiet(&mut bob_phone).await;

    let (_, bob_list) = h.get("/api/v1/sessions", BOB, "desk").await;
    assert_eq!(bob_list["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(bob_list["sessions"][0]["title"], "bob-work");

    // Bob's input goes to Bob's desktop only.
    let (status, _) = h
        .call(
            reqwest::Method::POST,
            "/api/v1/sessions/1/input",
            BOB,
            "desk",
            Some(json!({"text": "ls"})),
        )
        .await;
    assert_eq!(status, 202);
    let command = bob_agent.frame().await;
    assert_eq!(command["type"], "command");
    assert_eq!(command["local_session_id"], 1);
    assert_quiet(&mut alice_agent.socket).await;
}

#[tokio::test]
async fn every_device_route_hides_foreign_devices() {
    let h = harness().await;
    let mut agent = h.agent(ALICE, "alice-desk").await;
    let mut phone = h.phone(ALICE_PHONE, "alice-desk").await;
    agent
        .expect_gate(true, json!([session(3, "private")]))
        .await;
    let _ = next_json(&mut phone).await;

    use reqwest::Method;
    let routes: Vec<(Method, &str, Option<Value>)> = vec![
        (Method::GET, "/api/v1/sessions", None),
        (
            Method::POST,
            "/api/v1/sessions",
            Some(json!({"backend_key": "claude", "cwd": null, "model": null})),
        ),
        (Method::GET, "/api/v1/sessions/1", None),
        (Method::DELETE, "/api/v1/sessions/1", None),
        (Method::GET, "/api/v1/sessions/1/history", None),
        (
            Method::POST,
            "/api/v1/sessions/1/input",
            Some(json!({"text": "rm -rf"})),
        ),
        (Method::POST, "/api/v1/sessions/1/interrupt", None),
        (
            Method::POST,
            "/api/v1/sessions/1/answer",
            Some(json!({"choice_index": 0})),
        ),
        (
            Method::POST,
            "/api/v1/sessions/1/plan_response",
            Some(json!({"accept": true})),
        ),
        (
            Method::POST,
            "/api/v1/sessions/1/mode",
            Some(json!({"mode": "plan"})),
        ),
        (
            Method::POST,
            "/api/v1/sessions/1/model",
            Some(json!({"model": "m"})),
        ),
        (Method::GET, "/api/v1/backends", None),
        (Method::GET, "/api/v1/backends/claude/models", None),
        (Method::GET, "/api/v1/fs/list", None),
    ];
    for (method, path, body) in routes {
        let mut request = h
            .http
            .request(method.clone(), format!("{}{}", h.base, path))
            .bearer_auth(BOB)
            .header(DEVICE_HEADER, "alice-desk")
            .header("Idempotency-Key", "k1");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let status = request.send().await.unwrap().status().as_u16();
        assert_eq!(
            status, 404,
            "{method} {path} must not reach another account"
        );
    }
    assert!(h.connect("/ws?device_id=alice-desk", BOB).await.is_err());
    assert_quiet(&mut agent.socket).await;

    // Missing or forged tokens are rejected before any lookup.
    assert_eq!(
        h.get("/api/v1/sessions", "forged", "alice-desk").await.0,
        401
    );
    assert!(h
        .connect("/api/v1/agent/ws?device_id=x", "forged")
        .await
        .is_err());
}

#[tokio::test]
async fn commands_settle_through_history_and_deduplicate() {
    let h = harness().await;
    let mut agent = h.agent(ALICE, "desk").await;
    let mut phone = h.phone(ALICE_PHONE, "desk").await;
    agent.expect_gate(true, json!([session(9, "tests")])).await;
    let session_id = next_json(&mut phone).await["session_id"].as_i64().unwrap();
    let input = format!("/api/v1/sessions/{session_id}/input");

    let send = |key: &'static str| {
        h.http
            .post(format!("{}{}", h.base, input))
            .bearer_auth(ALICE_PHONE)
            .header(DEVICE_HEADER, "desk")
            .header("Idempotency-Key", key)
            .json(&json!({"text": "cargo test"}))
            .send()
    };
    let first: Value = send("same").await.unwrap().json().await.unwrap();
    assert_eq!(first["status"], "dispatched");
    let again: Value = send("same").await.unwrap().json().await.unwrap();
    assert_eq!(again["deduplicated"], true);
    assert_eq!(again["command_id"], first["command_id"]);

    let command = agent.frame().await;
    assert_eq!(command["payload"]["text"], "cargo test");
    assert_eq!(command["local_session_id"], 9);
    let command_id = command["command_id"].as_str().unwrap().to_string();
    assert_eq!(
        next_json(&mut phone).await["payload"]["status"],
        "dispatched"
    );
    for status in ["accepted", "executed"] {
        agent
            .send(json!({"type": "command.result", "command_id": command_id, "status": status}))
            .await;
        assert_eq!(next_json(&mut phone).await["payload"]["status"], status);
    }
    // A stale acceptance after the terminal receipt is ignored.
    agent
        .send(json!({"type": "command.result", "command_id": command_id, "status": "accepted"}))
        .await;
    assert_quiet(&mut phone).await;

    let history = tokio::spawn({
        let base = h.base.clone();
        async move {
            reqwest::Client::new()
                .get(format!("{base}/api/v1/sessions/{session_id}/history"))
                .bearer_auth(ALICE_PHONE)
                .header(DEVICE_HEADER, "desk")
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap()
        }
    });
    let request = agent.frame().await;
    assert_eq!(request["type"], "setup.request");
    assert_eq!(request["kind"], "history");
    assert_eq!(request["payload"]["local_session_id"], 9);
    agent
        .send(
            json!({"type": "setup.result", "request_id": request["request_id"], "boot_id": "boot-1",
            "status": 200, "body": {"events": [
                {"session_id": 9, "ts": 1, "type": "message", "payload": {"text": "earlier"}},
                {"session_id": 9, "ts": 2, "type": "session.status", "payload": {"status": "busy"}}
            ]}}),
        )
        .await;
    let events = history.await.unwrap()["events"].as_array().unwrap().clone();
    assert_eq!(events[0]["payload"]["text"], "earlier");
    assert_eq!(events[0]["session_id"], session_id);
    assert!(events.iter().all(|e| e["type"] != "session.status"));
    let receipt = events
        .iter()
        .find(|e| e["type"] == "command.status")
        .expect("receipt");
    assert_eq!(receipt["payload"]["status"], "executed");
}

#[tokio::test]
async fn offline_desktops_reject_commands_and_duplicate_agents() {
    let h = harness().await;
    let mut agent = h.agent(ALICE, "desk").await;
    assert!(
        h.connect("/api/v1/agent/ws?device_id=desk", ALICE)
            .await
            .is_err(),
        "a second process for the same device is rejected"
    );
    let mut phone = h.phone(ALICE_PHONE, "desk").await;
    agent.expect_gate(true, json!([session(2, "x")])).await;
    let session_id = next_json(&mut phone).await["session_id"].as_i64().unwrap();
    agent.socket.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let (status, body) = h
        .call(
            reqwest::Method::POST,
            &format!("/api/v1/sessions/{session_id}/input"),
            ALICE_PHONE,
            "desk",
            Some(json!({"text": "hello"})),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    let (_, devices) = h.get("/api/v1/account/devices", ALICE_PHONE, "desk").await;
    assert_eq!(devices["devices"][0]["online"], false);
}

#[tokio::test]
async fn revoked_tokens_close_open_sockets() {
    let h = harness().await;
    let mut agent = h.agent(ALICE, "desk").await;
    h.verifier.revoke(ALICE);
    let closed = tokio::time::timeout(WAIT, async {
        loop {
            match agent.socket.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                _ => {}
            }
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "agent socket closes after its token is revoked"
    );
}

#[tokio::test]
async fn healthz_identifies_the_relay_and_its_issuer() {
    let h = harness().await;
    let health: Value = h
        .http
        .get(format!("{}/api/v1/healthz", h.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["server_kind"], "kode-relay");
    assert_eq!(health["issuer"], "https://issuer.example.com");
}

#[tokio::test]
async fn sweeper_forgets_empty_tenants() {
    let h = harness().await;
    assert_eq!(h.get("/api/v1/account/devices", BOB, "none").await.0, 200);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        h.state.tenant_count(),
        0,
        "a tenant without devices is dropped"
    );
}

async fn palmx_relay() -> (String, std::sync::Arc<crate::palmx::fake::FakeServices>) {
    let verifier = StaticVerifier::new([(ALICE.to_string(), "alice".to_string())]);
    let fake = std::sync::Arc::new(crate::palmx::fake::FakeServices::default());
    let palmx = crate::palmx::Palmx::new(
        "app_test".into(),
        "https://palm.example.com".into(),
        fake.clone(),
    );
    let state = RelayState::new(verifier, RelayTimings::default())
        .with_issuer("https://issuer.example.com")
        .with_palmx(palmx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = build_router(state);
    tokio::spawn(async move { axum::serve(listener, router).await });
    (format!("http://{addr}"), fake)
}

const VERIFIER: &str = "verifier-0123456789-0123456789-0123456789-abc";

async fn post(base: &str, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
    let mut request = reqwest::Client::new()
        .post(format!("{base}{path}"))
        .json(&body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn palmx_signs_unbound_palms_into_their_own_account_and_bound_ones_into_the_owner() {
    let (base, fake) = palmx_relay().await;
    let health: Value = reqwest::get(format!("{base}/api/v1/healthz"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["login_methods"][0]["id"], "palmx");
    assert_eq!(health["login_methods"][0]["app_id"], "app_test");
    assert_eq!(health["login_methods"][1]["id"], "email");

    fake.issue("code-1", "open-palm");
    let (status, first) = post(
        &base,
        "/api/v1/auth/palmx",
        None,
        json!({"code": "code-1", "code_verifier": VERIFIER}),
    )
    .await;
    assert_eq!(status, 200, "{first}");
    let derived = crate::palmx::derived_uid("open-palm");
    assert_eq!(first["sub"], derived);
    assert_eq!(first["provider"], "palmx");

    // Codes are single-use.
    let (status, _) = post(
        &base,
        "/api/v1/auth/palmx",
        None,
        json!({"code": "code-1", "code_verifier": VERIFIER}),
    )
    .await;
    assert_eq!(status, 400);

    // Alice links the palm; the next palm sign-in lands in her account.
    fake.issue("code-2", "open-palm");
    let (status, linked) = post(
        &base,
        "/api/v1/auth/palmx/bind",
        Some(ALICE),
        json!({"code": "code-2", "code_verifier": VERIFIER}),
    )
    .await;
    assert_eq!(status, 200, "{linked}");
    fake.issue("code-3", "open-palm");
    let (_, second) = post(
        &base,
        "/api/v1/auth/palmx",
        None,
        json!({"code": "code-3", "code_verifier": VERIFIER}),
    )
    .await;
    assert_eq!(second["sub"], "alice");

    let logins: Value = reqwest::Client::new()
        .get(format!("{base}/api/v1/account/logins"))
        .bearer_auth(ALICE)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(logins["linked"], json!(["palmx"]));
}

#[tokio::test]
async fn palmx_binding_is_exclusive_authenticated_and_reversible() {
    let (base, fake) = palmx_relay().await;
    fake.bindings
        .lock()
        .insert("open-taken".into(), "someone-else".into());
    fake.issue("code-taken", "open-taken");
    let (status, _) = post(
        &base,
        "/api/v1/auth/palmx/bind",
        Some(ALICE),
        json!({"code": "code-taken", "code_verifier": VERIFIER}),
    )
    .await;
    assert_eq!(status, 409, "a palm linked elsewhere cannot be taken over");

    fake.issue("code-anon", "open-free");
    let (status, _) = post(
        &base,
        "/api/v1/auth/palmx/bind",
        None,
        json!({"code": "code-anon", "code_verifier": VERIFIER}),
    )
    .await;
    assert_eq!(status, 401, "binding needs the account's own token");
    assert!(
        fake.codes.lock().contains_key("code-anon"),
        "no exchange before authentication"
    );

    let (status, _) = post(
        &base,
        "/api/v1/auth/palmx",
        None,
        json!({"code": "x", "code_verifier": "short"}),
    )
    .await;
    assert_eq!(
        status, 400,
        "malformed verifier is rejected before calling PalmX"
    );

    fake.issue("code-own", "open-free");
    post(
        &base,
        "/api/v1/auth/palmx/bind",
        Some(ALICE),
        json!({"code": "code-own", "code_verifier": VERIFIER}),
    )
    .await;
    let status = reqwest::Client::new()
        .delete(format!("{base}/api/v1/auth/palmx/bind"))
        .bearer_auth(ALICE)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16();
    assert_eq!(status, 200);
    fake.issue("code-after", "open-free");
    let (_, after) = post(
        &base,
        "/api/v1/auth/palmx",
        None,
        json!({"code": "code-after", "code_verifier": VERIFIER}),
    )
    .await;
    assert_eq!(
        after["sub"],
        crate::palmx::derived_uid("open-free"),
        "unbinding returns the palm to its own account"
    );
}

#[tokio::test]
async fn relays_without_palmx_hide_it_and_reject_its_routes() {
    let h = harness().await;
    let health: Value = reqwest::get(format!("{}/api/v1/healthz", h.base))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["login_methods"], json!([{"id": "email"}]));
    let (status, _) = post(
        &h.base,
        "/api/v1/auth/palmx",
        None,
        json!({"code": "c", "code_verifier": VERIFIER}),
    )
    .await;
    assert_eq!(status, 404);
}

async fn palm_relay() -> (String, std::sync::Arc<crate::palm::fake::FakePalm>) {
    let verifier = StaticVerifier::new([
        (ALICE.to_string(), "alice".to_string()),
        (BOB.to_string(), "bob".to_string()),
    ]);
    let fake = std::sync::Arc::new(crate::palm::fake::FakePalm::default());
    let palm = crate::palm::Palm::new(
        "app_test".into(),
        "https://palm.example.com/palm/x/jssdk/loader/palm-mobile-manager.js".into(),
        fake.clone(),
    );
    let state = RelayState::new(verifier, RelayTimings::default())
        .with_issuer("https://issuer.example.com")
        .with_palm(palm);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = build_router(state);
    tokio::spawn(async move { axum::serve(listener, router).await });
    (format!("http://{addr}"), fake)
}

#[tokio::test]
async fn palm_scans_sign_into_the_matched_account_exactly_once() {
    let (base, fake) = palm_relay().await;
    let health: Value = reqwest::get(format!("{base}/api/v1/healthz"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["login_methods"][0]["id"], "palm");
    assert_eq!(health["login_methods"][0]["app_id"], "app_test");

    let page = reqwest::get(format!("{base}/palm/capture")).await.unwrap();
    let csp = page.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(csp.contains("https://palm.example.com"), "{csp}");
    let html = page.text().await.unwrap();
    assert!(html.contains("https://palm.example.com/palm/x/jssdk/loader/palm-mobile-manager.js"));
    assert!(html.contains(r#"name="referrer" content="no-referrer""#));
    assert!(html.contains(&format!(r#"http-equiv="Content-Security-Policy" content="{csp}""#)));

    fake.scan("sess-1", "alice");
    let (status, tokens) = post(
        &base,
        "/api/v1/auth/palm",
        None,
        json!({"session_id": "sess-1"}),
    )
    .await;
    assert_eq!(status, 200, "{tokens}");
    assert_eq!(tokens["sub"], "alice");
    assert_eq!(tokens["provider"], "palm");

    let (status, _) = post(
        &base,
        "/api/v1/auth/palm",
        None,
        json!({"session_id": "sess-1"}),
    )
    .await;
    assert_eq!(status, 409, "a palm session signs in once");
}

#[tokio::test]
async fn palm_rejects_sessions_that_do_not_prove_a_one_to_n_match() {
    let (base, fake) = palm_relay().await;
    let cases = [
        (
            "registered",
            crate::palm::PalmSession {
                user_id: "alice".into(),
                search_match: None,
                registration: true,
            },
        ),
        (
            "compare-miss",
            crate::palm::PalmSession {
                user_id: "alice".into(),
                search_match: Some(false),
                registration: false,
            },
        ),
        (
            "no-user",
            crate::palm::PalmSession {
                user_id: String::new(),
                search_match: Some(true),
                registration: false,
            },
        ),
        (
            "bad-id",
            crate::palm::PalmSession {
                user_id: "a/b".into(),
                search_match: Some(true),
                registration: false,
            },
        ),
    ];
    for (id, session) in cases {
        fake.sessions.lock().insert(id.into(), session);
        let (status, body) =
            post(&base, "/api/v1/auth/palm", None, json!({"session_id": id})).await;
        assert_eq!(status, 401, "{id}: {body}");
    }
    let (status, _) = post(
        &base,
        "/api/v1/auth/palm",
        None,
        json!({"session_id": "unknown"}),
    )
    .await;
    assert_eq!(status, 401);
    assert!(
        fake.claimed.lock().is_empty(),
        "rejected scans are never claimed"
    );
}

#[tokio::test]
async fn palm_enrolment_is_scoped_to_the_signed_in_account() {
    let (base, fake) = palm_relay().await;
    let (status, _) = post(&base, "/api/v1/palm/enroll_token", None, json!({})).await;
    assert_eq!(status, 401);
    let (status, body) = post(&base, "/api/v1/palm/enroll_token", Some(BOB), json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(
        body["user_id"], "bob",
        "the token can only enrol the caller"
    );
    assert_eq!(*fake.tokens_for.lock(), ["bob"]);

    fake.enrolled.lock().insert("bob".into(), vec![2]);
    let client = reqwest::Client::new();
    let palm: Value = client
        .get(format!("{base}/api/v1/palm"))
        .bearer_auth(BOB)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(palm, json!({"enrolled": true, "sides": [2]}));
    let alice: Value = client
        .get(format!("{base}/api/v1/palm"))
        .bearer_auth(ALICE)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alice["enrolled"], false);
    client
        .delete(format!("{base}/api/v1/palm"))
        .bearer_auth(BOB)
        .send()
        .await
        .unwrap();
    assert!(fake.enrolled.lock().get("bob").is_none());
}

#[tokio::test]
async fn phones_sign_waiting_desktops_in_and_tokens_are_released_once() {
    let (base, fake) = palm_relay().await;
    let (_, handoff) = post(&base, "/api/v1/auth/palm/handoff", None, json!({})).await;
    let id = handoff["handoff_id"].as_str().unwrap().to_string();
    let secret = handoff["secret"].as_str().unwrap().to_string();
    let poll = |secret: String| {
        let url = format!("{base}/api/v1/auth/palm/handoff/{id}?secret={secret}");
        async move {
            let response = reqwest::get(url).await.unwrap();
            (
                response.status().as_u16(),
                response.json::<Value>().await.unwrap_or(Value::Null),
            )
        }
    };
    assert_eq!(poll(secret.clone()).await.1["state"], "pending");
    assert_eq!(
        poll("wrong".into()).await.0,
        404,
        "the QR id alone cannot collect tokens"
    );

    fake.scan("sess-h", "alice");
    let (status, _) = post(
        &base,
        &format!("/api/v1/auth/palm/handoff/{id}/approve"),
        None,
        json!({"session_id": "sess-h"}),
    )
    .await;
    assert_eq!(status, 200);
    let (status, approved) = poll(secret.clone()).await;
    assert_eq!(status, 200);
    assert_eq!(approved["tokens"]["sub"], "alice");
    assert_eq!(poll(secret).await.0, 404, "tokens are handed out once");

    let (status, _) = post(
        &base,
        &format!("/api/v1/auth/palm/handoff/{id}/approve"),
        None,
        json!({"session_id": "sess-h"}),
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn palm_sign_up_creates_only_the_minted_account() {
    let (base, fake) = palm_relay().await;
    let (status, start) = post(&base, "/api/v1/auth/palm/register", None, json!({})).await;
    assert_eq!(status, 200, "{start}");
    let user = start["user_id"].as_str().unwrap().to_string();
    assert!(user.starts_with("pl_") && user.len() == 31, "{user}");
    assert_eq!(*fake.tokens_for.lock(), [user.clone()], "the token enrols only the minted id");
    let finish = |session: &str, secret: &str| {
        json!({"registration_id": start["registration_id"], "secret": secret, "session_id": session})
    };
    let secret = start["secret"].as_str().unwrap();

    // A scan that enrolled someone else, or recognised instead of enrolling.
    fake.enrol("other", "alice");
    fake.scan("search", &user);
    for session in ["other", "search"] {
        let (status, _) = post(&base, "/api/v1/auth/palm/register/finish", None, finish(session, secret)).await;
        assert_eq!(status, 401, "{session}");
    }
    fake.enrol("mine", &user);
    let (status, _) = post(&base, "/api/v1/auth/palm/register/finish", None, finish("mine", "wrong")).await;
    assert_eq!(status, 404, "the secret binds the sign-up to its starter");
    let (status, tokens) = post(&base, "/api/v1/auth/palm/register/finish", None, finish("mine", secret)).await;
    assert_eq!(status, 200, "{tokens}");
    assert_eq!(tokens["sub"], user.as_str());
    let (status, _) = post(&base, "/api/v1/auth/palm/register/finish", None, finish("mine", secret)).await;
    assert_eq!(status, 404, "a sign-up completes once");
}

#[tokio::test]
async fn palm_sign_ups_are_rate_limited() {
    let (base, _) = palm_relay().await;
    for _ in 0..10 {
        assert_eq!(post(&base, "/api/v1/auth/palm/register", None, json!({})).await.0, 200);
    }
    assert_eq!(post(&base, "/api/v1/auth/palm/register", None, json!({})).await.0, 429);
}

async fn post_as_device(base: &str, path: &str, device: &str, body: Value) -> (u16, Value) {
    let response = reqwest::Client::new()
        .post(format!("{base}{path}"))
        .header("x-device-id", device)
        .json(&body)
        .send()
        .await
        .unwrap();
    (
        response.status().as_u16(),
        response.json().await.unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn palm_sessions_belong_to_the_signing_in_device() {
    let (base, fake) = palm_relay().await;

    // Each client keeps one id; a second sign-in from the same phone reuses
    // it, a different install has its own.
    fake.scan("sess-a", "alice");
    let (status, _) = post_as_device(
        &base,
        "/api/v1/auth/palm",
        "phone-install-0001",
        json!({"session_id": "sess-a"}),
    )
    .await;
    assert_eq!(status, 200);

    // A phone approving a waiting desktop signs the *desktop* in.
    let (_, handoff) = post_as_device(
        &base,
        "/api/v1/auth/palm/handoff",
        "desktop-install-0001",
        json!({}),
    )
    .await;
    let id = handoff["handoff_id"].as_str().unwrap();
    fake.scan("sess-b", "alice");
    let (status, _) = post_as_device(
        &base,
        &format!("/api/v1/auth/palm/handoff/{id}/approve"),
        "phone-install-0001",
        json!({"session_id": "sess-b"}),
    )
    .await;
    assert_eq!(status, 200);

    // Old clients without the header (or with a malformed one) never share
    // an id, so they cannot evict each other.
    fake.scan("sess-c", "alice");
    fake.scan("sess-d", "alice");
    post(&base, "/api/v1/auth/palm", None, json!({"session_id": "sess-c"})).await;
    post_as_device(&base, "/api/v1/auth/palm", "bad id!", json!({"session_id": "sess-d"})).await;

    let devices = fake.devices.lock().clone();
    assert_eq!(devices[..2], ["phone-install-0001", "desktop-install-0001"]);
    assert_ne!(devices[2], devices[3]);
    assert!(devices[2..].iter().all(|id| id.len() == 36), "{devices:?}");
}
