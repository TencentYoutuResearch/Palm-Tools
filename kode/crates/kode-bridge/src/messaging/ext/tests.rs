//! Real HTTP tests: an isolated hub, a scripted GUI runtime host on the same
//! runtime mailbox, and extension tokens minted through the admin route.
use super::super::{Config, Hub};
use crate::runtime::Publication;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;

const ADMIN: &str = "admin-test";
const BOOT: &str = "gui-test-boot";

struct Server {
    hub: Arc<Hub>,
    ctx: Arc<crate::Ctx>,
    url: String,
    task: tokio::task::JoinHandle<()>,
    _root: tempfile::TempDir,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.hub.shutdown();
        self.task.abort();
    }
}

async fn server() -> Server {
    let root = tempfile::tempdir().unwrap();
    let ctx = crate::build_test_ctx(Default::default(), ADMIN.into());
    let hub = Hub::open_with_agent_home(
        Config {
            node_id: "ext-test".into(),
            database: root.path().join("messages.sqlite"),
            peers: vec![],
        },
        &ctx,
        root.path().join("agent-home"),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = hub.router();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    hub.start();
    Server {
        hub,
        ctx,
        url,
        task,
        _root: root,
    }
}

fn publish(ctx: &Arc<crate::Ctx>, status: &str, events: Value) -> Value {
    let publication: Publication = serde_json::from_value(json!({
        "runtime":"gui","boot_id":BOOT,
        "sessions":[{"session_id":"gui:1:1","dto":{"title":"Fixture","backend_key":"claude","status":status},"events":events}]
    }))
    .unwrap();
    ctx.runtimes.publish(ctx, publication).unwrap()
}

/// Answers `create_session` and `input` like the GUI runtime does.
fn host(ctx: Arc<crate::Ctx>, inputs: Arc<Mutex<Vec<String>>>) -> tokio::task::JoinHandle<()> {
    let empty: Publication =
        serde_json::from_value(json!({"runtime":"gui","boot_id":BOOT,"sessions":[]})).unwrap();
    ctx.runtimes.publish(&ctx, empty).unwrap();
    tokio::spawn(async move {
        loop {
            let batch = ctx.runtimes.claim("gui", BOOT).unwrap();
            for command in batch["commands"].as_array().unwrap() {
                let value = match command["kind"].as_str().unwrap() {
                    "create_session" => {
                        assert_eq!(command["payload"]["backend_key"], "claude");
                        let mapped = publish(&ctx, "starting", json!([]));
                        let mut dto = ctx
                            .runtimes
                            .snapshot(mapped["sessions"][0]["id"].as_u64().unwrap())
                            .unwrap();
                        dto["id"] = mapped["sessions"][0]["id"].clone();
                        let ctx = ctx.clone();
                        // The CLI settles at its prompt a moment after spawning.
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                            publish(&ctx, "idle", json!([]));
                        });
                        dto
                    }
                    "input" => {
                        inputs
                            .lock()
                            .push(command["payload"]["text"].as_str().unwrap().into());
                        json!({"accepted":true})
                    }
                    other => panic!("unexpected runtime command {other}"),
                };
                ctx.runtimes
                    .settle(
                        "gui",
                        BOOT,
                        command["id"].as_str().unwrap(),
                        json!({"value":value}),
                    )
                    .unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
}

async fn grant(s: &Server, extension: &str, capabilities: &[&str]) -> String {
    let response: Value = reqwest::Client::new()
        .post(format!("{}/api/v1/messaging/extensions/grants", s.url))
        .bearer_auth(ADMIN)
        .json(&json!({"extension_id":extension,"capabilities":capabilities}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    response["token"].as_str().unwrap().into()
}

async fn wait_for(s: &Server, token: &str, kind: &str) -> Value {
    for _ in 0..200 {
        let page: Value = reqwest::Client::new()
            .get(format!("{}/api/ext/v1/events?after=0", s.url))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if let Some(event) = page["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == kind)
        {
            return event.clone();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("no {kind} event")
}

#[tokio::test]
async fn grants_are_admin_only_scoped_and_replaced_on_reissue() {
    let s = server().await;
    let client = reqwest::Client::new();
    let grants = format!("{}/api/v1/messaging/extensions/grants", s.url);
    let unknown = client
        .post(&grants)
        .bearer_auth(ADMIN)
        .json(&json!({"extension_id":"demo","capabilities":["workbench"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 400);
    let first = grant(&s, "demo", &["events.subscribe"]).await;
    let forged = client
        .post(&grants)
        .bearer_auth(&first)
        .json(&json!({"extension_id":"demo","capabilities":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        forged.status(),
        403,
        "an extension token cannot mint grants"
    );
    let hello: Value = client
        .get(format!("{}/api/ext/v1/hello", s.url))
        .bearer_auth(&first)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(hello["extension_id"], "demo");
    assert_eq!(hello["capabilities"], json!(["events.subscribe"]));
    let denied = client
        .post(format!("{}/api/ext/v1/sessions", s.url))
        .bearer_auth(&first)
        .json(&json!({"backend_key":"claude","cwd":"/tmp","idempotency_key":"k"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let second = grant(&s, "demo", &["events.subscribe"]).await;
    let stale = client
        .get(format!("{}/api/ext/v1/hello", s.url))
        .bearer_auth(&first)
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 401, "reissuing revokes the previous token");
    let admin_as_extension = client
        .get(format!("{}/api/ext/v1/hello", s.url))
        .bearer_auth(ADMIN)
        .send()
        .await
        .unwrap();
    assert_eq!(
        admin_as_extension.status(),
        401,
        "the admin token is not an extension identity"
    );
    client
        .delete(format!("{grants}/demo"))
        .bearer_auth(ADMIN)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let revoked = client
        .get(format!("{}/api/ext/v1/hello", s.url))
        .bearer_auth(&second)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 401);
}

#[tokio::test]
async fn owned_session_lifecycle_streams_turn_events_without_polling() {
    let s = server().await;
    let inputs = Arc::new(Mutex::new(vec![]));
    let _host = host(s.ctx.clone(), inputs.clone());
    let all = [
        "sessions.create",
        "sessions.input",
        "sessions.interrupt",
        "events.subscribe",
    ];
    let token = grant(&s, "team", &all).await;
    let other = grant(&s, "intruder", &all).await;
    let client = reqwest::Client::new();

    let mut stream = client
        .get(format!(
            "{}/api/ext/v1/events/stream?kinds=session.turn_started,session.turn_completed",
            s.url
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(stream.headers()["content-type"], "text/event-stream");

    let body = json!({"backend_key":"claude","cwd":"/tmp","initial_input":"hello agent","labels":["team:call"],"meta":{"call_id":"c1"},"idempotency_key":"call-c1"});
    let created: Value = client
        .post(format!("{}/api/ext/v1/sessions", s.url))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["session"]["id"].as_u64().unwrap();
    assert_eq!(created["session"]["ext"]["labels"], json!(["team:call"]));
    assert_eq!(created["initial_input"], "pending");
    let again: Value = client
        .post(format!("{}/api/ext/v1/sessions", s.url))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        again, created,
        "a retried creation returns the first outcome"
    );
    let mut changed = body.clone();
    changed["cwd"] = json!("/var");
    let conflict = client
        .post(format!("{}/api/ext/v1/sessions", s.url))
        .bearer_auth(&token)
        .json(&changed)
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), 409);

    let delivered = wait_for(&s, &token, "session.input_result").await;
    assert_eq!(delivered["payload"]["status"], "delivered");
    assert_eq!(
        *inputs.lock(),
        ["hello agent"],
        "initial input waits for the prompt and is sent once"
    );

    for path in [
        format!("/api/ext/v1/sessions/{id}"),
        format!("/api/ext/v1/events?session={id}"),
    ] {
        let foreign = client
            .get(format!("{}{path}", s.url))
            .bearer_auth(&other)
            .send()
            .await
            .unwrap();
        assert_eq!(
            foreign.status(),
            404,
            "{path} must not reveal another extension's session"
        );
    }
    let foreign_input = client
        .post(format!("{}/api/ext/v1/sessions/{id}/input", s.url))
        .bearer_auth(&other)
        .json(&json!({"text":"x","idempotency_key":"x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_input.status(), 404);
    let theirs: Value = client
        .get(format!("{}/api/ext/v1/sessions", s.url))
        .bearer_auth(&other)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(theirs["sessions"].as_array().unwrap().is_empty());
    let mine: Value = client
        .get(format!("{}/api/ext/v1/sessions?label=team:call", s.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(mine["sessions"][0]["id"], id);

    publish(
        &s.ctx,
        "busy",
        json!([
            {"key":"s1","kind":"session.status","payload":{"status":"busy"}},
            {"key":"m1","kind":"message","payload":{"id":"m1","role":"assistant","text":"working","streaming":true}},
            {"key":"s2","kind":"session.status","payload":{"status":"idle"}},
            {"key":"s3","kind":"session.status","payload":{"status":"busy"}},
            {"key":"m2","kind":"message","payload":{"id":"m2","role":"assistant","text":"final answer"}},
            {"key":"s4","kind":"session.status","payload":{"status":"idle"}},
        ]),
    );

    let mut events = vec![];
    let mut text = String::new();
    let read = async {
        while let Some(chunk) = stream.chunk().await.unwrap() {
            text.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(end) = text.find("\n\n") {
                let frame: String = text.drain(..end + 2).collect();
                if let Some(data) = frame.lines().find_map(|l| l.strip_prefix("data: ")) {
                    events.push(serde_json::from_str::<Value>(data).unwrap());
                }
            }
            if events.iter().any(|e| e["kind"] == "session.turn_completed") {
                break;
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), read)
        .await
        .expect("turn completion pushed");
    let kinds: Vec<_> = events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        ["session.turn_started", "session.turn_completed"],
        "an idle flicker inside the grace window is one turn"
    );
    let done = &events[1]["payload"];
    assert_eq!(done["turn_id"], events[0]["payload"]["turn_id"]);
    assert_eq!(done["final_message"]["text"], "final answer");
    assert_eq!(done["final_message"]["truncated"], false);
}
