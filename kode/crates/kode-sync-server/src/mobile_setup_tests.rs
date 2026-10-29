//! Exercise the mobile REST surface over the real desktop WebSocket transport.
use super::*;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue};

#[tokio::test]
async fn setup_requests_are_scoped_and_creates_are_not_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let origin = format!("http://{addr}");
    let state = ServerState::open(ServerConfig {
        database_path: dir.path().join("sync.db"),
        public_url: origin.clone(),
    })
    .unwrap();
    for device in ["desktop", "other"] {
        let db = state.inner.db.lock();
        db.execute("INSERT INTO devices(id,installation_id,name,token_hash,created_at,last_seen_at) VALUES(?1,?1,?1,?2,1,1)", params![device, token_hash(&format!("device-{device}"))]).unwrap();
        db.execute("INSERT INTO bindings(id,device_id,mobile_name,token_hash,scopes_json,created_at) VALUES(?1,?1,'phone',?2,?3,1)", params![device, token_hash(device), serde_json::to_string(&DEFAULT_SCOPES).unwrap()]).unwrap();
    }
    let router = build_router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let client = reqwest::Client::new();
    let mut ws_req = format!("ws://{addr}/api/v1/agent/ws?device_id=desktop")
        .into_client_request()
        .unwrap();
    ws_req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_static("Bearer device-desktop"),
    );
    let (mut agent, _) = tokio_tungstenite::connect_async(ws_req).await.unwrap();
    agent.next().await.unwrap().unwrap(); // server.hello

    // No token and another bound, offline device cannot reach this desktop.
    assert_eq!(
        client
            .get(format!("{origin}/api/v1/backends"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .get(format!("{origin}/api/v1/backends"))
            .bearer_auth("other")
            .send()
            .await
            .unwrap()
            .status(),
        409
    );

    for (path, kind, payload, result) in [
        (
            "/api/v1/backends",
            "backends",
            json!({}),
            json!({"home":"/workspace","backends":[{"key":"codex","model_flag":"--model"}]}),
        ),
        (
            "/api/v1/backends/codex/models",
            "models",
            json!({"backend_key":"codex"}),
            json!({"models":[{"id":"test-model","label":"Test model"}],"custom_allowed":true}),
        ),
        (
            "/api/v1/fs/list?path=%2Fworkspace&show_hidden=true",
            "directories",
            json!({"path":"/workspace","show_hidden":true}),
            json!({"path":"/workspace","parent":"/","entries":[]}),
        ),
    ] {
        let req = client.get(format!("{origin}{path}")).bearer_auth("desktop");
        let call = tokio::spawn(async move { req.send().await.unwrap() });
        let frame: Value =
            serde_json::from_str(agent.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(frame["type"], "setup.request");
        assert_eq!(frame["kind"], kind);
        assert_eq!(frame["payload"], payload);
        // A different device cannot consume or satisfy the pending request.
        mobile_setup::complete(
            &state,
            "other",
            frame["request_id"].as_str().unwrap(),
            "boot",
            200,
            json!({"wrong":true}),
        )
        .unwrap();
        agent.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"setup.result","request_id":frame["request_id"],"boot_id":"boot","status":200,"body":result}).to_string())).await.unwrap();
        let response = call.await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.json::<Value>().await.unwrap(), result);
    }
    let body = json!({"backend_key":"codex","cwd":"/workspace","model":"test-model"});
    let req = client
        .post(format!("{origin}/api/v1/sessions"))
        .bearer_auth("desktop")
        .header("Idempotency-Key", "create-1")
        .json(&body);
    let call = tokio::spawn(async move { req.send().await.unwrap() });
    let frame: Value =
        serde_json::from_str(agent.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(frame["kind"], "create_session");
    assert_eq!(frame["payload"], body);
    // While creation is in flight, retry checks the receipt without dispatch.
    assert_eq!(
        client
            .post(format!("{origin}/api/v1/sessions"))
            .bearer_auth("desktop")
            .header("Idempotency-Key", "create-1")
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    let dto = json!({"id":99,"backend_key":"codex","cwd":"/workspace","model":"test-model","status":"idle","tokens":{}});
    agent.send(tokio_tungstenite::tungstenite::Message::Text(json!({"type":"setup.result","request_id":frame["request_id"],"boot_id":"boot","status":200,"body":dto}).to_string())).await.unwrap();
    let response = call.await.unwrap();
    assert_eq!(response.status(), 200);
    let created: Value = response.json().await.unwrap();
    assert_ne!(created["id"], 99); // cloud ID, never desktop local ID
    let replay: Value = client
        .post(format!("{origin}/api/v1/sessions"))
        .bearer_auth("desktop")
        .header("Idempotency-Key", "create-1")
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(replay, created);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), agent.next())
            .await
            .is_err()
    );
    let list: Value = client
        .get(format!("{origin}/api/v1/sessions"))
        .bearer_auth("desktop")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["sessions"][0], created);
    assert_eq!(
        client
            .post(format!("{origin}/api/v1/sessions"))
            .bearer_auth("desktop")
            .header("Idempotency-Key", "create-1")
            .json(&json!({"backend_key":"claude"}))
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    assert_eq!(
        client
            .post(format!("{origin}/api/v1/sessions"))
            .bearer_auth("desktop")
            .header("Idempotency-Key", "bad")
            .json(&json!({"backend_key":"codex","extra_args":["--unsafe"]}))
            .send()
            .await
            .unwrap()
            .status(),
        422
    );
    // A receipt survives a server restart and does not need an online desktop.
    let reopened = ServerState::open(ServerConfig {
        database_path: dir.path().join("sync.db"),
        public_url: origin,
    })
    .unwrap();
    assert_eq!(
        reopened
            .inner
            .db
            .lock()
            .query_row(
                "SELECT status_code FROM session_creates WHERE idempotency_key='create-1'",
                [],
                |row| row.get::<_, u16>(0)
            )
            .unwrap(),
        200
    );
    assert!(state.inner.setup_pending.lock().is_empty());
    server.abort();
}
