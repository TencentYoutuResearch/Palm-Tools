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
    publish_as(ctx, "gui:1:1", "claude", status, events)
}

fn publish_as(ctx: &Arc<crate::Ctx>, native: &str, backend: &str, status: &str, events: Value) -> Value {
    let publication: Publication = serde_json::from_value(json!({
        "runtime":"gui","boot_id":BOOT,
        "sessions":[{"session_id":native,"dto":{"title":"Fixture","backend_key":backend,"status":status},"events":events}]
    }))
    .unwrap();
    ctx.runtimes.publish(ctx, publication).unwrap()
}

#[derive(Default)]
struct Recorded {
    creates: Vec<Value>,
    inputs: Vec<String>,
}

/// Answers `create_session` and `input` like the GUI runtime does: Claude
/// takes a persona as its system prompt, Codex does not.
fn host(ctx: Arc<crate::Ctx>, recorded: Arc<Mutex<Recorded>>) -> tokio::task::JoinHandle<()> {
    let empty: Publication =
        serde_json::from_value(json!({"runtime":"gui","boot_id":BOOT,"sessions":[]})).unwrap();
    ctx.runtimes.publish(&ctx, empty).unwrap();
    tokio::spawn(async move {
        loop {
            let batch = ctx.runtimes.claim_wait("gui", BOOT, std::time::Duration::from_secs(5)).await.unwrap();
            for command in batch["commands"].as_array().unwrap() {
                let value = match command["kind"].as_str().unwrap() {
                    "create_session" => {
                        let payload = command["payload"].clone();
                        let native = {
                            let mut recorded = recorded.lock();
                            recorded.creates.push(payload.clone());
                            format!("gui:1:{}", recorded.creates.len())
                        };
                        let backend = payload["backend_key"].as_str().unwrap().to_owned();
                        let mapped = publish_as(&ctx, &native, &backend, "starting", json!([]));
                        let mut dto = ctx.runtimes.snapshot(mapped["sessions"][0]["id"].as_u64().unwrap()).unwrap();
                        dto["id"] = mapped["sessions"][0]["id"].clone();
                        if payload["system_prompt"].is_string() {
                            dto["system_prompt"] = json!(if backend == "codex" { "unsupported" } else { "applied" });
                        }
                        let ctx = ctx.clone();
                        // The CLI settles at its prompt a moment after spawning.
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                            publish_as(&ctx, &native, &backend, "idle", json!([]));
                        });
                        dto
                    }
                    "input" => {
                        recorded.lock().inputs.push(command["payload"]["text"].as_str().unwrap().into());
                        json!({"accepted":true})
                    }
                    other => panic!("unexpected runtime command {other}"),
                };
                ctx.runtimes.settle("gui", BOOT, command["id"].as_str().unwrap(), json!({"value":value})).unwrap();
            }
        }
    })
}

async fn grant(s: &Server, extension: &str, capabilities: &[&str]) -> String {
    grant_with_tools(s, extension, capabilities, json!([])).await
}

async fn grant_with_tools(s: &Server, extension: &str, capabilities: &[&str], tools: Value) -> String {
    let response: Value = reqwest::Client::new()
        .post(format!("{}/api/v1/messaging/extensions/grants", s.url))
        .bearer_auth(ADMIN)
        .json(&json!({"extension_id":extension,"capabilities":capabilities,"agent_tools":tools}))
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
    wait_for_in(s, token, kind, "").await
}

async fn wait_for_in(s: &Server, token: &str, kind: &str, filter: &str) -> Value {
    for _ in 0..200 {
        let page: Value = reqwest::Client::new()
            .get(format!("{}/api/ext/v1/events?after=0{filter}", s.url))
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
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let _host = host(s.ctx.clone(), recorded.clone());
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
        recorded.lock().inputs,
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

async fn bots(s: &Server, change: Value) -> Value {
    reqwest::Client::new()
        .post(format!("{}/api/v1/messaging/workbench/bots", s.url))
        .bearer_auth(ADMIN)
        .json(&change)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn bot_sessions_carry_persona_scope_and_ceiling() {
    let s = server().await;
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let _host = host(s.ctx.clone(), recorded.clone());
    let client = reqwest::Client::new();
    let token = grant(&s, "team", &["sessions.create", "events.subscribe", "bots.read"]).await;
    let blind = grant(&s, "blind", &["sessions.create", "events.subscribe"]).await;
    let create = |token: &str, body: Value| {
        client.post(format!("{}/api/ext/v1/sessions", s.url)).bearer_auth(token.to_owned()).json(&body).send()
    };

    let none = create(&token, json!({"bot":"default","idempotency_key":"none"})).await.unwrap();
    assert_eq!(none.status(), 404, "no default bot until the user creates one");

    let kit = bots(&s, json!({"action":"upsert","bot":{"name":"Kit","persona":"You review code.","backend_key":"claude","permission_ceiling":"default","default_cwd":"/tmp"}})).await;
    let kit_id = kit["default_bot"].as_str().unwrap().to_owned();
    let rex = bots(&s, json!({"action":"upsert","bot":{"name":"Rex","persona":"You write tests.","backend_key":"codex","permission_ceiling":"plan"}})).await;
    let rex_id = rex["bots"][1]["id"].as_str().unwrap().to_owned();
    assert_eq!(rex["default_bot"], kit_id, "the first bot stays the default");

    let listed: Value = client.get(format!("{}/api/ext/v1/bots", s.url)).bearer_auth(&token).send().await.unwrap().json().await.unwrap();
    assert_eq!(listed["bots"][0]["default"], true);
    assert!(listed["bots"][0].get("persona").is_none(), "extensions never read personas");
    let hidden = client.get(format!("{}/api/ext/v1/bots", s.url)).bearer_auth(&blind).send().await.unwrap();
    assert_eq!(hidden.status(), 403);
    assert_eq!(create(&blind, json!({"bot":"default","idempotency_key":"b"})).await.unwrap().status(), 403);

    let over = create(&token, json!({"bot":"default","permission_mode":"bypassPermissions","idempotency_key":"over"})).await.unwrap();
    assert_eq!(over.status(), 403, "asking above the ceiling is refused, not lowered");
    let other_agent = create(&token, json!({"bot":"default","backend_key":"codex","idempotency_key":"agent"})).await.unwrap();
    assert_eq!(other_agent.status(), 400);

    let created: Value = create(&token, json!({"bot":"default","initial_input":"Review src/lib.rs","labels":["team:call"],"idempotency_key":"kit-1"}))
        .await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let labels = created["session"]["ext"]["labels"].clone();
    assert_eq!(labels, json!(["team:call", format!("bot:{kit_id}")]));
    {
        let recorded = recorded.lock();
        let payload = &recorded.creates[0];
        assert_eq!((payload["backend_key"].as_str(), payload["cwd"].as_str(), payload["permission_mode"].as_str()), (Some("claude"), Some("/tmp"), Some("default")));
        let persona = payload["system_prompt"].as_str().unwrap();
        assert!(persona.contains("You review code.") && persona.contains(&format!("bot:{kit_id}")));
    }
    let kit_session = created["session"]["id"].as_u64().unwrap();
    wait_for_in(&s, &token, "session.input_result", &format!("&session={kit_session}")).await;
    assert_eq!(recorded.lock().inputs, ["Review src/lib.rs"], "a system prompt persona is not repeated as a message");

    // Rex has no workspace of its own choosing: it gets a folder under the bots root.
    let root = tempfile::tempdir().unwrap();
    bots(&s, json!({"action":"set_root","root":root.path()})).await;
    let own: Value = create(&token, json!({"bot":rex_id,"idempotency_key":"rex-0"})).await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let home = root.path().join(&rex_id);
    assert_eq!(recorded.lock().creates[1]["cwd"].as_str(), home.to_str());
    assert!(home.is_dir(), "the bot's folder is created on first use");
    wait_for_in(&s, &token, "session.input_result", &format!("&session={}", own["session"]["id"])).await;
    let rex_created: Value = create(&token, json!({"bot":rex_id,"cwd":"/var","initial_input":"Add tests","idempotency_key":"rex-1"}))
        .await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(recorded.lock().creates[2]["permission_mode"], "plan");
    let rex_session = rex_created["session"]["id"].as_u64().unwrap();
    wait_for_in(&s, &token, "session.input_result", &format!("&session={rex_session}")).await;
    let inputs = recorded.lock().inputs.clone();
    let last = inputs.last().unwrap();
    assert!(last.starts_with("<kode-agent-persona") && last.ends_with("\n\nAdd tests"), "Codex gets its persona in the first message: {last}");

    bots(&s, json!({"action":"delete","id":kit_id})).await;
    assert_eq!(create(&token, json!({"bot":"default","idempotency_key":"after-delete"})).await.unwrap().status(), 404);
}

#[tokio::test]
async fn badges_and_notifications_reach_the_host_feed_with_badge_replay() {
    let s = server().await;
    let client = reqwest::Client::new();
    let token = grant(&s, "team", &["ui.notify"]).await;
    let silent = grant(&s, "silent", &["events.subscribe"]).await;
    let post = |token: &str, path: &str, body: Value| client.post(format!("{}/api/ext/v1/ui/{path}", s.url)).bearer_auth(token.to_owned()).json(&body).send();
    assert_eq!(post(&silent, "badge", json!({"panel":"team","count":1})).await.unwrap().status(), 403);
    post(&token, "badge", json!({"panel":"team","count":3})).await.unwrap().error_for_status().unwrap();
    let not_admin = client.get(format!("{}/api/v1/messaging/extensions/ui/stream", s.url)).bearer_auth(&token).send().await.unwrap();
    assert_eq!(not_admin.status(), 403, "only the host follows the feed");
    let mut feed = client.get(format!("{}/api/v1/messaging/extensions/ui/stream", s.url)).bearer_auth(ADMIN).send().await.unwrap().error_for_status().unwrap();
    post(&token, "notify", json!({"title":"@you in #general","body":"please review","panel":"team"})).await.unwrap().error_for_status().unwrap();
    assert_eq!(post(&token, "notify", json!({"title":" "})).await.unwrap().status(), 400);
    let mut text = String::new();
    let mut messages: Vec<Value> = vec![];
    let read = async {
        while messages.len() < 2 {
            let Some(chunk) = feed.chunk().await.unwrap() else { break };
            text.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(end) = text.find("\n\n") {
                let frame: String = text.drain(..end + 2).collect();
                if let Some(data) = frame.lines().find_map(|l| l.strip_prefix("data: ")) {
                    messages.push(serde_json::from_str(data).unwrap());
                }
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), read).await.expect("feed delivered");
    assert_eq!(messages[0], json!({"type":"badge","extension":"team","panel":"team","count":3}), "a new follower gets the current badge first");
    assert_eq!((messages[1]["type"].as_str(), messages[1]["extension"].as_str(), messages[1]["panel"].as_str()), (Some("notify"), Some("team"), Some("team")));
}


/// A CLI's session MCP for `native`, as Kode registers it.
fn session_token(s: &Server, native: &str, id: u64) -> String {
    let registration = s.hub.store.register(crate::messaging::model::RegisterRequest { session_id: native.into(), title: "t".into(), runtime: "dsh".into(), owner_token: None }).unwrap();
    s.hub.native.lock().insert(native.into(), id);
    registration.owner_token
}

#[tokio::test]
async fn extension_tools_reach_only_their_sessions_and_round_trip_through_the_extension() {
    let s = server().await;
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let _host = host(s.ctx.clone(), recorded.clone());
    let client = reqwest::Client::new();
    let grants = format!("{}/api/v1/messaging/extensions/grants", s.url);
    let tool = json!([{"name":"team_channel_post","description":"Post to the call's channel","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}},"labels":["team:call"]}]);
    let without = client.post(&grants).bearer_auth(ADMIN).json(&json!({"extension_id":"team","capabilities":["sessions.create"],"agent_tools":tool})).send().await.unwrap();
    assert_eq!(without.status(), 400, "tools need tools.provide");
    let reserved = client.post(&grants).bearer_auth(ADMIN).json(&json!({"extension_id":"team","capabilities":["tools.provide"],"agent_tools":[{"name":"kode_sessions_send","description":"x"}]})).send().await.unwrap();
    assert_eq!(reserved.status(), 400, "Kode's own tool names are reserved");
    let token = grant_with_tools(&s, "team", &["sessions.create", "tools.provide"], tool).await;

    let created: Value = client.post(format!("{}/api/ext/v1/sessions", s.url)).bearer_auth(&token)
        .json(&json!({"backend_key":"claude","cwd":"/tmp","labels":["team:call"],"idempotency_key":"t1"}))
        .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let owned = session_token(&s, "gui:1:1", created["session"]["id"].as_u64().unwrap());
    let stranger = session_token(&s, "gui:9:9", 999_999);

    let listed: Value = client.get(format!("{}/api/v1/messaging/extensions/tools", s.url)).bearer_auth(&owned).send().await.unwrap().json().await.unwrap();
    assert_eq!(listed["tools"][0]["name"], "team_channel_post");
    let started = std::time::Instant::now();
    let none: Value = client.get(format!("{}/api/v1/messaging/extensions/tools", s.url)).bearer_auth(&stranger).send().await.unwrap().json().await.unwrap();
    assert!(none["tools"].as_array().unwrap().is_empty());
    assert!(started.elapsed() < std::time::Duration::from_millis(500), "sessions nobody owns answer at once");

    let worker = {
        let (url, token) = (s.url.clone(), token.clone());
        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let batch: Value = client.get(format!("{url}/api/ext/v1/tools/next?wait=10")).bearer_auth(&token).send().await.unwrap().json().await.unwrap();
            let call = &batch["calls"][0];
            assert_eq!(call["name"], "team_channel_post");
            assert_eq!(call["session"]["labels"], json!(["team:call"]));
            let text = format!("posted: {}", call["arguments"]["text"].as_str().unwrap());
            client.post(format!("{url}/api/ext/v1/tools/{}/result", call["id"].as_str().unwrap())).bearer_auth(&token).json(&json!({"content":text})).send().await.unwrap().error_for_status().unwrap();
        })
    };
    let result: Value = client.post(format!("{}/api/v1/messaging/extensions/tools/call", s.url)).bearer_auth(&owned)
        .json(&json!({"name":"team_channel_post","arguments":{"text":"hello channel"}})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(result, json!({"text":"posted: hello channel","is_error":false}));
    worker.await.unwrap();
    let foreign = client.post(format!("{}/api/v1/messaging/extensions/tools/call", s.url)).bearer_auth(&stranger)
        .json(&json!({"name":"team_channel_post","arguments":{}})).send().await.unwrap();
    assert_eq!(foreign.status(), 404, "a session the extension does not own cannot call its tools");
}

async fn watches(s: &Server, change: Value) -> Value {
    let response = reqwest::Client::new()
        .post(format!("{}/api/v1/messaging/workbench/watches", s.url))
        .bearer_auth(ADMIN)
        .json(&change)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert!(status.is_success(), "{body}");
    body
}

async fn until<F: Fn(&Value) -> bool>(s: &Server, what: &str, ok: F) -> Value {
    let mut view = Value::Null;
    for _ in 0..200 {
        view = reqwest::Client::new()
            .get(format!("{}/api/v1/messaging/workbench/watches", s.url))
            .bearer_auth(ADMIN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if ok(&view) {
            return view;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}: {view}");
}

#[tokio::test]
async fn published_events_wake_a_bot_into_its_own_run_session() {
    let s = server().await;
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let _host = host(s.ctx.clone(), recorded.clone());
    let client = reqwest::Client::new();
    let work = tempfile::tempdir().unwrap();
    let kit = bots(&s, json!({"action":"upsert","bot":{"name":"Kit","persona":"You triage.","backend_key":"claude","permission_ceiling":"default","default_cwd":work.path()}})).await;
    let kit_id = kit["default_bot"].as_str().unwrap().to_owned();
    // Kit's main conversation, where run results are posted.
    publish_as(&s.ctx, "gui:main", "claude", "idle", json!([]));
    bots(&s, json!({"action":"set_main_session","id":kit_id,"session":{"runtime":"gui","session_id":"gui:main"}})).await;

    let bad = client
        .post(format!("{}/api/v1/messaging/workbench/watches", s.url))
        .bearer_auth(ADMIN)
        .json(&json!({"action":"upsert","bot":kit_id,"spec":{"name":"x","on":{"topic":"fs.changed"},"do":"look"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400, "file watches need a workspace");

    watches(&s, json!({"action":"upsert","bot":kit_id,"spec":{"name":"Mentions","on":{"topic":"kode.team/mention","match":{"room":"general"}},"do":"Answer the mention.","policy":{"coalesce_secs":0,"permission":"acceptEdits"}}})).await;
    // Watches any finished turn: the run's own turn must not trigger it.
    watches(&s, json!({"action":"upsert","bot":kit_id,"spec":{"name":"Turns","on":{"topic":"session.turn_completed"},"do":"Summarize.","policy":{"coalesce_secs":0}}})).await;

    let silent = grant(&s, "kode.team", &["events.subscribe"]).await;
    let refused = client.post(format!("{}/api/ext/v1/events/publish", s.url)).bearer_auth(&silent).json(&json!({"name":"mention","payload":{}})).send().await.unwrap();
    assert_eq!(refused.status(), 403);
    let team = grant(&s, "kode.team", &["events.publish"]).await;
    let publish_event = |payload: Value| client.post(format!("{}/api/ext/v1/events/publish", s.url)).bearer_auth(team.clone()).json(&json!({"name":"mention","payload":payload})).send();
    let other_room: Value = publish_event(json!({"room":"random","text":"hi"})).await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(other_room["topic"], "kode.team/mention");
    publish_event(json!({"room":"general","text":"@Kit can you check the build?"})).await.unwrap().error_for_status().unwrap();

    let view = until(&s, "the run to start", |v| v["runs"].as_array().unwrap().iter().any(|r| r["status"] == "running")).await;
    assert_eq!(view["runs"].as_array().unwrap().len(), 1, "the other room's mention does not match");
    let run = view["runs"][0].clone();
    let session = run["session_id"].as_u64().unwrap();
    {
        let recorded = recorded.lock();
        let payload = &recorded.creates[0];
        assert_eq!(payload["permission_mode"], "default", "the bot ceiling caps the watch");
        assert_eq!(payload["cwd"].as_str(), work.path().to_str(), "a run with no event workspace works in the bot's folder");
        assert!(payload["system_prompt"].as_str().unwrap().contains("You triage."));
    }
    for _ in 0..100 {
        if !recorded.lock().inputs.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let task = recorded.lock().inputs[0].clone();
    assert!(task.contains("@Kit can you check the build?") && task.contains("Answer the mention."), "{task}");

    publish_as(
        &s.ctx,
        "gui:1:1",
        "claude",
        "idle",
        json!([
            {"key":"r1","kind":"session.status","payload":{"status":"busy"}},
            {"key":"r2","kind":"message","payload":{"id":"r2","role":"assistant","text":"Build is green; replied in #general."}},
            {"key":"r3","kind":"session.status","payload":{"status":"idle"}},
        ]),
    );
    let view = until(&s, "the run to finish", |v| v["runs"][0]["status"] == "completed").await;
    assert_eq!(view["runs"][0]["summary"], "Build is green; replied in #general.");
    assert_eq!(view["runs"][0]["session_id"], session);
    assert_eq!(view["unseen"][&kit_id], 1);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let view = until(&s, "settled runs", |_| true).await;
    assert_eq!(view["runs"].as_array().unwrap().len(), 1, "a run's own turn never triggers a watch");

    for _ in 0..100 {
        if recorded.lock().inputs.len() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let posted = recorded.lock().inputs.get(1).cloned().unwrap_or_default();
    assert!(posted.contains("【关注 · Mentions】") && posted.contains("Build is green"), "the conclusion reaches the main conversation: {posted}");
    // The main conversation answering that is no reason to wake Kit again.
    publish_as(
        &s.ctx,
        "gui:main",
        "claude",
        "idle",
        json!([
            {"key":"m1","kind":"session.status","payload":{"status":"busy"}},
            {"key":"m2","kind":"message","payload":{"id":"m2","role":"assistant","text":"Noted."}},
            {"key":"m3","kind":"session.status","payload":{"status":"idle"}},
        ]),
    );
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    let view = until(&s, "settled runs", |_| true).await;
    assert_eq!(view["runs"].as_array().unwrap().len(), 1, "a bot's main conversation never triggers its own watches");

    // The same kind of event again continues the watch's session.
    publish_event(json!({"room":"general","text":"@Kit is the deploy done?"})).await.unwrap().error_for_status().unwrap();
    let view = until(&s, "the second run to start", |v| v["runs"].as_array().unwrap().len() == 2 && v["runs"][0]["status"] == "running").await;
    assert_eq!(view["runs"][0]["session_id"], session, "the second run reuses the first run's session");
    assert_eq!(recorded.lock().creates.len(), 1, "no new session for the same watch");
    let task = recorded.lock().inputs.iter().find(|t| t.contains("@Kit is the deploy done?")).cloned().unwrap_or_default();
    assert!(task.contains("Answer the mention.") && !task.contains("上一次运行的结论"), "{task}");
    publish_as(
        &s.ctx,
        "gui:1:1",
        "claude",
        "idle",
        json!([
            {"key":"r4","kind":"session.status","payload":{"status":"busy"}},
            {"key":"r5","kind":"message","payload":{"id":"r5","role":"assistant","text":"Deploy finished."}},
            {"key":"r6","kind":"session.status","payload":{"status":"idle"}},
        ]),
    );
    let view = until(&s, "the second run to finish", |v| v["runs"][0]["status"] == "completed").await;
    assert_eq!(view["runs"][0]["summary"], "Deploy finished.");
    assert_eq!(view["runs"][1]["summary"], "Build is green; replied in #general.", "the earlier run keeps its own result");

    let seen = watches(&s, json!({"action":"seen","bot":kit_id})).await;
    assert!(seen["unseen"].get(&kit_id).is_none());
}

#[tokio::test]
async fn file_changes_wake_a_bot_but_its_own_edits_do_not() {
    let s = server().await;
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let _host = host(s.ctx.clone(), recorded.clone());
    let repo = tempfile::tempdir().unwrap();
    let kit = bots(&s, json!({"action":"upsert","bot":{"name":"Kit","persona":"p","backend_key":"claude","permission_ceiling":"default","default_cwd":"/tmp"}})).await;
    let kit_id = kit["default_bot"].as_str().unwrap().to_owned();
    watches(&s, json!({"action":"upsert","bot":kit_id,"spec":{"name":"Docs","on":{"topic":"fs.changed","match":{"workspace":repo.path(),"paths":"docs/**"}},"do":"Check the docs.","policy":{"coalesce_secs":1}}})).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    std::fs::create_dir_all(repo.path().join("docs")).unwrap();
    std::fs::write(repo.path().join("docs/a.md"), "a").unwrap();
    std::fs::write(repo.path().join("docs/b.md"), "b").unwrap();

    let view = until(&s, "a file-triggered run", |v| v["runs"].as_array().unwrap().iter().any(|r| r["status"] == "running")).await;
    let real = repo.path().canonicalize().unwrap();
    assert_eq!(view["runs"][0]["workspace"].as_str(), real.to_str(), "the run works where the files changed");
    assert_eq!(recorded.lock().creates[0]["cwd"].as_str(), real.to_str());
    // The run edits docs itself: that must not queue another run.
    std::fs::write(repo.path().join("docs/c.md"), "c").unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    let view = until(&s, "runs", |_| true).await;
    assert_eq!(view["runs"].as_array().unwrap().len(), 1, "{}", view["runs"]);
}

async fn tasks(s: &Server, change: Value) -> (reqwest::StatusCode, Value) {
    let response = reqwest::Client::new().post(format!("{}/api/v1/messaging/workbench/bot-tasks", s.url)).bearer_auth(ADMIN).json(&change).send().await.unwrap();
    (response.status(), response.json().await.unwrap())
}

async fn inputs_containing(recorded: &Arc<Mutex<Recorded>>, needle: &str) -> String {
    for _ in 0..100 {
        if let Some(found) = recorded.lock().inputs.iter().find(|t| t.contains(needle)).cloned() {
            return found;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("no input contains {needle}: {:?}", recorded.lock().inputs);
}

#[tokio::test]
async fn a_bot_follows_the_conversation_doing_its_task_and_plans_wait_for_approval() {
    let s = server().await;
    let recorded = Arc::new(Mutex::new(Recorded::default()));
    let _host = host(s.ctx.clone(), recorded.clone());
    let kit = bots(&s, json!({"action":"upsert","bot":{"name":"Kit","backend_key":"claude"}})).await;
    let kit_id = kit["default_bot"].as_str().unwrap().to_owned();
    publish_as(&s.ctx, "gui:main", "claude", "idle", json!([]));
    bots(&s, json!({"action":"set_main_session","id":kit_id,"session":{"runtime":"gui","session_id":"gui:main"}})).await;
    publish_as(&s.ctx, "gui:worker", "claude", "idle", json!([]));

    let (status, body) = tasks(&s, json!({"action":"upsert","task":{"bot":kit_id,"title":""}})).await;
    assert_eq!(status, 400, "{body}");
    let (status, body) = tasks(&s, json!({"action":"upsert","task":{"bot":kit_id,"title":"Fix login","session":{"runtime":"gui","session_id":"gui:worker"}}})).await;
    assert!(status.is_success(), "{body}");
    let task = body["task"].clone();
    assert_eq!(task["status"], "in_progress", "linking a conversation starts the task");
    let id = task["id"].as_str().unwrap().to_owned();

    publish_as(&s.ctx, "gui:worker", "claude", "idle", json!([
        {"key":"w1","kind":"session.status","payload":{"status":"busy"}},
        {"key":"w2","kind":"message","payload":{"id":"w2","role":"assistant","text":"Login fixed, tests pass."}},
        {"key":"w3","kind":"session.status","payload":{"status":"idle"}},
    ]));
    let posted = inputs_containing(&recorded, "【任务 · Fix login】").await;
    assert!(posted.contains("Login fixed, tests pass.") && posted.contains("bot_task_update"), "{posted}");

    let (_, done) = tasks(&s, json!({"action":"upsert","task":{"id":id,"status":"done"}})).await;
    assert!(done["task"]["closed"].is_u64());
    let view = until(&s, "the task in the watch view", |v| v["tasks"].as_array().is_some_and(|t| t.iter().any(|t| t["status"] == "done"))).await;
    assert_eq!(view["tasks"][0]["title"], "Fix login");

    let (_, plan) = tasks(&s, json!({"action":"upsert","task":{"bot":kit_id,"kind":"plan","title":"Ship v2","status":"needs_user","payload":{"steps":[{"title":"Write migration"},{"title":"Update docs","detail":"README"}]}}})).await;
    let plan_id = plan["task"]["id"].as_str().unwrap().to_owned();
    let (status, _) = tasks(&s, json!({"action":"approve","id":id})).await;
    assert_eq!(status, 400, "a finished task is not approvable");
    let (status, body) = tasks(&s, json!({"action":"approve","id":plan_id,"note":"先做迁移"})).await;
    assert!(status.is_success(), "{body}");
    let started = inputs_containing(&recorded, "【计划已批准 · Ship v2】").await;
    assert!(started.contains("先做迁移") && started.contains("Write migration") && started.contains("task_id="), "{started}");
    let view = until(&s, "the plan's steps", |v| v["tasks"].as_array().unwrap().iter().filter(|t| t["status"] == "planned").count() == 2).await;
    assert!(view["tasks"].as_array().unwrap().iter().any(|t| t["title"] == "Update docs" && t["detail"] == "README"));

    let (_, draft) = tasks(&s, json!({"action":"upsert","task":{"bot":kit_id,"kind":"outbound","title":"发给研发群","status":"needs_user","payload":{"channel":"wecom","chat_id":"g1","content":"hi"}}})).await;
    let (status, _) = tasks(&s, json!({"action":"approve","id":draft["task"]["id"]})).await;
    assert_eq!(status, 400, "drafted messages are sent by the front end, not approved here");
    tasks(&s, json!({"action":"reject","id":draft["task"]["id"],"note":"语气太硬"})).await;
    let told = inputs_containing(&recorded, "你起草的消息没有发送").await;
    assert!(told.contains("语气太硬"), "{told}");

    let progress: Value = reqwest::Client::new().get(format!("{}/api/v1/messaging/workbench/progress?bot={kit_id}", s.url)).bearer_auth(ADMIN).send().await.unwrap().json().await.unwrap();
    let worker = progress["sessions"].as_array().unwrap().iter().find(|row| row["title"] == "Fixture" && row["turns"] == 1).cloned();
    assert_eq!(worker.map(|w| w["last_said"].clone()), Some(json!("Login fixed, tests pass.")), "{progress}");
    assert_eq!(progress["tasks"].as_array().unwrap().len(), 3, "{progress}");
}

#[tokio::test]
async fn quiet_hours_hold_bot_notifications_and_release_them_as_one() {
    let s = server().await;
    let kit = bots(&s, json!({"action":"upsert","bot":{"name":"Kit","backend_key":"claude"}})).await;
    let kit_id = kit["default_bot"].as_str().unwrap().to_owned();
    use chrono::Timelike;
    let now = chrono::Local::now();
    let start = format!("{:02}:{:02}", (now.hour() + 23) % 24, now.minute());
    let end = format!("{:02}:{:02}", (now.hour() + 1) % 24, now.minute());
    bots(&s, json!({"action":"set_quiet_hours","quiet_hours":{"start":start,"end":end}})).await;
    let mut feed = s.hub.ext.ui.subscribe();
    super::attention::notify(&s.hub, &kit_id, "Kit 在等你处理".into(), "x", "warning", None);
    super::attention::notify(&s.hub, &kit_id, "Kit 完成了".into(), "y", "success", None);
    assert!(feed.try_recv().is_err(), "nothing shows during quiet hours");
    bots(&s, json!({"action":"set_quiet_hours","quiet_hours":null})).await;
    super::attention::release_held(&s.hub);
    let digest = feed.try_recv().expect("one digest after quiet hours");
    assert!(digest["title"].as_str().unwrap().contains("2 条"), "{digest}");
    assert!(digest["body"].as_str().unwrap().contains("Kit 在等你处理"), "{digest}");
    assert!(feed.try_recv().is_err());
}
