//! Real HTTP/WS tests use isolated stores and loopback listeners, never user configuration.
use super::*;
use serde_json::{json, Value};
use tempfile::TempDir;
const SECRET: &str = "test-peer-secret-at-least-32-bytes";
struct Server {
    hub: Arc<Hub>,
    url: String,
    task: tokio::task::JoinHandle<()>,
    _ctx: Arc<crate::Ctx>,
    _root: TempDir,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.hub.shutdown();
        self.task.abort();
    }
}
async fn server(node: &str, peers: Vec<Peer>) -> Server {
    server_with_config(node, peers, kode_core::config::Config::default()).await
}
// Registry tests declare their available Agents rather than probing developer CLI installs.
fn fixture_agent_config(kinds: &[&str]) -> kode_core::config::Config {
    let mut config = kode_core::config::Config::default();
    config.backends.retain(|key, _| kinds.contains(&key.as_str()));
    for (key, backend) in &mut config.backends {
        backend.enabled = Some(true);
        backend.protocol = Some(key.clone());
        backend.command = "fixture-agent-not-executed".into();
    }
    config
}
async fn server_with_config(node: &str, peers: Vec<Peer>, config: kode_core::config::Config) -> Server {
    let root = tempfile::tempdir().unwrap();
    let ctx = crate::build_test_ctx(config, "admin-test".into());
    let hub = Hub::open_with_agent_home(
        Config {
            node_id: node.into(),
            database: root.path().join("messages.sqlite"),
            peers,
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
        url,
        task,
        _ctx: ctx,
        _root: root,
    }
}
fn peer(node: &str, url: Option<String>) -> Peer {
    Peer {
        node_id: node.into(),
        link_token: SECRET.into(),
        url,
        ssh: None,
    }
}
#[tokio::test]
async fn owner_can_pair_live_hosts_without_restart_or_exposing_link_secrets() {
    let left = server("pair-left", vec![]).await;
    let right = server("pair-right", vec![]).await;
    let sender = register(&left, "sender").await;
    let _receiver = register(&right, "receiver").await;
    let client = reqwest::Client::new();
    let path = format!("{}/api/v1/messaging/workbench/peers", left.url);
    let remote = peer("pair-right", Some(right.url.clone()));
    assert_eq!(
        client
            .post(&path)
            .bearer_auth(&sender.owner_token)
            .json(&remote)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    right.hub.add_peer(peer("pair-left", None)).unwrap();
    let response = client
        .post(&path)
        .bearer_auth("admin-test")
        .json(&remote)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    assert!(!response.text().await.unwrap().contains(SECRET));
    let stored = left.hub.store.document("managed-peers").unwrap();
    assert_eq!(stored["revision"], 1);
    assert_eq!(
        super::peers::load(&left.hub.store, &left.hub.config)
            .unwrap()
            .len(),
        1
    );
    assert!(client
        .post(&path)
        .bearer_auth("admin-test")
        .json(&remote)
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    assert_eq!(
        left.hub.store.document("managed-peers").unwrap()["revision"],
        1
    );
    let mut conflicting = remote.clone();
    conflicting.link_token = "a-different-owner-secret-32-characters".into();
    assert_eq!(
        client
            .post(&path)
            .bearer_auth("admin-test")
            .json(&conflicting)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !left
            .hub
            .directory()
            .unwrap()
            .iter()
            .any(|s| s.address.node_id == "pair-right")
        {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let response = send(
        &left,
        &sender.owner_token,
        &request("pair-right", "receiver", "paired-message"),
    )
    .await;
    assert!(response.status().is_success());
    let message: Message = response.json().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while right.hub.store.get(&message.id).unwrap().is_none() {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let remove = format!("{path}/remove");
    assert_eq!(
        client
            .post(&remove)
            .bearer_auth(&sender.owner_token)
            .json(&json!({"node_id":"pair-right"}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert!(client
        .post(&remove)
        .bearer_auth("admin-test")
        .json(&json!({"node_id":"pair-right"}))
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    assert!(left.hub.peers().is_empty());
    assert!(super::peers::load(&left.hub.store, &left.hub.config)
        .unwrap()
        .is_empty());
    assert!(!left.hub.peer_allowed("pair-right", SECRET));
}
#[tokio::test]
async fn workbench_configuration_is_durable_versioned_and_not_agent_accessible() {
    let s = server("workbench-test", vec![]).await;
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/workbench/documents/ssh-hosts", s.url);
    let absent: Value = client
        .get(&url)
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(absent, json!({"revision":0,"value":null}));
    let saved: Value = client
        .post(&url)
        .bearer_auth("admin-test")
        .json(&json!({"expected_revision":0,"value":[{"id":"build","token":"server-only-secret"}]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["revision"], 1);
    let stale = client
        .post(&url)
        .bearer_auth("admin-test")
        .json(&json!({"expected_revision":0,"value":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 400);
    let owner = register(&s, "agent-reader").await;
    assert_eq!(
        client
            .get(&url)
            .bearer_auth(owner.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let current: Value = client
        .get(&url)
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(current, saved);
    assert_eq!(
        client
            .get(format!(
                "{}/api/v1/messaging/workbench/documents/arbitrary-file",
                s.url
            ))
            .bearer_auth("admin-test")
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
}

#[tokio::test]
async fn archived_legacy_gui_tabs_need_no_adapter_and_are_restorable_without_losing_metadata() {
    let s = server("cold-archive", vec![]).await;
    let native_id = "session-kode-example";
    let tab = json!({"backend_key":"removed-claude","session_id":"old-native-thread","cwd":"/srv/project","title":"Original title","endpoint_id":null,"transport_kind":"acp"});
    let mut native = tab.clone();
    native["dsh_session_id"] = json!(native_id);
    native["title"] = json!("Saved metadata title");
    let index = s.hub.store.document("session-index").unwrap();
    s.hub
        .store
        .save_document(
            "session-index",
            index["revision"].as_u64().unwrap(),
            json!({"version":1,"gui":{"tabs":[tab],"endpoints":[]},"native_sessions":[native]}),
        )
        .unwrap();
    let document = super::workspaces::ensure(&s.hub).unwrap();
    let mut workspaces = document["value"].clone();
    workspaces["global"]["archivedSessionIds"] = json!([native_id]);
    let archived = s
        .hub
        .store
        .save_document(
            "workspaces",
            document["revision"].as_u64().unwrap(),
            workspaces.clone(),
        )
        .unwrap();
    let client = reqwest::Client::new();
    let catalog: Value = client
        .get(format!("{}/api/v1/messaging/workbench/catalog", s.url))
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(catalog["tabs"].as_array().unwrap().is_empty());
    workspaces["global"]["archivedSessionIds"] = json!([]);
    s.hub
        .store
        .save_document(
            "workspaces",
            archived["revision"].as_u64().unwrap(),
            workspaces,
        )
        .unwrap();
    let restored: Value = client
        .get(format!("{}/api/v1/messaging/workbench/catalog", s.url))
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(restored["tabs"][0]["title"], "Saved metadata title");
    assert_eq!(restored["tabs"][0]["session_id"], "old-native-thread");
    assert_eq!(restored["tabs"][0]["transport_kind"], "acp");
    assert_eq!(
        s.hub.store.document("session-index").unwrap()["value"]["gui"]["tabs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn runtime_directory_applies_archive_without_losing_history_or_identity() {
    let s = server("runtime-archive", vec![]).await;
    let publication = serde_json::from_value::<crate::runtime::Publication>(json!({
        "runtime":"dsh","boot_id":"archive-test","sessions":[{"session_id":"session-archive-example",
        "dto":{"title":"Archive fixture","status":"idle"},
        "events":[{"key":"one","kind":"message","payload":{"role":"user","text":"Retained history"}}]}]
    })).unwrap();
    let published = s._ctx.runtimes.publish(&s._ctx, publication).unwrap();
    let id = published["sessions"][0]["id"].as_u64().unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/runtime/sessions", s.url);
    let initial: Value = client.get(&url).bearer_auth("admin-test").send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(initial["sessions"][0]["id"], id);
    let document = super::workspaces::ensure(&s.hub).unwrap();
    let mut value = document["value"].clone();
    value["global"]["archivedSessionIds"] = json!(["session-archive-example"]);
    let saved = s.hub.store.save_document("workspaces", document["revision"].as_u64().unwrap(), value.clone()).unwrap();
    let archived: Value = client.get(&url).bearer_auth("admin-test").send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert!(archived["sessions"].as_array().unwrap().is_empty());
    assert_eq!(s._ctx.runtimes.history(id, 0, 100).unwrap().len(), 1);
    value["global"]["archivedSessionIds"] = json!([]);
    s.hub.store.save_document("workspaces", saved["revision"].as_u64().unwrap(), value).unwrap();
    let restored: Value = client.get(&url).bearer_auth("admin-test").send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(restored["sessions"][0]["id"], id);
}
async fn register(s: &Server, id: &str) -> Registration {
    reqwest::Client::new()
        .post(format!("{}/api/v1/messaging/sessions", s.url))
        .bearer_auth("admin-test")
        .json(&json!({"session_id":id,"title":id,"runtime":"dsh"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}
fn request(node: &str, target: &str, key: &str) -> SendRequest {
    SendRequest {
        source: None,
        target: Address {
            node_id: node.into(),
            session_id: target.into(),
        },
        content: "review this change".into(),
        idempotency_key: key.into(),
        in_reply_to: None,
        ttl_seconds: 300,
    }
}
async fn send(s: &Server, token: &str, req: &SendRequest) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{}/api/v1/messaging/messages", s.url))
        .bearer_auth(token)
        .json(req)
        .send()
        .await
        .unwrap()
}
async fn wait_status(hub: &Hub, id: &str, status: Status) {
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            if hub
                .store
                .get(id)
                .unwrap()
                .is_some_and(|m| m.status == status)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn pending_probe_is_scoped_read_only_and_excludes_expired_or_claimed_work() {
    let s = server("local", vec![]).await;
    let a = register(&s, "alice").await;
    let b = register(&s, "bob").await;
    let client = reqwest::Client::new();
    let path = format!("{}/api/v1/messaging/sessions/bob/pending", s.url);
    assert_eq!(
        client
            .get(&path)
            .bearer_auth(&a.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let m: Message = send(&s, &a.owner_token, &request("local", "bob", "wakeup"))
        .await
        .json()
        .await
        .unwrap();
    for _ in 0..2 {
        let probe: Value = client
            .get(&path)
            .bearer_auth(&b.owner_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(probe["pending"], 1);
        assert_eq!(
            s.hub.store.get(&m.id).unwrap().unwrap().status,
            Status::Received
        );
    }
    let mut expired = s.hub.store.get(&m.id).unwrap().unwrap();
    expired.expires_at = 0;
    s.hub.store.save(&expired).unwrap();
    assert_eq!(s.hub.store.pending_count("bob").unwrap(), 0);
    let _ = send(&s, &a.owner_token, &request("local", "bob", "claim-wakeup")).await;
    assert_eq!(s.hub.store.pending_count("bob").unwrap(), 1);
    s.hub.claim("bob").unwrap();
    assert_eq!(s.hub.store.pending_count("bob").unwrap(), 0);
}

#[tokio::test]
async fn scoped_http_delivery_reply_dedup_and_access_control() {
    let s = server("local", vec![]).await;
    let a = register(&s, "alice").await;
    let b = register(&s, "bob").await;
    let c = register(&s, "charlie").await;
    let req = request("local", "bob", "one");
    let m: Message = send(&s, &a.owner_token, &req)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let again: Message = send(&s, &a.owner_token, &req).await.json().await.unwrap();
    assert_eq!(m.id, again.id);
    let mut changed = req.clone();
    changed.content = "different".into();
    assert_eq!(send(&s, &a.owner_token, &changed).await.status(), 400);
    let mut spoof = req;
    spoof.source = Some("bob".into());
    assert_eq!(send(&s, &a.owner_token, &spoof).await.status(), 403);
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .get(format!("{}/api/v1/messaging/messages/{}", s.url, m.id))
            .bearer_auth(&c.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{}/api/v1/messaging/node", s.url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let claim: Value = client
        .post(format!("{}/api/v1/messaging/sessions/bob/claim", s.url))
        .bearer_auth(&b.owner_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(claim["messages"][0]["id"], m.id);
    let empty: Value = client
        .post(format!("{}/api/v1/messaging/sessions/bob/claim", s.url))
        .bearer_auth(&b.owner_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(empty["messages"].as_array().unwrap().len(), 0);
    let settle = client
        .post(format!("{}/api/v1/messaging/messages/{}", s.url, m.id))
        .bearer_auth(&b.owner_token)
        .json(&json!({"session_id":"bob","status":"accepted"}))
        .send()
        .await
        .unwrap();
    assert!(settle.status().is_success());
    let mut reply = request("local", "alice", "reply");
    reply.content = "review done".into();
    reply.in_reply_to = Some(m.id.clone());
    assert!(send(&s, &b.owner_token, &reply).await.status().is_success());
    let events: Value = client
        .get(format!("{}/api/v1/messaging/events", s.url))
        .bearer_auth(&c.owner_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(events["events"].as_array().unwrap().is_empty());
    assert_eq!(register_conflict(&s, "alice").await, 400);
}
async fn register_conflict(s: &Server, id: &str) -> u16 {
    reqwest::Client::new()
        .post(format!("{}/api/v1/messaging/sessions", s.url))
        .bearer_auth("admin-test")
        .json(&json!({"session_id":id,"title":id}))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}
#[tokio::test]
async fn one_initiated_link_delivers_both_directions_and_replies() {
    let remote = server("remote", vec![peer("local", None)]).await;
    let local = server("local", vec![peer("remote", Some(remote.url.clone()))]).await;
    let a = register(&local, "alice").await;
    let b = register(&remote, "bob").await;
    let m: Message = send(&local, &a.owner_token, &request("remote", "bob", "cross"))
        .await
        .json()
        .await
        .unwrap();
    wait_status(&remote.hub, &m.id, Status::Received).await;
    let claimed = remote.hub.claim("bob").unwrap();
    assert_eq!(claimed[0].id, m.id);
    remote
        .hub
        .settle("bob", &m.id, Status::Accepted, None)
        .unwrap();
    wait_status(&local.hub, &m.id, Status::Accepted).await;
    let mut reply = request("local", "alice", "back");
    reply.in_reply_to = Some(m.id);
    let r: Message = send(&remote, &b.owner_token, &reply)
        .await
        .json()
        .await
        .unwrap();
    wait_status(&local.hub, &r.id, Status::Received).await;
    let claimed = local.hub.claim("alice").unwrap();
    assert_eq!(claimed[0].id, r.id);
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    assert!(local
        .hub
        .directory()
        .unwrap()
        .iter()
        .any(|s| s.address.node_id == "remote" && s.address.session_id == "bob"));
    assert_eq!(remote.hub.store.messages().unwrap().len(), 2);
}
#[tokio::test]
async fn durable_reopen_fences_owners_and_marks_ambiguous_submission() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("store.sqlite");
    let ctx = crate::build_test_ctx(kode_core::config::Config::default(), "admin".into());
    let cfg = Config {
        node_id: "local".into(),
        database: path.clone(),
        peers: vec![],
    };
    let hub = Hub::open(cfg.clone(), &ctx).unwrap();
    let a = hub
        .store
        .register(RegisterRequest {
            session_id: "alice".into(),
            title: "Alice".into(),
            runtime: "dsh".into(),
            owner_token: None,
        })
        .unwrap();
    hub.store
        .register(RegisterRequest {
            session_id: "bob".into(),
            title: "Bob".into(),
            runtime: "dsh".into(),
            owner_token: None,
        })
        .unwrap();
    let m = hub
        .send("alice", request("local", "bob", "durable"))
        .unwrap();
    hub.claim("bob").unwrap();
    assert!(Hub::open(cfg.clone(), &ctx).is_err());
    drop(hub);
    let hub = Hub::open(cfg, &ctx).unwrap();
    assert_eq!(
        hub.store.get(&m.id).unwrap().unwrap().status,
        Status::Uncertain
    );
    let resumed = hub
        .store
        .register(RegisterRequest {
            session_id: "alice".into(),
            title: "restored".into(),
            runtime: "dsh".into(),
            owner_token: Some(a.owner_token.clone()),
        })
        .unwrap();
    assert_ne!(a.owner_token, resumed.owner_token);
    assert!(hub.store.principal(&a.owner_token).unwrap().is_none());
    assert!(
        !hub.store
            .sessions()
            .unwrap()
            .iter()
            .find(|s| s.address.session_id == "bob")
            .unwrap()
            .online
    );
    assert!(hub.claim("bob").unwrap().is_empty());
    assert!(Store::open(&path, "different").is_err());
}
#[tokio::test]
async fn expired_messages_never_enter_runtime_and_foreign_peers_cannot_spoof() {
    let s = server("local", vec![peer("remote", None)]).await;
    register(&s, "alice").await;
    register(&s, "bob").await;
    let mut m = s
        .hub
        .send("alice", request("local", "bob", "expiry"))
        .unwrap();
    m.expires_at = now() - 1;
    s.hub.store.save(&m).unwrap();
    assert!(s.hub.claim("bob").unwrap().is_empty());
    assert_eq!(
        s.hub.store.get(&m.id).unwrap().unwrap().status,
        Status::Expired
    );
    assert!(s.hub.receive("remote", m).is_err());
}

/// Run explicitly with a disposable sshd fixture; a direct loopback WS test is not SSH proof.
#[tokio::test]
#[ignore = "requires KODE_TEST_SSH_CONFIG and KODE_TEST_SSH_PORT for an isolated sshd"]
async fn ssh_link_delivers_messages_in_both_directions() {
    let config_file = std::env::var_os("KODE_TEST_SSH_CONFIG")
        .expect("SSH fixture config")
        .into();
    let port = std::env::var("KODE_TEST_SSH_PORT")
        .expect("SSH fixture port")
        .parse()
        .unwrap();
    let remote = server("remote", vec![peer("local", None)]).await;
    let remote_port = remote.url.rsplit(':').next().unwrap().parse().unwrap();
    let mut connection = peer("remote", None);
    connection.ssh = Some(super::ssh::SshConfig {
        host: "messaging.example".into(),
        port,
        remote_port,
        config_file: Some(config_file),
    });
    let local = server("local", vec![connection]).await;
    let alice = register(&local, "alice").await;
    let bob = register(&remote, "bob").await;
    let m: Message = send(
        &local,
        &alice.owner_token,
        &request("remote", "bob", "over-ssh"),
    )
    .await
    .error_for_status()
    .unwrap()
    .json()
    .await
    .unwrap();
    wait_status(&remote.hub, &m.id, Status::Received).await;
    assert_eq!(remote.hub.claim("bob").unwrap()[0].id, m.id);
    remote
        .hub
        .settle("bob", &m.id, Status::Accepted, None)
        .unwrap();
    wait_status(&local.hub, &m.id, Status::Accepted).await;
    let mut reply = request("local", "alice", "ssh-reply");
    reply.in_reply_to = Some(m.id);
    let m: Message = send(&remote, &bob.owner_token, &reply)
        .await
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    wait_status(&local.hub, &m.id, Status::Received).await;
}

#[tokio::test]
async fn existing_pty_session_receives_once_after_busy_and_approval_clear() {
    use kode_core::{
        config::BackendConfig,
        session::{state::Status as RuntimeStatus, Session},
    };
    let s = server("local", vec![]).await;
    let backend = BackendConfig {
        effort: None,
        protocol: None,
        command: "/bin/sh".into(),
        args: vec!["-c".into(), "cat".into()],
        default_model: None,
        model_flag: None,
        permission_mode_flag: None,
        mcp_setup: None,
        acp: None,
        enabled: None,
    };
    let mut session = Session::new(
        77,
        "fixture-cli",
        &backend,
        100,
        30,
        std::time::Duration::from_secs(1),
        100,
        s._root.path(),
        s._ctx.core_tx.clone(),
        None,
        None,
        None,
        false,
        None,
        &[],
        None,
    )
    .unwrap();
    session.state.status = RuntimeStatus::Busy;
    s._ctx.sessions.lock().insert(77, session);
    s.hub.tick().await.unwrap();
    let target = s
        .hub
        .store
        .sessions()
        .unwrap()
        .into_iter()
        .find(|i| i.runtime == "kode")
        .unwrap()
        .address;
    let alice = register(&s, "alice").await;
    let req = request("local", &target.session_id, "pty-once");
    let m: Message = send(&s, &alice.owner_token, &req)
        .await
        .json()
        .await
        .unwrap();
    s.hub.tick().await.unwrap();
    assert_eq!(
        s.hub.store.get(&m.id).unwrap().unwrap().status,
        Status::Received
    );
    s._ctx.sessions.lock().get_mut(&77).unwrap().state.status = RuntimeStatus::Idle;
    s._ctx.bus.emit(crate::EventEnvelope::new(
        77,
        "ask_user_question",
        json!({"question":"approve?"}),
    ));
    s.hub.tick().await.unwrap();
    assert_eq!(
        s.hub.store.get(&m.id).unwrap().unwrap().status,
        Status::Received
    );
    s._ctx.bus.emit(crate::EventEnvelope::new(
        77,
        "session.attention_cleared",
        json!({}),
    ));
    s.hub.tick().await.unwrap();
    wait_status(&s.hub, &m.id, Status::Accepted).await;
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if s._ctx.sessions.lock()[&77]
                .parser
                .screen()
                .contents()
                .contains("review this change")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let repeated: Message = send(&s, &alice.owner_token, &req)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(m.id, repeated.id);
    assert!(s.hub.claim(&target.session_id).unwrap().is_empty());
    s._ctx.sessions.lock().remove(&77);
}

#[tokio::test]
async fn failed_receiver_reconnects_and_drains_durable_outbox_without_duplicates() {
    // Keep the remote store across a bridge restart, while the initiating node stays up.
    let root = tempfile::tempdir().unwrap();
    let config = Config {
        node_id: "remote".into(),
        database: root.path().join("messages.sqlite"),
        peers: vec![peer("local", None)],
    };
    let ctx = crate::build_test_ctx(kode_core::config::Config::default(), "admin-test".into());
    let remote = Hub::open(config.clone(), &ctx).unwrap();
    remote
        .store
        .register(RegisterRequest {
            session_id: "bob".into(),
            title: "Bob".into(),
            runtime: "dsh".into(),
            owner_token: None,
        })
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = remote.router();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    remote.start();
    let local = server(
        "local",
        vec![peer("remote", Some(format!("http://{address}")))],
    )
    .await;
    let alice = register(&local, "alice").await;
    let first: Message = send(
        &local,
        &alice.owner_token,
        &request("remote", "bob", "before-disconnect"),
    )
    .await
    .json()
    .await
    .unwrap();
    wait_status(&remote, &first.id, Status::Received).await;
    remote.shutdown();
    task.abort();
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    drop(remote);
    let queued: Message = send(
        &local,
        &alice.owner_token,
        &request("remote", "bob", "while-offline"),
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(queued.status, Status::Queued);
    let recovered = Hub::open(config, &ctx).unwrap();
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    let router = recovered.router();
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    recovered.start();
    wait_status(&recovered, &queued.id, Status::Received).await;
    assert_eq!(recovered.store.messages().unwrap().len(), 2);
    let one = recovered.claim("bob").unwrap();
    assert_eq!(one[0].id, first.id);
    recovered
        .settle("bob", &first.id, Status::Accepted, None)
        .unwrap();
    let two = recovered.claim("bob").unwrap();
    assert_eq!(two[0].id, queued.id);
    recovered
        .settle("bob", &queued.id, Status::Accepted, None)
        .unwrap();
    wait_status(&local.hub, &queued.id, Status::Accepted).await;
    assert!(recovered.claim("bob").unwrap().is_empty());
    recovered.shutdown();
    task.abort();
}

#[tokio::test]
async fn native_configs_with_the_same_agent_type_and_uuid_remain_independent() {
    let s = server("local", vec![]).await;
    for (id, key) in [(71, "codex"), (72, "tcodex")] {
        let session = kode_core::session::Session::structured(
            id,
            key,
            key,
            s._root.path(),
            "same-native-uuid".into(),
            "fixture".into(),
        );
        s._ctx.sessions.lock().insert(id, session);
    }
    s.hub.tick().await.unwrap();
    let directory = s.hub.store.sessions().unwrap();
    assert!(directory
        .iter()
        .any(|s| s.address.session_id == "kode:codex:same-native-uuid"));
    assert!(directory
        .iter()
        .any(|s| s.address.session_id == "kode:tcodex:same-native-uuid"));
    let client = reqwest::Client::new();
    for id in [71, 72] {
        let response = client
            .post(format!("{}/api/v1/messaging/native/{id}/credential", s.url))
            .bearer_auth("admin-test")
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let scoped: Value = response.json().await.unwrap();
        let own: Value = client
            .get(format!("{}/api/v1/messaging/self", s.url))
            .bearer_auth(scoped["token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(own["address"], scoped["address"]);
    }
    let alice = register(&s, "alice").await;
    let m: Message = send(
        &s,
        &alice.owner_token,
        &request("local", "kode:codex:same-native-uuid", "no-live-runtime"),
    )
    .await
    .json()
    .await
    .unwrap();
    s.hub.tick().await.unwrap();
    assert_eq!(
        s.hub.store.get(&m.id).unwrap().unwrap().status,
        Status::Received
    );
    assert_eq!(
        client
            .post(format!("{}/api/v1/messaging/native/71/credential", s.url))
            .bearer_auth(&alice.owner_token)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
}

#[tokio::test]
async fn reply_chain_is_bounded_and_late_receipts_resolve_uncertainty() {
    let s = server("local", vec![peer("remote", None)]).await;
    register(&s, "alice").await;
    register(&s, "bob").await;
    let mut message = s
        .hub
        .send("alice", request("local", "bob", "root"))
        .unwrap();
    for hop in 1..=8 {
        let mut reply = request("local", &message.source.session_id, &format!("hop-{hop}"));
        reply.in_reply_to = Some(message.id.clone());
        message = s.hub.send(&message.target.session_id, reply).unwrap();
        assert_eq!(message.hop_count, hop);
    }
    let mut reply = request("local", &message.source.session_id, "too-many");
    reply.in_reply_to = Some(message.id.clone());
    assert!(s
        .hub
        .send(&message.target.session_id, reply)
        .unwrap_err()
        .to_string()
        .contains("chain limit"));
    let mut remote = s
        .hub
        .send("alice", request("remote", "bob", "uncertain-remote"))
        .unwrap();
    remote.status = Status::Uncertain;
    s.hub.store.save(&remote).unwrap();
    s.hub
        .receipt("remote", &remote.id, Status::Accepted, None)
        .unwrap();
    assert_eq!(
        s.hub.store.get(&remote.id).unwrap().unwrap().status,
        Status::Accepted
    );
}

#[tokio::test]
async fn title_refresh_preserves_owner_and_claim_and_reaches_peer_directory() {
    let remote = server("remote", vec![peer("local", None)]).await;
    let local = server("local", vec![peer("remote", Some(remote.url.clone()))]).await;
    let a = register(&local, "alice").await;
    let b = register(&local, "bob").await;
    let m: Message = send(
        &local,
        &b.owner_token,
        &request("local", "alice", "title-check"),
    )
    .await
    .json()
    .await
    .unwrap();
    local.hub.claim("alice").unwrap();
    let endpoint = format!("{}/api/v1/messaging/sessions/alice/title", local.url);
    let client = reqwest::Client::new();
    let denied = client
        .post(&endpoint)
        .bearer_auth(&b.owner_token)
        .json(&json!({"title":"Wrong owner"}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status().as_u16(), 403);
    client
        .post(&endpoint)
        .bearer_auth(&a.owner_token)
        .json(&json!({"title":"Architecture review"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        local.hub.store.principal(&a.owner_token).unwrap(),
        Some("alice".into())
    );
    assert_eq!(
        local.hub.store.get(&m.id).unwrap().unwrap().status,
        Status::Delivering
    );
    let invalid = client
        .post(&endpoint)
        .bearer_auth(&a.owner_token)
        .json(&json!({"title":""}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status().as_u16(), 400);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if remote.hub.directory().unwrap().iter().any(|s| {
            s.address.node_id == "local"
                && s.address.session_id == "alice"
                && s.title == "Architecture review"
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "peer title did not refresh"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn empty_workspaces() -> Value {
    json!({"version":2,"tables":{"workspaces":{}},"global":{"initialized":true,"workspaceIds":[],"archivedSessionIds":[],"pinnedSessionIds":[]}})
}
#[tokio::test]
async fn native_catalog_survives_opened_tab_saves_and_uses_workspace_titles() {
    let s = server("session-catalog-local", vec![]).await;
    let mut projects = empty_workspaces();
    projects["tables"]["workspaces"]["project"] =
        json!({"path":"/srv/project","title":"Named project","sessionIds":["inline-session"]});
    projects["global"]["workspaceIds"] = json!(["project"]);
    s.hub
        .store
        .save_document("workspaces", 0, projects)
        .unwrap();
    let tab = json!({"backend_key":"codex","cwd":"/srv/project","session_id":"native-thread","title":"Native helper","env":{"SECRET":"must-not-leak"}});
    s.hub
        .store
        .save_document(
            "session-index",
            0,
            json!({"gui":{"tabs":[tab],"endpoints":[]}}),
        )
        .unwrap();
    let mut agents = s.hub.store.document("agents").unwrap();
    agents["value"]["bindings"] = json!({"inline-session":{"threadId":"native-thread","profile":{"env":{"SECRET":"must-not-leak"}}}});
    s.hub
        .store
        .save_document(
            "agents",
            agents["revision"].as_u64().unwrap(),
            agents["value"].clone(),
        )
        .unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/workbench/sessions", s.url);
    let first: Value = client
        .get(&url)
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["tabs"][0]["workspace_title"], "Named project");
    assert_eq!(first["tabs"][0]["dsh_session_id"], "inline-session");
    assert!(!first.to_string().contains("must-not-leak"));
    let mut index = s.hub.store.document("session-index").unwrap();
    index["value"]["gui"]["tabs"] = json!([]);
    s.hub
        .store
        .save_document(
            "session-index",
            index["revision"].as_u64().unwrap(),
            index["value"].clone(),
        )
        .unwrap();
    let after: Value = client
        .get(&url)
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["tabs"].as_array().unwrap().len(), 1);
    assert_eq!(after["tabs"][0]["session_id"], "native-thread");
    let owner = register(&s, "catalog-reader").await;
    assert_eq!(
        client
            .get(&url)
            .bearer_auth(owner.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
}
#[tokio::test]
async fn peer_session_catalog_is_paginated_scoped_and_credential_free() {
    let remote = server("catalog-remote", vec![peer("catalog-local", None)]).await;
    let local = server(
        "catalog-local",
        vec![peer("catalog-remote", Some(remote.url.clone()))],
    )
    .await;
    remote
        .hub
        .store
        .save_document("workspaces", 0, empty_workspaces())
        .unwrap();
    let rows=(0..50).map(|i|json!({"backend_key":"codex","session_id":format!("thread-{i}"),"cwd":format!("/srv/{}","directory".repeat(300)),"title":"Remote helper","env":{"SECRET":"private"}})).collect::<Vec<_>>();
    remote.hub.store.save_document("session-index",0,json!({"native_sessions":rows,"gui":{"tabs":[{"backend_key":"codex","session_id":"foreign","cwd":"/srv/foreign","endpoint_id":{"kind":"remote","id":"another.example"}}],"endpoints":[{"token":"private"}]}})).unwrap();
    let mut offset = 0;
    let mut count = 0;
    loop {
        let page = local
            .hub
            .workspace(
                "catalog-remote",
                workspaces::Command::SessionCatalog { offset },
            )
            .await
            .unwrap();
        assert_eq!(page["node_id"], "catalog-remote");
        assert!(page.to_string().len() < 64 * 1024);
        assert!(!page.to_string().contains("private"));
        for row in page["tabs"].as_array().unwrap() {
            assert!(row["endpoint_id"].is_null());
            assert_eq!(row["workspace_title"], "未分组");
        }
        count += page["tabs"].as_array().unwrap().len();
        if let Some(next) = page["next_offset"].as_u64() {
            offset = next as usize;
        } else {
            break;
        }
    }
    assert_eq!(count, 50);
    assert!(local.hub.workspace_pending.lock().is_empty());
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(1),
        local
            .hub
            .workspace("catalog-remote", workspaces::Command::List),
    )
    .await;
    assert!(local.hub.workspace_pending.lock().is_empty());
}
#[tokio::test]
async fn workspaces_are_one_durable_node_owned_catalog_without_default_recreation() {
    let s = server("workspace-local", vec![]).await;
    s.hub
        .store
        .save_document("workspaces", 0, empty_workspaces())
        .unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/workbench/workspaces", s.url);
    let path = s._root.path().join("project");
    std::fs::create_dir(&path).unwrap();
    let created: Value = client
        .post(&url)
        .bearer_auth("admin-test")
        .json(&json!({"action":"create","path":path}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["workspace_id"].as_str().unwrap();
    assert_eq!(created["workspaces"].as_array().unwrap().len(), 1);
    let doc = s.hub.store.document("workspaces").unwrap();
    assert_eq!(
        doc["value"]["tables"]["workspaces"][id]["path"],
        json!(std::fs::canonicalize(&path).unwrap())
    );
    let again: Value = client
        .post(&url)
        .bearer_auth("admin-test")
        .json(&json!({"action":"create","path":path}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["workspace_id"], id);
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("admin-test")
            .json(&json!({"action":"create","path":"relative/path"}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let owner = register(&s, "workspace-reader").await;
    assert_eq!(
        client
            .get(&url)
            .bearer_auth(owner.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    client
        .post(&url)
        .bearer_auth("admin-test")
        .json(&json!({"action":"delete","id":id}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let empty: Value = client
        .get(&url)
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(empty["workspaces"].as_array().unwrap().is_empty());
    assert!(path.is_dir());
    assert!(
        s.hub.store.document("workspaces").unwrap()["value"]["global"]
            .get("defaultWorkspaceId")
            .is_none()
    );
}
#[tokio::test]
async fn workspace_operations_route_to_the_ssh_peer_node_and_cannot_use_local_ids() {
    let remote = server("workspace-remote", vec![peer("workspace-local", None)]).await;
    let local = server(
        "workspace-local",
        vec![peer("workspace-remote", Some(remote.url.clone()))],
    )
    .await;
    for s in [&local, &remote] {
        s.hub
            .store
            .save_document("workspaces", 0, empty_workspaces())
            .unwrap();
    }
    let remote_path = remote._root.path().join("remote-project");
    std::fs::create_dir(&remote_path).unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/workbench/workspaces", local.url);
    let created:Value=client.post(&url).bearer_auth("admin-test").json(&json!({"action":"create","node_id":"workspace-remote","path":remote_path,"title":"Remote project"})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(created["node_id"], "workspace-remote");
    assert_eq!(created["workspaces"][0]["title"], "Remote project");
    assert!(
        local.hub.store.document("workspaces").unwrap()["value"]["tables"]["workspaces"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    let wrong=client.post(&url).bearer_auth("admin-test").json(&json!({"action":"rename","node_id":"workspace-remote","id":"local-only-workspace","title":"Wrong"})).send().await.unwrap();
    assert_eq!(wrong.status(), 400);
    let viewed: Value = client
        .get(&url)
        .query(&[("node_id", "workspace-remote")])
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        viewed["workspaces"][0]["path"],
        json!(std::fs::canonicalize(&remote_path).unwrap())
    );
}

#[tokio::test]
async fn durable_runtime_observations_recover_uncertainty_without_granting_foreign_authority() {
    let s = server("evidence", vec![]).await;
    let alice = register(&s, "alice").await;
    let bob = register(&s, "bob").await;
    let stranger = register(&s, "stranger").await;
    let m: Message = send(
        &s,
        &alice.owner_token,
        &request("evidence", "bob", "observation"),
    )
    .await
    .json()
    .await
    .unwrap();
    s.hub.claim("bob").unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/messages/{}/delivery", s.url, m.id);
    let observation = |phase: &str, seq: Option<u64>| json!({"session_id":"bob","input_id":"stable-input","phase":phase,"event_seq":seq});
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&alice.owner_token)
            .json(&observation("prepared", None))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&bob.owner_token)
            .json(&observation("queued", None))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    client
        .post(&url)
        .bearer_auth(&bob.owner_token)
        .json(&observation("prepared", None))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    // Simulate lost owner/process: no replay, only durable evidence may resolve it.
    let mut uncertain = s.hub.store.get(&m.id).unwrap().unwrap();
    uncertain.status = Status::Uncertain;
    s.hub.store.save(&uncertain).unwrap();
    let queued: Value = client
        .post(&url)
        .bearer_auth(&bob.owner_token)
        .json(&observation("queued", None))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        s.hub.store.get(&m.id).unwrap().unwrap().status,
        Status::Accepted
    );
    let repeat: Value = client
        .post(&url)
        .bearer_auth(&bob.owner_token)
        .json(&observation("prepared", None))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        queued, repeat,
        "late observations must not regress durable state"
    );
    let mut wrong = observation("consumed", Some(42));
    wrong["input_id"] = json!("another-input");
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&bob.owner_token)
            .json(&wrong)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&bob.owner_token)
            .json(&observation("consumed", None))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    client
        .post(&url)
        .bearer_auth(&bob.owner_token)
        .json(&observation("consumed", Some(42)))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert!(s
        .hub
        .store
        .pending_deliveries("bob", "")
        .unwrap()
        .is_empty());
    let visible: Value = client
        .get(&url)
        .bearer_auth(&alice.owner_token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(visible["delivery"]["phase"], "consumed");
    assert_eq!(visible["delivery"]["event_seq"], 42);
    assert_eq!(
        client
            .get(&url)
            .bearer_auth(&stranger.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let list = format!("{}/api/v1/messaging/sessions/bob/deliveries", s.url);
    assert_eq!(
        client
            .get(list)
            .bearer_auth(&alice.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
}

#[tokio::test]
async fn negotiated_delivery_observations_reach_sender_and_ack_without_duplicate_audit() {
    use super::delivery::{Observation, Phase};
    let remote = server("observer", vec![peer("origin", None)]).await;
    let source = server("origin", vec![peer("observer", Some(remote.url.clone()))]).await;
    let sender = register(&source, "sender").await;
    register(&remote, "worker").await;
    let message: Message = send(
        &source,
        &sender.owner_token,
        &request("observer", "worker", "observed"),
    )
    .await
    .json()
    .await
    .unwrap();
    wait_status(&remote.hub, &message.id, Status::Received).await;
    remote.hub.claim("worker").unwrap();
    for phase in [Phase::Prepared, Phase::Queued, Phase::Consumed] {
        let event_seq = if phase == Phase::Consumed {
            Some(8)
        } else {
            None
        };
        remote
            .hub
            .observe_delivery(
                &message.id,
                Observation {
                    session_id: "worker".into(),
                    input_id: "stable-remote-input".into(),
                    phase,
                    event_seq,
                },
            )
            .unwrap();
    }
    let original = remote.hub.store.delivery_batch("origin").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if source
                .hub
                .store
                .delivery_mirror(&message.id)
                .unwrap()
                .is_some_and(|r| r.phase == Phase::Consumed)
                && remote
                    .hub
                    .store
                    .delivery_batch("origin")
                    .unwrap()
                    .is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(original.len(), 3);
    source.hub.mirror_deliveries("observer", &original).unwrap(); // lost ack replay
    source.hub.mirror_deliveries("observer", &original).unwrap();
    let count: u64 = source
        .hub
        .store
        .db
        .lock()
        .query_row("SELECT COUNT(*) FROM delivery_mirror_events", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 3);
    assert!(source.hub.mirror_deliveries("foreign", &original).is_err());
    let mut conflicting = original.clone();
    conflicting[0].record.input_id = "different".into();
    assert!(source
        .hub
        .mirror_deliveries("observer", &conflicting)
        .is_err());
    assert!(
        source
            .hub
            .store
            .delivery_batch("observer")
            .unwrap()
            .is_empty(),
        "mirrors are not re-exported as locally observed events"
    );
    let response: Value = reqwest::Client::new()
        .get(format!(
            "{}/api/v1/messaging/messages/{}/delivery",
            source.url, message.id
        ))
        .bearer_auth(&sender.owner_token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["scope"], "remote_mirror");
    assert_eq!(response["execution_node"], "observer");
    assert_eq!(response["delivery"]["phase"], "consumed");
    use super::cancellation::{Report, State as CancelState};
    let control = source.hub.request_cancellation(&message.id).unwrap();
    assert!(
        source
            .hub
            .pending_cancellations("worker", "")
            .unwrap()
            .is_empty(),
        "remote session name cannot alias a local worker"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while remote
            .hub
            .pending_cancellations("worker", "")
            .unwrap()
            .is_empty()
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(remote
        .hub
        .receive_cancellation("foreign", control.clone())
        .is_err());
    remote
        .hub
        .receive_cancellation("origin", control.clone())
        .unwrap();
    remote
        .hub
        .report_cancellation(
            &message.id,
            Report {
                session_id: "worker".into(),
                input_id: control.input_id.clone(),
                state: CancelState::CancelUnconfirmed,
                reason: Some("stop_requested".into()),
            },
        )
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while source.hub.cancellation(&message.id).unwrap().unwrap().state == CancelState::Requested
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(source
        .hub
        .outgoing_cancellations("observer", "")
        .unwrap()
        .is_empty());
    let replay = remote
        .hub
        .receive_cancellation("origin", control)
        .unwrap()
        .unwrap();
    assert!(source
        .hub
        .receive_cancellation("foreign", replay.clone())
        .is_err());
    for _ in 0..2 {
        source
            .hub
            .receive_cancellation("observer", replay.clone())
            .unwrap();
    }
    for hub in [&source.hub, &remote.hub] {
        let count: u64 = hub
            .store
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM input_cancellation_events", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 2, "replayed request/result must not duplicate audit");
    }
}

#[tokio::test]
async fn input_cancellation_is_sender_scoped_durable_and_result_is_target_scoped() {
    use super::{
        cancellation::State,
        delivery::{Observation, Phase},
    };
    use reqwest::StatusCode;
    let s = server("local", vec![]).await;
    let sender = register(&s, "sender").await;
    let worker = register(&s, "worker").await;
    let foreign = register(&s, "foreign").await;
    let m: Message = send(
        &s,
        &sender.owner_token,
        &request("local", "worker", "cancel-input"),
    )
    .await
    .json()
    .await
    .unwrap();
    s.hub.claim("worker").unwrap();
    s.hub
        .observe_delivery(
            &m.id,
            Observation {
                session_id: "worker".into(),
                input_id: "bound-input".into(),
                phase: Phase::Prepared,
                event_seq: None,
            },
        )
        .unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/messages/{}/cancellation", s.url, m.id);
    for credential in [&foreign.owner_token, &worker.owner_token] {
        assert_eq!(
            client
                .post(&url)
                .bearer_auth(credential)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    for _ in 0..2 {
        let value: Value = client
            .post(&url)
            .bearer_auth(&sender.owner_token)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(value["state"], "requested");
        assert_eq!(value["input_id"], "bound-input");
    }
    assert_eq!(s.hub.pending_cancellations("worker", "").unwrap().len(), 1);
    let body = json!({"session_id":"worker","input_id":"bound-input","state":"queued_removed"});
    assert_eq!(
        client
            .post(format!("{url}/result"))
            .bearer_auth(&sender.owner_token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    for _ in 0..2 {
        client
            .post(format!("{url}/result"))
            .bearer_auth(&worker.owner_token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    assert_eq!(
        s.hub.cancellation(&m.id).unwrap().unwrap().state,
        State::QueuedRemoved
    );
    assert!(s
        .hub
        .pending_cancellations("worker", "")
        .unwrap()
        .is_empty());
    let count: u64 = s
        .hub
        .store
        .db
        .lock()
        .query_row("SELECT COUNT(*) FROM input_cancellation_events", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 2, "duplicate request/result cannot duplicate audit");
    let wrong = json!({"session_id":"worker","input_id":"other-input","state":"queued_removed"});
    assert_eq!(
        client
            .post(format!("{url}/result"))
            .bearer_auth(&worker.owner_token)
            .json(&wrong)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .get(&url)
            .bearer_auth(&foreign.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let audit_url = format!("{}/api/v1/messaging/lifecycle-events", s.url);
    let visible: Value = client
        .get(&audit_url)
        .bearer_auth(&sender.owner_token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let events = visible["events"].as_array().unwrap();
    assert!(events
        .iter()
        .any(|e| e["kind"] == "delivery" && e["data"]["phase"] == "prepared"));
    assert_eq!(
        events
            .iter()
            .filter(|e| e["kind"] == "cancellation")
            .count(),
        2
    );
    assert!(events.iter().all(|e| e["message_id"] == m.id));
    let hidden: Value = client
        .get(&audit_url)
        .bearer_auth(&foreign.owner_token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(hidden["events"].as_array().unwrap().is_empty());
    let after: Value = client
        .get(format!("{audit_url}?after={}", visible["cursor"]))
        .bearer_auth(&sender.owner_token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(after["events"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn operation_authority_separates_owner_worker_and_human_stop_attestation() {
    let s = server("local", vec![]).await;
    let owner = register(&s, "owner").await;
    let worker = register(&s, "worker").await;
    let foreign = register(&s, "foreign").await;
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/operations", s.url);
    let prepare = json!({"owner_session":"owner","request_key":"request","worker":{"node_id":"local","session_id":"worker"}});
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&foreign.owner_token)
            .json(&prepare)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let row: Value = client
        .post(&url)
        .bearer_auth(&owner.owner_token)
        .json(&prepare)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!("{url}/{}", row["id"].as_str().unwrap());
    let claim = json!({"attempt":1,"epoch":1,"expected_revision":1,"action":{"kind":"claim","lease_ms":60000}});
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&owner.owner_token)
            .json(&claim)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let active: Value = client
        .post(&url)
        .bearer_auth(&worker.owner_token)
        .json(&claim)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let cancel = json!({"attempt":1,"epoch":1,"expected_revision":active["operation"]["revision"],"action":{"kind":"cancel"}});
    let result: Value = client
        .post(&url)
        .bearer_auth(&owner.owner_token)
        .json(&cancel)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(result["operation"]["state"], "cancelling");
    let stop = json!({"attempt":1,"epoch":result["operation"]["epoch"],"expected_revision":result["operation"]["revision"],"action":{"kind":"attest_stopped","reason":"owner inspected processes"}});
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&worker.owner_token)
            .json(&stop)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&owner.owner_token)
            .json(&stop)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let stopped: Value = client
        .post(&url)
        .bearer_auth("admin-test")
        .json(&stop)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stopped["operation"]["state"], "stopped");
    assert_eq!(
        client
            .get(&url)
            .bearer_auth(&foreign.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{url}/events"))
            .bearer_auth(&foreign.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
}

#[tokio::test]
async fn resource_account_authority_rejects_sessions_and_exposes_epoch_invalidation() {
    let s = server("home", vec![]).await;
    let agent = register(&s, "worker").await;
    let client = reqwest::Client::new();
    let accounts = format!("{}/api/v1/messaging/resource-accounts", s.url);
    let bindings = format!("{}/api/v1/messaging/resource-bindings", s.url);
    let command = json!({"id":"shared","expected_epoch":0,"enabled":true});
    assert_eq!(
        client
            .post(&accounts)
            .bearer_auth(&agent.owner_token)
            .json(&command)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(&accounts)
            .json(&command)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let created: Value = client
        .post(&accounts)
        .bearer_auth("admin-test")
        .json(&command)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(created["epoch"], 1);
    assert_eq!(
        client
            .get(format!("{accounts}/shared"))
            .bearer_auth(&agent.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let binding = json!({"host":"remote","profile":"fixture","account_id":"shared","account_epoch":1,"expected_revision":0});
    assert_eq!(
        client
            .post(&bindings)
            .bearer_auth(&agent.owner_token)
            .json(&binding)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    client
        .post(&bindings)
        .bearer_auth("admin-test")
        .json(&binding)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    client
        .post(&accounts)
        .bearer_auth("admin-test")
        .json(&json!({"id":"shared","expected_epoch":1,"enabled":true}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        client
            .get(format!("{bindings}?host=remote"))
            .bearer_auth(&agent.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let page: Value = client
        .get(format!("{bindings}?host=remote"))
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page["bindings"][0]["binding_current"], false);
    assert_eq!(page["bindings"][0]["quota_status"], "not_connected");
    assert_eq!(page["next"], "fixture");
    assert_eq!(page["may_have_more"], false);
}

#[tokio::test]
async fn quota_snapshots_require_admin_and_exact_resource_epoch() {
    let s = server("home", vec![]).await;
    let agent = register(&s, "worker").await;
    let client = reqwest::Client::new();
    let accounts = format!("{}/api/v1/messaging/resource-accounts", s.url);
    let bindings = format!("{}/api/v1/messaging/resource-bindings", s.url);
    let quota = format!("{}/api/v1/messaging/quota-snapshots", s.url);
    client
        .post(&accounts)
        .bearer_auth("admin-test")
        .json(&json!({"id":"account","expected_epoch":0,"enabled":true}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    client.post(&bindings).bearer_auth("admin-test").json(&json!({"host":"home","profile":"worker","account_id":"account","account_epoch":1,"expected_revision":0})).send().await.unwrap().error_for_status().unwrap();
    let sample = json!({"host":"home","profile":"worker","account_id":"account","account_epoch":1,"binding_revision":1,"observed_at_ms":now(),"buckets":[],"truncated":false});
    assert_eq!(
        client
            .post(&quota)
            .bearer_auth(&agent.owner_token)
            .json(&sample)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .get(format!("{quota}?host=home&profile=worker"))
            .bearer_auth(&agent.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    client
        .post(&quota)
        .bearer_auth("admin-test")
        .json(&sample)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let duplicate: Value = client
        .post(&quota)
        .bearer_auth("admin-test")
        .json(&sample)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(duplicate["duplicate"], true);
    client
        .post(&accounts)
        .bearer_auth("admin-test")
        .json(&json!({"id":"account","expected_epoch":1,"enabled":false}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert!(!client
        .post(&quota)
        .bearer_auth("admin-test")
        .json(&sample)
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    let view: Value = client
        .get(format!("{quota}?host=home&profile=worker"))
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view["status"], "binding_changed");
}

#[tokio::test]
async fn resource_invalidation_is_idempotent_and_does_not_revoke_a_new_binding() {
    let s = server("home", vec![]).await;
    let agent = register(&s, "worker").await;
    let client = reqwest::Client::new();
    s.hub
        .store
        .change_resource_account(super::resources::AccountCommand {
            id: "a".into(),
            expected_epoch: 0,
            enabled: true,
        })
        .unwrap();
    let command = super::resources::BindingCommand {
        host: "home".into(),
        profile: "worker".into(),
        account_id: "a".into(),
        account_epoch: 1,
        expected_revision: 0,
    };
    s.hub.store.bind_resource_account(command.clone()).unwrap();
    let url = format!("{}/api/v1/messaging/resource-binding/invalidate", s.url);
    let input = json!({"host":"home","profile":"worker","expected_revision":1});
    assert_eq!(
        client
            .post(&url)
            .bearer_auth(&agent.owner_token)
            .json(&input)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for _ in 0..2 {
        client
            .post(&url)
            .bearer_auth("admin-test")
            .json(&input)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    assert_eq!(
        s.hub.store.resource_binding("home", "worker").unwrap()["binding_current"],
        false
    );
    s.hub
        .store
        .bind_resource_account(super::resources::BindingCommand {
            expected_revision: 2,
            ..command
        })
        .unwrap();
    assert!(!client
        .post(&url)
        .bearer_auth("admin-test")
        .json(&input)
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    assert_eq!(
        s.hub.store.resource_binding("home", "worker").unwrap()["binding_current"],
        true
    );
}

#[tokio::test]
async fn budget_admin_authority_and_idempotent_accounting_over_http() {
    let s = server("home", vec![]).await;
    let agent = register(&s, "worker").await;
    let client = reqwest::Client::new();
    let at = now();
    let budgets = format!("{}/api/v1/messaging/budgets", s.url);
    let reserves = format!("{}/api/v1/messaging/budget-reservations", s.url);
    let config = json!({"id":"team","scope":"team","scope_id":"team","unit":"usd_micros","limit":100,"starts_at":at-1,"ends_at":at+60000,"expected_revision":0});
    assert_eq!(
        client
            .post(&budgets)
            .bearer_auth(&agent.owner_token)
            .json(&config)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    client
        .post(&budgets)
        .bearer_auth("admin-test")
        .json(&config)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let request = json!({"id":"reservation","budget_ids":["team"],"amount":70,"unit":"usd_micros","operation_id":"operation"});
    assert_eq!(
        client
            .post(&reserves)
            .bearer_auth(&agent.owner_token)
            .json(&request)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for _ in 0..2 {
        client
            .post(&reserves)
            .bearer_auth("admin-test")
            .json(&request)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    let settlement = json!({"event_id":"bill","expected_revision":1,"total_charge":30,"finalized":true,"basis":"reported"});
    let settle = format!("{reserves}/reservation/settle");
    assert_eq!(
        client
            .post(&settle)
            .bearer_auth(&agent.owner_token)
            .json(&settlement)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for _ in 0..2 {
        client
            .post(&settle)
            .bearer_auth("admin-test")
            .json(&settlement)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    assert_eq!(
        client
            .get(format!("{budgets}/team"))
            .bearer_auth(&agent.owner_token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let view: Value = client
        .get(format!("{budgets}/team"))
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view["label"], "团队预算");
    assert_eq!(view["available"], 70);
    assert_eq!(view["budget"]["spent"], 30);
    assert_eq!(view["budget"]["reserved"], 0);
    for path in [
        format!("{reserves}/reservation"),
        format!("{reserves}/reservation/settlements/bill"),
        format!("{budgets}/team/events"),
        format!("{budgets}/team/reservations"),
    ] {
        assert_eq!(
            client
                .get(&path)
                .bearer_auth(&agent.owner_token)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        client
            .get(&path)
            .bearer_auth("admin-test")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    let missing = client
        .get(format!("{reserves}/missing"))
        .bearer_auth("admin-test")
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
}

#[tokio::test]
async fn metered_usage_and_price_versions_are_trusted_admin_only() {
    let s = server("home", vec![]).await;
    let agent = register(&s, "worker").await;
    let client = reqwest::Client::new();
    let at = now();
    let price_url = format!("{}/api/v1/messaging/price-versions", s.url);
    let usage_url = format!("{}/api/v1/messaging/metered-usage", s.url);
    let price = json!({"id":"v1","model":"fixture","unit":"credits","input_per_million":1000000,"cached_per_million":0,"output_per_million":2000000});
    assert_eq!(
        client
            .post(&price_url)
            .bearer_auth(&agent.owner_token)
            .json(&price)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    client
        .post(&price_url)
        .bearer_auth("admin-test")
        .json(&price)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    s.hub
        .store
        .configure_budget(
            super::budgets::Configure {
                id: "team".into(),
                scope: super::budgets::Scope::Team,
                scope_id: "team".into(),
                unit: "credits".into(),
                limit: 100,
                starts_at: at - 1,
                ends_at: at + 60000,
                expected_revision: 0,
            },
            at,
        )
        .unwrap();
    s.hub
        .store
        .reserve_budget(
            super::budgets::Reserve {
                id: "hold".into(),
                budget_ids: vec!["team".into()],
                amount: 50,
                unit: "credits".into(),
                operation_id: "op".into(),
            },
            at,
        )
        .unwrap();
    let binding_url = format!(
        "{}/api/v1/messaging/budget-reservations/hold/pricing",
        s.url
    );
    assert_eq!(
        client
            .post(&binding_url)
            .bearer_auth(&agent.owner_token)
            .json(&json!({"price_id":"v1"}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    client
        .post(&binding_url)
        .bearer_auth("admin-test")
        .json(&json!({"price_id":"v1"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let usage = json!({"event_id":"usage","reservation_id":"hold","expected_revision":1,"model":"fixture","input_tokens":10,"cached_input_tokens":0,"output_tokens":2});
    assert_eq!(
        client
            .post(&usage_url)
            .bearer_auth(&agent.owner_token)
            .json(&usage)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for _ in 0..2 {
        let result: Value = client
            .post(&usage_url)
            .bearer_auth("admin-test")
            .json(&usage)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["estimated"], true);
        assert_eq!(result["reservation"]["charged"], 14);
    }
    for url in [format!("{usage_url}/usage"), format!("{price_url}/v1")] {
        assert_eq!(
            client
                .get(&url)
                .bearer_auth(&agent.owner_token)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        client
            .get(&url)
            .bearer_auth("admin-test")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    assert_eq!(s.hub.store.budget("team").unwrap()["estimated_charged"], 14);
}

#[tokio::test]
async fn remote_worker_operations_remain_on_home_hub_and_reject_foreign_controls() {
    let home = server("relay-home", vec![peer("relay-worker", None)]).await;
    let remote = server(
        "relay-worker",
        vec![peer("relay-home", Some(home.url.clone()))],
    )
    .await;
    let owner = register(&home, "owner").await;
    let worker = register(&remote, "worker").await;
    let stranger = register(&remote, "stranger").await;
    let client = reqwest::Client::new();
    let response=client.post(format!("{}/api/v1/messaging/operations",home.url)).bearer_auth(&owner.owner_token).json(&json!({"owner_session":"owner","request_key":"remote-operation","worker":{"node_id":"relay-worker","session_id":"worker"}})).send().await.unwrap();
    assert!(response.status().is_success());
    let op: operations::Operation = response.json().await.unwrap();
    let path = format!("{}/api/v1/messaging/operation-relay/relay-home", remote.url);
    let read = json!({"operation_id":op.id,"worker_session":"worker","command":null});
    assert_eq!(
        client
            .post(&path)
            .bearer_auth(&stranger.owner_token)
            .json(&read)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let response = client
        .post(&path)
        .bearer_auth(&worker.owner_token)
        .json(&read)
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "{}",
        response.text().await.unwrap()
    );
    assert!(remote.hub.store.operation(&op.id).unwrap().is_none());
    let command = |revision, action: Value| json!({"operation_id":op.id,"worker_session":"worker","command":{"attempt":1,"epoch":1,"expected_revision":revision,"action":action}});
    let result = client
        .post(&path)
        .bearer_auth(&worker.owner_token)
        .json(&command(1, json!({"kind":"claim","lease_ms":60000})))
        .send()
        .await
        .unwrap();
    assert!(result.status().is_success());
    let active: operations::Outcome = result.json().await.unwrap();
    assert!(active.applied);
    assert_eq!(
        home.hub.store.operation(&op.id).unwrap().unwrap().state,
        operations::State::Active
    );
    // Worker cannot smuggle cancellation/stop attestation or act as another worker.
    assert_eq!(
        client
            .post(&path)
            .bearer_auth(&worker.owner_token)
            .json(&command(
                active.operation.revision,
                json!({"kind":"cancel"})
            ))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let foreign = json!({"operation_id":op.id,"worker_session":"stranger","command":null});
    assert_eq!(
        client
            .post(&path)
            .bearer_auth(&stranger.owner_token)
            .json(&foreign)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert!(home
        .hub
        .receive_operation(
            "another-node",
            operation_relay::Request {
                operation_id: op.id.clone(),
                worker_session: "worker".into(),
                command: None,
                accounting: None
            }
        )
        .is_err());
    let cancelled = home
        .hub
        .store
        .command_operation(
            &op.id,
            operations::Command {
                selection_ack: None,
                attempt: 1,
                epoch: 1,
                expected_revision: active.operation.revision,
                action: operations::Action::Cancel,
            },
            now(),
        )
        .unwrap();
    assert_eq!(cancelled.operation.state, operations::State::Cancelling);
    let result = client
        .post(&path)
        .bearer_auth(&worker.owner_token)
        .json(&command(
            active.operation.revision,
            json!({"kind":"report","report_id":"late-remote","content":"late result"}),
        ))
        .send()
        .await
        .unwrap();
    let late: operations::Outcome = result.json().await.unwrap();
    assert!(!late.applied);
    assert_eq!(late.operation.state, operations::State::Cancelling);
    assert!(remote.hub.store.operation(&op.id).unwrap().is_none());
    assert!(remote.hub.operation_pending.lock().is_empty());
}

#[tokio::test]
async fn operation_relay_does_not_resend_commands_on_reconnect_or_emit_to_old_peers() {
    let host = server("relay-fixture", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "request".into(),
        operation_relay::Pending {
            node: "peer".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: None,
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "foreign", true, false, false, false, false, false, false, false, false, false, false,
            false, false, false, false, false, false, false,
        )
        .is_empty());
    assert_eq!(
        host.hub
            .operation_frames(
                "peer", true, false, false, false, false, false, false, false, false, false, false,
                false, false, false, false, false, false, false,
        )
            .len(),
        1
    );
    assert!(
        host.hub
            .operation_frames(
                "peer", true, false, false, false, false, false, false, false, false, false, false,
                false, false, false, false, false, false, false,
        )
            .is_empty(),
        "new link must not replay an uncertain command"
    );
    assert!(host
        .hub
        .operation_frames(
            "peer", false, false, false, false, false, false, false, false, false, false, false,
            false, false, false, false, false, false, false,
        )
        .is_empty());
    host.hub.operation_pending.lock().remove("request");
    assert!(receive.await.is_err());
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "old-request".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: None,
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", false, false, false, false, false, false, false, false, false, false, false,
            false, false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_leases_v1"));
    assert!(host.hub.operation_pending.lock().is_empty());
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "accounting".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::Context,
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, false, false, false, false, false, false, false, false, false, false,
            false, false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_accounting_v1"));
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "resource".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: Some(operations::Command {
                    selection_ack: None,
                    attempt: 1,
                    epoch: 1,
                    expected_revision: 1,
                    action: operations::Action::ClaimResource {
                        lease_ms: 1000,
                        resource: resource_admission::Acknowledgement {
                            profile: "worker".into(),
                            account_epoch: 1,
                            binding_revision: 1,
                        },
                    },
                }),
                accounting: None,
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, false, false, false, false, false, false, false, false, false,
            false, false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_resources_v1"));
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "quota".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::ResourceContext,
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, false, false, false, false, false, false, false, false, false,
            false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_quota_v1"));
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "monetary".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::MonetaryContext,
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, false, false, false, false,
            false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_monetary_quota_v1"));
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "official".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::OfficialRead {
                        call_id: "call".into(),
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, false, false, false, false, false, false, false, false,
            false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_official_calls_v1"));
    let (send, receive) = tokio::sync::oneshot::channel();
    let evidence = tool_evidence::Evidence {
        io: None,
        call_id: "call".into(),
        tool: "read".into(),
        operation_id: "operation".into(),
        worker_session: "worker".into(),
        attempt: 1,
        epoch: 1,
        status: tool_evidence::Outcome::Returned,
        started_at: 1,
        ended_at: 2,
    };
    host.hub.operation_pending.lock().insert(
        "tools".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::ToolEvidence { evidence },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, false, false, false, false, false, false, false,
            false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_tool_evidence_v1"));
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "grant".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::GrantContext,
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, false, false, false, false, false, false,
            false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_grants_v1"));
    let (send, receive) = tokio::sync::oneshot::channel();
    let evidence:artifact_evidence::Evidence=serde_json::from_value(serde_json::json!({"id":"artifact","operation_id":"operation","attempt":1,"epoch":1,"payload":{"kind":"artifact","snapshot":{"repository_id":"fixture","base_revision":"base","tree_hash":"a".repeat(64),"patch_hash":"b".repeat(64),"artifact_hashes":{}}}})).unwrap();
    host.hub.operation_pending.lock().insert(
        "artifact".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::ArtifactEvidence { evidence },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, false, false, false,
            false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_artifact_evidence_v1"));
}

#[tokio::test]
async fn selection_evidence_requires_its_own_negotiated_capability() {
    let host = server("selection-relay", vec![]).await;
    let evidence: selection_evidence::Evidence = serde_json::from_value(serde_json::json!({
        "record_id":"record", "operation_id":"operation", "worker_session":"worker", "attempt":1, "epoch":1,
        "profile_revision":"revision", "thread_id":"thread", "turn_id":"turn", "input_ids":["input"],
        "scope":"executor_configuration", "observed_at":1, "rejected":false,
        "model":{"requested":null,"observed":null,"status":"unverifiable","source":null},
        "effort":{"requested":null,"observed":null,"status":"unverifiable","source":null}
    })).unwrap();
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "selection".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::SelectionEvidence { evidence },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, false, false, false, false, false,
            false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_selection_evidence_v1"));
}

#[tokio::test]
async fn strict_selection_ack_is_not_sent_without_selection_capability() {
    let host = server("selection-ack", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    let policy = selection_evidence::Policy {
        profile_revision: "revision".into(),
        model: "chosen".into(),
        effort: None,
        scope: selection_evidence::Scope::ExecutorConfiguration,
    };
    host.hub.operation_pending.lock().insert(
        "ack".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                accounting: None,
                command: Some(operations::Command {
                    selection_ack: Some(policy),
                    attempt: 1,
                    epoch: 1,
                    expected_revision: 1,
                    action: operations::Action::Claim { lease_ms: 1000 },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, false, false, false, false, false,
            false, false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_selection_evidence_v1"));
}

#[tokio::test]
async fn assignment_context_is_not_sent_without_explicit_peer_capability() {
    let host = server("assignment-context", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "context".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::AssignmentContext {
                        assignment_id: "assignment".into(),
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, true, false, false, false,
            false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_assignment_context_v1"));
}

#[tokio::test]
async fn assignment_creation_requires_its_own_capability_not_just_context_reads() {
    let host = server("assignment-creation", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "creation".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::AssignmentCreation {
                        assignment_id: "assignment".into(),
                        receipt: assignment_dispatch::Receipt {
                            request_id: "receipt".into(),
                            command: json!({}),
                            state: assignment_dispatch::CreationState::Uncertain,
                        },
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, true, true, false, false,
            false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_assignment_creation_v1"));
}

#[tokio::test]
async fn assignment_admission_requires_its_own_negotiated_capability() {
    let host = server("assignment-admission", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    let admission = serde_json::from_value(json!({"request_id":"admit","expected_revision":1,"worker_session":"worker","profile_revision":"rev","provider":"fixture","model":"model","effort":null,"tools":[],"root":"/fixture"})).unwrap();
    host.hub.operation_pending.lock().insert(
        "admission".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::AssignmentAdmission {
                        assignment_id: "assignment".into(),
                        admission,
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, true, true, true, false,
            false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_assignment_admission_v1"));
}

#[tokio::test]
async fn assignment_stop_requires_its_own_negotiated_capability() {
    let host = server("assignment-stop", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    let receipt = serde_json::from_value(
        json!({"request_id":"stop","command":{},"kind":"official_remote_drained"}),
    )
    .unwrap();
    host.hub.operation_pending.lock().insert(
        "stop".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::AssignmentStop {
                        assignment_id: "assignment".into(),
                        receipt,
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, true, true, true, true,
            false, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_assignment_stop_v1"));
}

#[tokio::test]
async fn assignment_run_requires_its_own_negotiated_capability() {
    let host = server("assignment-run", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "run".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::AssignmentRunContext {
                        assignment_id: "assignment".into(),
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, true, true, true, true,
            true, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_assignment_run_context_v1"));
}

#[tokio::test]
async fn assignment_clarification_requires_its_own_negotiated_capability() {
    let host = server("assignment-question", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "run".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::AssignmentClarificationRead {
                        assignment_id: "assignment".into(),
                        request_id: "question".into(),
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, true, true, true, true,
            true, false, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_assignment_clarification_v1"));
}

#[tokio::test]
async fn artifact_archive_requires_its_own_negotiated_capability() {
    let host = server("artifact-archive", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "archive".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::ArtifactArchiveComplete {
                        sequence: 1,
                        identity: super::artifact_archive::Identity {
                            archive_hash: "a".repeat(64),
                            bytes: 1,
                        },
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, true, true, true, true,
            true, true, false, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_artifact_archive_v1"));
}

#[tokio::test]
async fn assignment_outputs_requires_its_own_negotiated_capability() {
    let host = server("assignment-outputs", vec![]).await;
    let (send, receive) = tokio::sync::oneshot::channel();
    host.hub.operation_pending.lock().insert(
        "outputs".into(),
        operation_relay::Pending {
            node: "old".into(),
            request: operation_relay::Request {
                operation_id: "operation".into(),
                worker_session: "worker".into(),
                command: None,
                accounting: Some(accounting_relay::Accounting {
                    attempt: 1,
                    action: accounting_relay::Action::AssignmentOutputs {
                        assignment_id: "assignment".into(),
                        declaration: super::assignment_outputs::Declare {
                            request_id: "outputs".into(),
                            command: json!({}),
                            outputs: std::collections::BTreeMap::new(),
                        },
                    },
                }),
            },
            sent: false,
            result: send,
        },
    );
    assert!(host
        .hub
        .operation_frames(
            "old", true, true, true, true, true, true, true, true, true, true, true, true, true,
            true, true, true, false, false,
        )
        .is_empty());
    assert!(receive
        .await
        .unwrap()
        .unwrap_err()
        .contains("operation_assignment_outputs_v1"));
}

#[tokio::test]
async fn verification_segments_replay_without_archiving_unvalidated_records() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    let host = server("verification-segments", vec![]).await;
    let store = &host.hub.store;
    {
        let db = store.db.lock();
        let worker = json!({"node_id":"remote","session_id":"worker"});
        let assignment =
            json!({"worker":worker,"dispatch":{"command":{"operation":{"attempt":1}}}});
        db.execute(
            "INSERT INTO work_assignments VALUES ('a','r','s',1,'t','op','prepared',?1)",
            [assignment.to_string()],
        )
        .unwrap();
        let event = json!({"kind":"artifact_evidence","producer":worker,"evidence":{"attempt":1,"payload":{"kind":"verification"}}});
        db.execute(
            "INSERT INTO operation_events(seq,operation_id,body) VALUES (1,'op',?1)",
            [event.to_string()],
        )
        .unwrap();
    }
    let raw = vec![b'x'; 40000];
    let hash = format!("{:x}", Sha256::digest(&raw));
    let segment = |offset: usize| super::verification_record::Segment {
        record_hash: hash.clone(),
        bytes: raw.len(),
        offset,
        data: STANDARD.encode(&raw[offset..(offset + 32768).min(raw.len())]),
    };
    assert!(store
        .remote_verification_segment("op", 1, 1, segment(32768))
        .is_err());
    assert!(store
        .remote_verification_segment("foreign", 1, 1, segment(0))
        .is_err());
    assert!(store
        .remote_verification_segment("op", 2, 1, segment(0))
        .is_err());
    let receipt = store
        .remote_verification_segment("op", 1, 1, segment(0))
        .unwrap();
    assert_eq!(
        receipt,
        store
            .remote_verification_segment("op", 1, 1, segment(0))
            .unwrap()
    );
    assert!(store
        .complete_remote_verification("op", 1, 1, &hash)
        .is_err());
    let mut conflict = segment(0);
    conflict.data = STANDARD.encode(vec![b'y'; 32768]);
    assert!(store
        .remote_verification_segment("op", 1, 1, conflict)
        .is_err());
    store
        .remote_verification_segment("op", 1, 1, segment(32768))
        .unwrap();
    assert_eq!(
        receipt,
        store
            .remote_verification_segment("op", 1, 1, segment(0))
            .unwrap()
    );
    // Complete bytes and a valid hash cannot replace the frozen observation validator.
    assert!(store
        .complete_remote_verification("op", 1, 1, &hash)
        .is_err());
    assert!(store.verification_record(1).is_err());
}

fn task_workspace_prepare_request(receipt: &super::assignment_task_workspace::Receipt) -> super::assignment_task_prepare::Prepare {
    let mut input = serde_json::to_value(receipt).unwrap();
    input.as_object_mut().unwrap().remove("starting_snapshot");
    serde_json::from_value(input).unwrap()
}

fn raw_task_workspace_fixture(
    store: &super::store::Store,
    assignment_id: &str,
    run_id: &str,
    operation_id: &str,
    stage_attempt: u64,
) -> super::assignment_task_workspace::Receipt {
    use rusqlite::OptionalExtension;
    use sha2::{Digest, Sha256};

    let repository_binding = "repo-binding";
    let operation = json!({ "id": operation_id, "attempt": 1, "epoch": 1 });
    let context_hash = "context-hash";
    let authorization_hash = "a".repeat(64);
    let input_hash = "b".repeat(64);
    let db = store.db.lock();

    let grant_policy = json!({
        "id":"grant", "team_id":"team", "enabled":true, "expires_at":i64::MAX as u64,
        "targets":[{"host":"home","workspace":"repo","root":"/repo"}],
        "capabilities":["workspace_write"], "tools":["write_file"], "network":false, "budget_ids":[]
    });
    let grant = json!({"revision":1,"policy":grant_policy,"grantor":"test","recorded_at":1});
    let grant_key = format!("team-grant:{}", serde_json::to_string(&("grant", None::<u64>)).unwrap());
    db.execute("INSERT OR IGNORE INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        rusqlite::params![grant_key, grant.to_string()]).unwrap();
    let activation_key = format!("team-activation:{}", serde_json::to_string(&("team", "current")).unwrap());
    let activation = json!({"active":true,"team_revision":1,"snapshot_hash":authorization_hash,
        "snapshot":{"grant":{"revision":1,"policy":{"id":"grant"}}}});
    db.execute("INSERT OR IGNORE INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        rusqlite::params![activation_key, activation.to_string()]).unwrap();

    let pack = json!({
        "id":"fixture-workflow", "version":"1", "inputs":["request"], "completion_stages":["implement"],
        "stages":[{"id":"implement","role":"implement","requires":["request"],"produces":["artifact"],
            "independent_from":[],"on_reject":null,"execution":{"repository_binding":repository_binding,
                "capabilities":["workspace_write"],"tools":["write_file"],"network":false}}],
        "evidence_rules":{}
    });
    let mut run = if let Some(body) = db.query_row("SELECT body FROM work_runs WHERE id=?1", [run_id], |row| row.get::<_, String>(0)).optional().unwrap() {
        serde_json::from_str::<Value>(&body).unwrap()
    } else {
        json!({
            "id":run_id,"home_hub":"home","team_id":"team","team_revision":1,"request_id":format!("request-{run_id}"),
            "request":{},"revision":1,"state":"waiting_resource","context_hash":context_hash,
            "authorization":{"snapshot_hash":authorization_hash},
            "context":{"binding":{"workflow":{"pack":pack}}},"stages":[],"task_workspaces":null
        })
    };
    run["stages"].as_array_mut().unwrap().push(json!({"stage_id":"implement","assignment_id":assignment_id,"attempt":stage_attempt}));
    let run_body = run.to_string();
    if db.query_row("SELECT 1 FROM work_runs WHERE id=?1", [run_id], |_| Ok(())).optional().unwrap().is_some() {
        db.execute("UPDATE work_runs SET revision=?2,state='waiting_resource',body=?3 WHERE id=?1",
            rusqlite::params![run_id, run["revision"].as_u64().unwrap(), run_body]).unwrap();
    } else {
        db.execute("INSERT INTO work_runs(id,team_id,request_id,request,revision,state,body,initial_body) VALUES (?1,'team',?2,'{}',1,'waiting_resource',?3,?3)",
            rusqlite::params![run_id, format!("request-{run_id}"), run_body]).unwrap();
    }

    let operation_row = json!({
        "id":operation_id,"owner":"owner","worker":{"node_id":"home","session_id":"worker"},
        "request_key":operation_id,"budget_required":false,"grant_required":false,"resource_required":false,
        "attempt":1,"epoch":1,"revision":1,"state":"prepared","lease_until":null
    });
    db.execute("INSERT INTO operations(id,owner,request_key,state,lease_until,body) VALUES (?1,'owner',?1,'prepared',NULL,?2)",
        rusqlite::params![operation_id, operation_row.to_string()]).unwrap();
    let grant_scope = json!({"target":{"host":"home","workspace":"repo","root":"/repo"},
        "capabilities":["workspace_write"],"tools":["write_file"],"network":false,"budget_ids":[]});
    let assignment = json!({
        "id":assignment_id,"run_id":run_id,"stage_id":"implement","stage_attempt":stage_attempt,"team_id":"team",
        "revision":1,"state":"prepared","context_hash":context_hash,"authorization_hash":authorization_hash,
        "inputs":{"hash":input_hash,"binding":{"sources":{}}},"task_workspace_input":{"basis":"git_base"},"worker":{"node_id":"home","session_id":"worker"},
        "candidate":{"grant_scope":grant_scope},
        "bundle":{"operation":{"id":operation_id,"attempt":1,"epoch":1,"revision":1}},
        "dispatch":{"state":"blocked","command":{"cwd":"/repo","operation":operation}},
        "resources":null,"creation":null,"admission":null,"execution_workspace":null,"task_workspace":null
    });
    db.execute("INSERT INTO work_assignments(id,run_id,stage_id,stage_attempt,team_id,operation_id,state,body) VALUES (?1,?2,'implement',?3,'team',?4,'prepared',?5)",
        rusqlite::params![assignment_id, run_id, stage_attempt, operation_id, assignment.to_string()]).unwrap();

    let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&json!(["home",run_id,repository_binding,"home"])).unwrap()));
    let run_root = format!("/task-worktrees/{run_id}");
    drop(db);
    super::assignment_task_workspace::Receipt {
        request_id: format!("receipt-{assignment_id}"), expected_revision: 1, input_hash: input_hash.to_string(),
        context_hash: context_hash.to_string(), authorization_hash, stage_attempt, operation,
        repository_binding: repository_binding.to_string(), starting_snapshot: json!({"basis":"git_base","snapshot_hash":"d".repeat(64)}),
        workspace: super::assignment_task_workspace::Workspace {
            key: key.clone(), repository: "/repo".into(), common_dir: "/repo/.git".into(),
            root: run_root, branch: format!("kode/task-{key}"), base_commit: "c".repeat(40),
        },
    }
}
fn insert_task_workspace_fixture(store: &super::store::Store, assignment_id: &str, run_id: &str,
    operation_id: &str, stage_attempt: u64) -> super::assignment_task_workspace::Receipt {
    let mut receipt = raw_task_workspace_fixture(store, assignment_id, run_id, operation_id, stage_attempt);
    let planned = store.prepare_assignment_task_workspace(assignment_id, task_workspace_prepare_request(&receipt)).unwrap();
    receipt.expected_revision = planned["assignment_revision"].as_u64().unwrap();
    receipt
}

#[tokio::test]
async fn task_worktree_prepare_is_live_idempotent_authority_before_execution_scope() {
    let host = server("home", vec![]).await;
    let store = &host.hub.store;
    let mut final_input = raw_task_workspace_fixture(store, "assignment-a", "run-a", "operation-a", 1);
    assert!(store.assignment_task_workspace("assignment-a", final_input.clone()).is_err(), "final scope cannot skip preflight");
    let input = task_workspace_prepare_request(&final_input);
    assert!(store.prepare_assignment_task_workspace_from("foreign", "assignment-a", input.clone()).is_err());
    let result = store.prepare_assignment_task_workspace("assignment-a", input.clone()).unwrap();
    assert_eq!(result["provision_authorized"], true);
    assert_eq!(result["scope_authorized"], false);
    assert_eq!(result["execution_authorized"], false);
    let after = store.work_assignment("assignment-a").unwrap().unwrap();
    assert_eq!(after["dispatch"]["command"]["cwd"], "/repo");
    assert!(after["resources"].is_null() && after["execution_workspace"].is_null());
    assert_eq!(store.prepare_assignment_task_workspace("assignment-a", input.clone()).unwrap(), result);
    assert_eq!(store.work_assignment("assignment-a").unwrap().unwrap(), after, "replay must not advance revisions");
    let mut conflict = input; conflict.workspace.base_commit = "e".repeat(40);
    assert!(store.prepare_assignment_task_workspace("assignment-a", conflict).is_err());
    final_input.expected_revision = result["assignment_revision"].as_u64().unwrap();
    assert!(store.assignment_task_workspace("assignment-a", final_input).is_ok());
}

#[tokio::test]
async fn task_worktree_prepare_replay_rechecks_revoked_grant_and_stale_epoch() {
    let host = server("home", vec![]).await;
    let store = &host.hub.store;
    let mut final_input = raw_task_workspace_fixture(store, "assignment-a", "run-a", "operation-a", 1);
    let input = task_workspace_prepare_request(&final_input);
    let prepared = store.prepare_assignment_task_workspace("assignment-a", input.clone()).unwrap();
    final_input.expected_revision = prepared["assignment_revision"].as_u64().unwrap();
    store.db.lock().execute("UPDATE workbench_documents SET value=json_set(value,'$.policy.enabled',json('false')) WHERE key LIKE 'team-grant:%'", []).unwrap();
    assert!(store.prepare_assignment_task_workspace("assignment-a", input).is_err());
    assert!(store.assignment_task_workspace("assignment-a", final_input).is_err());
    assert!(store.work_assignment("assignment-a").unwrap().unwrap()["execution_workspace"].is_null());
    store.db.lock().execute("UPDATE workbench_documents SET value=json_set(value,'$.policy.enabled',json('true')) WHERE key LIKE 'team-grant:%'", []).unwrap();
    let saved_prepare = store.work_assignment("assignment-a").unwrap().unwrap()["task_workspace_prepare"]["request"].clone();
    store.db.lock().execute("UPDATE operations SET body=json_set(body,'$.epoch',2) WHERE id='operation-a'", []).unwrap();
    assert!(store.prepare_assignment_task_workspace("assignment-a", serde_json::from_value(saved_prepare).unwrap()).is_err(), "an already prepared receipt cannot survive an epoch change");
    let stale = raw_task_workspace_fixture(store, "assignment-b", "run-b", "operation-b", 1);
    store.db.lock().execute("UPDATE operations SET body=json_set(body,'$.epoch',2) WHERE id='operation-b'", []).unwrap();
    assert!(store.prepare_assignment_task_workspace("assignment-b", task_workspace_prepare_request(&stale)).is_err());
    assert!(store.work_assignment("assignment-b").unwrap().unwrap()["task_workspace_prepare"].is_null());
}

#[tokio::test]
async fn task_worktree_prepare_rejects_cross_run_planned_roots_before_scope_exists() {
    let host = server("home", vec![]).await;
    let store = &host.hub.store;
    let first = raw_task_workspace_fixture(store, "assignment-a", "run-a", "operation-a", 1);
    store.prepare_assignment_task_workspace("assignment-a", task_workspace_prepare_request(&first)).unwrap();
    let second = raw_task_workspace_fixture(store, "assignment-b", "run-b", "operation-b", 1);
    let mut cross = task_workspace_prepare_request(&second); cross.workspace.root = first.workspace.root;
    assert!(store.prepare_assignment_task_workspace("assignment-b", cross).is_err());
    let mut unisolated = task_workspace_prepare_request(&second); unisolated.workspace.root = "/repo/nested".into();
    assert!(store.prepare_assignment_task_workspace("assignment-b", unisolated).is_err());
    assert!(store.work_assignment("assignment-b").unwrap().unwrap()["task_workspace_prepare"].is_null());
    assert!(store.work_run("run-b").unwrap().unwrap()["task_workspaces"].is_null());
}

#[tokio::test]
async fn task_worktree_receipt_is_home_bound_idempotent_and_does_not_expand_grant() {
    let host = server("home", vec![]).await;
    let store = &host.hub.store;
    let receipt = insert_task_workspace_fixture(store, "assignment-a", "run-a", "operation-a", 1);
    let unscoped = store.work_assignment("assignment-a").unwrap().unwrap();
    assert!(super::assignment_task_workspace::assert_bound(&unscoped).is_err(),
        "a writable assignment cannot reserve resources or enter admission on the grant root");
    let result = store.assignment_task_workspace("assignment-a", receipt.clone()).unwrap();
    assert_eq!(result["kind"], "derived_task_worktree");
    assert_eq!(result["root"], receipt.workspace.root);
    assert_eq!(result["scope_authorized"], true);
    assert_eq!(result["execution_authorized"], false);
    assert_eq!(result["authority_scope"]["target"]["root"], "/repo");
    assert_eq!(result["scope"]["target"]["root"], receipt.workspace.root);
    assert_eq!(result["scope"]["target"]["workspace"], format!("task-{}", receipt.workspace.key));
    assert_eq!(result["scope"]["capabilities"], json!(["workspace_write"]));
    assert_eq!(result["scope"]["tools"], json!(["write_file"]));
    assert_eq!(result["scope"]["network"], false);
    assert_eq!(store.assignment_task_workspace("assignment-a", receipt.clone()).unwrap(), result);
    let mut conflict = receipt.clone(); conflict.request_id = "different-receipt".into();
    assert!(store.assignment_task_workspace("assignment-a", conflict).is_err());
    assert!(store.assignment_task_workspace_from("remote", "assignment-a", receipt).is_err());
    let assignment = store.work_assignment("assignment-a").unwrap().unwrap();
    assert_eq!(assignment["execution_workspace"]["receipt"], result);
    assert_eq!(assignment["task_workspace"]["receipt"], result);
    assert_eq!(assignment["dispatch"]["command"]["cwd"], result["root"]);
    let fixed = store.work_run("run-a").unwrap().unwrap()["task_workspaces"]["repo-binding"].clone();
    assert_eq!(fixed["key"], result["key"]);
    assert_eq!(fixed["root"], result["root"]);
    assert_eq!(fixed["run_id"], "run-a");
    assert!(fixed.get("scope").is_none(), "Run identity must not become an execution grant");
}

#[tokio::test]
async fn task_worktree_identity_is_stable_for_run_rework_and_roots_cannot_cross_runs() {
    let host = server("home", vec![]).await;
    let store = &host.hub.store;
    let first = insert_task_workspace_fixture(store, "assignment-a", "run-a", "operation-a", 1);
    let first_result = store.assignment_task_workspace("assignment-a", first.clone()).unwrap();
    let fixed = store.work_run("run-a").unwrap().unwrap()["task_workspaces"]["repo-binding"].clone();

    let rework = insert_task_workspace_fixture(store, "assignment-rework", "run-a", "operation-rework", 2);
    let rework_result = store.assignment_task_workspace("assignment-rework", rework).unwrap();
    assert_eq!(rework_result["key"], first_result["key"]);
    assert_eq!(rework_result["root"], first_result["root"]);
    assert_eq!(store.work_run("run-a").unwrap().unwrap()["task_workspaces"]["repo-binding"], fixed);

    let mut other_run = insert_task_workspace_fixture(store, "assignment-b", "run-b", "operation-b", 1);
    other_run.workspace.root = first_result["root"].as_str().unwrap().to_string();
    assert!(store.assignment_task_workspace("assignment-b", other_run).is_err());
    assert!(store.work_assignment("assignment-b").unwrap().unwrap()["execution_workspace"].is_null());
}

#[tokio::test]
async fn task_worktree_receipt_rejects_stale_operation_epoch_and_unisolated_roots() {
    let host = server("home", vec![]).await;
    let store = &host.hub.store;
    let mut stale = insert_task_workspace_fixture(store, "assignment-stale", "run-stale", "operation-stale", 1);
    stale.operation["epoch"] = json!(2);
    assert!(store.assignment_task_workspace("assignment-stale", stale).is_err());

    let mut root = insert_task_workspace_fixture(store, "assignment-root", "run-root", "operation-root", 1);
    root.workspace.root = "/repo/task-write-through".into();
    assert!(store.assignment_task_workspace("assignment-root", root).is_err());

    let mut wrong_identity = insert_task_workspace_fixture(store, "assignment-identity", "run-identity", "operation-identity", 1);
    wrong_identity.workspace.key = "not-the-derived-key".into();
    assert!(store.assignment_task_workspace("assignment-identity", wrong_identity).is_err());
}

#[tokio::test]
async fn agent_hub_is_backend_owned_owner_only_and_shared_by_independent_clients(){
    let s=server("agent-hub",vec![]).await;let first=reqwest::Client::new();let second=reqwest::Client::new();
    let url=format!("{}/api/v1/messaging/workbench/agent-hub",s.url);
    assert_eq!(first.get(&url).send().await.unwrap().status(),401);
    let agent=register(&s,"extension-reader").await;
    assert_eq!(first.get(&url).bearer_auth(&agent.owner_token).send().await.unwrap().status(),403);
    assert_eq!(first.post(&url).bearer_auth(&agent.owner_token).json(&json!({"action":"power","enabled":true})).send().await.unwrap().status(),403);
    let source=s._root.path().join("fixtures");std::fs::create_dir_all(source.join("skills/example/references")).unwrap();
    std::fs::write(source.join("skills/example/SKILL.md"),"---\nname: example\ndescription: Fixture\n---\nTest").unwrap();
    std::fs::write(source.join("skills/example/references/guide.md"),"original").unwrap();
    let saved=first.post(&url).bearer_auth("admin-test").json(&json!({"action":"save-source","source":{"id":"team","kind":"local","location":source,"targets":["dsh","codex","claude","codebuddy","cursor"]}})).send().await.unwrap();assert!(saved.status().is_success(),"{}",saved.text().await.unwrap());
    let synced=second.post(&url).bearer_auth("admin-test").json(&json!({"action":"sync-source","id":"team"})).send().await.unwrap();assert!(synced.status().is_success(),"{}",synced.text().await.unwrap());
    let state:Value=first.get(&url).bearer_auth("admin-test").send().await.unwrap().json().await.unwrap();
    assert_eq!(state["sources"][0]["skills"],json!(["skills--example"]));
    for(_,target)in super::extension_files::TARGETS{
        assert_eq!(std::fs::read_to_string(s.hub.extensions.home.join(target).join("team--skills--example/references/guide.md")).unwrap(),"original");
    }
    let stored=s.hub.store.document("agent-hub").unwrap();assert!(stored["revision"].as_u64().unwrap()>=2);assert_eq!(stored["value"]["sources"][0]["id"],"team");
    std::fs::write(source.join("skills/example/references/guide.md"),"updated").unwrap();
    assert!(first.post(&url).bearer_auth("admin-test").json(&json!({"action":"sync-source","id":"team"})).send().await.unwrap().status().is_success());
    assert_eq!(std::fs::read_to_string(s.hub.extensions.home.join(".claude/skills/team--skills--example/references/guide.md")).unwrap(),"updated");
    assert!(second.post(&url).bearer_auth("admin-test").json(&json!({"action":"remove-source","id":"team"})).send().await.unwrap().status().is_success());
    assert!(!s.hub.extensions.home.join(".claude/skills/team--skills--example").exists());
}
#[tokio::test]
async fn backend_extension_preview_catalog_and_logo_are_safe_and_owner_only(){
    let s=server("extension-preview",vec![]).await;let client=reqwest::Client::new();
    let url=format!("{}/api/v1/messaging/workbench/agent-hub",s.url);let source=s._root.path().join("source");
    std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();std::fs::create_dir_all(source.join("skills/example")).unwrap();
    std::fs::create_dir_all(source.join("commands")).unwrap();std::fs::create_dir_all(source.join("assets")).unwrap();std::fs::create_dir_all(source.join("config")).unwrap();
    std::fs::create_dir_all(source.join("hooks")).unwrap();std::fs::create_dir_all(source.join("rules")).unwrap();std::fs::create_dir_all(source.join("agents")).unwrap();
    std::fs::write(source.join("plugin.meta.json"),r#"{"id":"fixture","displayName":"Fixture Toolkit","version":"1.2.3","description":"Fixture description","author":{"name":"fixture-team"},"category":"Engineering"}"#).unwrap();
    std::fs::write(source.join(".codex-plugin/plugin.json"),r#"{"name":"fixture","version":"1.2.3","mcpServers":"./config/servers.json","hooks":"./hooks/hooks.test.json","interface":{"displayName":"Fixture Toolkit","shortDescription":"Short fixture","longDescription":"Long fixture","logo":"./assets/logo.png"}}"#).unwrap();
    std::fs::write(source.join("skills/example/SKILL.md"),"---\nname: example-skill\ndescription: Example skill description\n---\nBody must not be published").unwrap();
    std::fs::write(source.join("commands/build.md"),"---\nname: build\ndescription: Build fixture\n---\nCommand body").unwrap();
    std::fs::write(source.join("agents/reviewer.md"),"---\nname: reviewer\ndescription: Reviews fixture changes\n---\nAgent body must not be published").unwrap();
    std::fs::write(source.join("commands/multiline.md"),"---\nname: multiline\ndescription: >-\n  First folded line\n  Second folded line\n---\nBody").unwrap();
    std::fs::write(source.join("config/servers.json"),r#"{"mcpServers":{"remote":{"type":"http","url":"https://example.test/?token=SECRET","headers":{"Authorization":"SECRET"}},"local":{"command":"SECRET"}}}"#).unwrap();
    std::fs::write(source.join("mcp.json"),r#"{"mcpServers":{"unreferenced":{"type":"http","url":"https://example.test"}}}"#).unwrap();
    std::fs::write(source.join("hooks/hooks.test.json"),r#"{"description":"Fixture hooks","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"SECRET"}]}],"SessionStart":[{"hooks":[]}]}}"#).unwrap();
    std::fs::write(source.join("rules/discipline.md"),"---\ndescription: Fixture rule\n---\nRule body must not be published").unwrap();
    std::fs::write(source.join("rules/discipline.mdc"),"---\ndescription: Duplicate cursor rule\n---\nDuplicate body").unwrap();
    let png=[0x89,b'P',b'N',b'G',0x0d,0x0a,0x1a,0x0a,1,2,3];std::fs::write(source.join("assets/logo.png"),png).unwrap();
    let saved=client.post(&url).bearer_auth("admin-test").json(&json!({"action":"save-source","source":{"id":"team","kind":"local","location":source,"targets":["dsh"]}})).send().await.unwrap();assert!(saved.status().is_success(),"{}",saved.text().await.unwrap());
    let synced=client.post(&url).bearer_auth("admin-test").json(&json!({"action":"sync-source","id":"team"})).send().await.unwrap();assert!(synced.status().is_success(),"{}",synced.text().await.unwrap());
    let state:Value=client.get(&url).bearer_auth("admin-test").send().await.unwrap().json().await.unwrap();let row=&state["sources"][0];let package=&row["packages"][0];
    assert_eq!(row["skills"],json!(["skills--example"]));assert_eq!(package["path"],".");assert_eq!(package["displayName"],"Fixture Toolkit");
    assert_eq!(package["description"],"Short fixture");assert_eq!(package["longDescription"],"Long fixture");assert_eq!(package["author"],"fixture-team");
    assert_eq!(package["skills"][0]["name"],"example-skill");assert_eq!(package["skills"][0]["description"],"Example skill description");
    assert_eq!(package["commands"][0]["name"],"build");assert_eq!(package["commands"][0]["description"],"Build fixture");
    assert_eq!(package["agents"],json!([{"name":"reviewer","description":"Reviews fixture changes"}]));
    assert_eq!(package["commands"][1]["name"],"multiline");assert_eq!(package["commands"][1]["description"],"First folded line Second folded line");
    assert_eq!(package["hooks"],json!([{"name":"PreToolUse","description":"Fixture hooks"},{"name":"SessionStart","description":"Fixture hooks"}]));
    assert_eq!(package["rules"],json!([{"name":"discipline","description":"Fixture rule"}]));
    assert_eq!(package["mcp"],json!([{"name":"local","type":"stdio"},{"name":"remote","type":"http"}]));
    let serialized=row.to_string();assert!(!serialized.contains("SECRET"));assert!(!serialized.contains("Body must not"));assert!(!serialized.contains("Command body"));assert!(!serialized.contains("Rule body"));assert!(!serialized.contains("Duplicate body"));assert!(!serialized.contains("Agent body"));
    let logo=format!("{url}?logo=team&package=0");assert_eq!(client.get(&logo).send().await.unwrap().status(),401);
    let agent=register(&s,"logo-reader").await;assert_eq!(client.get(&logo).bearer_auth(&agent.owner_token).send().await.unwrap().status(),403);
    assert_eq!(client.get(format!("{url}?logo=team&package=99")).bearer_auth("admin-test").send().await.unwrap().status(),404);
    let response=client.get(&logo).bearer_auth("admin-test").send().await.unwrap();assert_eq!(response.status(),200);
    assert_eq!(response.headers().get("content-type").unwrap(),"image/png");assert_eq!(response.bytes().await.unwrap().as_ref(),png);
}
#[tokio::test]
async fn backend_extension_conflicts_preserve_every_previous_target_and_foreign_files(){
    let s=server("extension-conflict",vec![]).await;let source=s._root.path().join("source");std::fs::create_dir_all(source.join("one")).unwrap();std::fs::write(source.join("one/SKILL.md"),"first").unwrap();
    let ext=&s.hub.extensions;ext.change(&s.hub,json!({"action":"save-source","source":{"id":"team","kind":"local","location":source}})).unwrap();ext.change(&s.hub,json!({"action":"sync-source","id":"team"})).unwrap();
    let path=ext.home.join(".agents/skills/team--one");let prior=std::fs::read_link(&path).unwrap();
    std::fs::create_dir_all(source.join("new")).unwrap();std::fs::write(source.join("new/SKILL.md"),"new").unwrap();
    let foreign=ext.home.join(".cursor/skills/team--new");std::fs::create_dir_all(&foreign).unwrap();
    assert!(ext.change(&s.hub,json!({"action":"sync-source","id":"team"})).unwrap_err().to_string().contains("同步冲突"));
    assert_eq!(std::fs::read_link(path).unwrap(),prior);assert!(!ext.home.join(".agents/skills/team--new").exists());assert!(foreign.is_dir());
    ext.change(&s.hub,json!({"action":"remove-source","id":"team"})).unwrap();assert!(foreign.is_dir());
}
#[tokio::test]
async fn backend_extension_launch_args_are_available_to_gui_and_match_native_target_manifests(){
    let s=server_with_config("native-plugins",vec![],fixture_agent_config(&["claude","codebuddy","cursor"])).await;let source=s._root.path().join("source");
    for target in ["claude","codebuddy","cursor"]{std::fs::create_dir_all(source.join(format!(".{target}-plugin"))).unwrap();std::fs::write(source.join(format!(".{target}-plugin/plugin.json")),r#"{"name":"fixture","version":"0.0.1"}"#).unwrap();}
    let ext=&s.hub.extensions;ext.change(&s.hub,json!({"action":"save-source","source":{"id":"native","kind":"local","location":source,"targets":["claude","codebuddy","cursor"]}})).unwrap();
    ext.change(&s.hub,json!({"action":"sync-source","id":"native"})).unwrap();
    let state=ext.view(&s.hub).unwrap();assert_eq!(state["sources"][0]["nativeStatus"]["claude"],"ready");
    for target in ["claude","codebuddy","cursor"]{let args=super::extensions::launch_args(&s.hub,target).unwrap();assert_eq!(args[0],"--plugin-dir");assert!(std::path::Path::new(&args[1]).join(format!(".{target}-plugin/plugin.json")).is_file());}
    let catalog=super::agents::catalog(&s.hub).unwrap();
    assert!(catalog.extension_args.values().any(|args|args.iter().any(|arg|arg=="--plugin-dir")),"GUI catalog must receive backend-owned native launch arguments");
    for(key,args)in &catalog.extension_args{if !args.is_empty(){assert!(super::agents::resolve(&catalog,key,None).unwrap().args.contains(&"--plugin-dir".into()));assert!(!catalog.backends[key].args.contains(&"--plugin-dir".into()),"managed arguments must not pollute editable launch configuration");}}
}
#[tokio::test]
async fn backend_extension_validation_rejects_escaping_paths_and_links(){
    let s=server("extension-paths",vec![]).await;let ext=&s.hub.extensions;
    for source in [json!({"id":"../escape","kind":"local","location":"/srv/fixtures"}),json!({"id":"valid","kind":"git","location":"--upload-pack=fixture"}),json!({"id":"valid","kind":"local","location":"/srv/fixtures","subdir":"../escape"}),json!({"id":"valid","kind":"local","location":"/srv/fixtures","targets":["unknown"]})]{assert!(ext.change(&s.hub,json!({"action":"save-source","source":source})).is_err());}
    #[cfg(unix)]{
        let source=s._root.path().join("source");std::fs::create_dir_all(source.join("skill")).unwrap();std::fs::write(source.join("skill/SKILL.md"),"fixture").unwrap();
        let outside=s._root.path().join("outside");std::fs::write(&outside,"outside").unwrap();std::os::unix::fs::symlink(outside,source.join("skill/reference")).unwrap();
        ext.change(&s.hub,json!({"action":"save-source","source":{"id":"escape","kind":"local","location":source}})).unwrap();assert!(ext.change(&s.hub,json!({"action":"sync-source","id":"escape"})).unwrap_err().to_string().contains("超出包目录"));
    }
}
#[tokio::test]
async fn backend_handoff_routes_between_runtimes_and_retries_without_duplicate_work(){
    backend_handoff_case("gui","dsh").await;
    backend_handoff_case("dsh","gui").await;
}
async fn backend_handoff_case(source_runtime:&str,target_runtime:&str){
    let s=server_with_config("handoff-test",vec![],fixture_agent_config(&["codex"])).await;let client=reqwest::Client::new();let ctx=s._ctx.clone();
    let publication=|runtime:&str,sid:&str,events:Vec<Value>|serde_json::from_value::<crate::runtime::Publication>(json!({"runtime":runtime,"boot_id":format!("{runtime}-boot"),"sessions":[{"session_id":sid,"dto":{"title":"Fixture conversation","cwd":s._root.path(),"status":"idle"},"events":events}]})).unwrap();
    ctx.runtimes.publish(&ctx,publication(source_runtime,"original",vec![json!({"key":"one","kind":"message","payload":{"id":"u1","role":"user","text":"Do the fixture task","source_kind":"user"}}),json!({"key":"two","kind":"message","payload":{"id":"a1","role":"assistant","text":"Prior answer","content":[{"type":"reasoning","text":"HIDDEN REASONING"}]}}),json!({"key":"three","kind":"message","payload":{"id":"p1","role":"user","text":"PRIVATE PEER","source_kind":"agent-message"}})])).unwrap();
    ctx.runtimes.publish(&ctx,publication(target_runtime,"existing",vec![])).unwrap();
    let registry=s.hub.store.document("agents").unwrap();let profile=registry["value"]["profiles"].as_array().unwrap().iter().find(|profile|profile["type"]=="codex").unwrap();
    let input=json!({"source_session_id":"original","source_runtime":source_runtime,"profile_id":profile["id"],"target_runtime":target_runtime,"request_id":"fixture-request"});let url=format!("{}/api/v1/messaging/workbench/handoff",s.url);
    assert_eq!(client.post(&url).json(&input).send().await.unwrap().status(),401);
    let agent=register(&s,"handoff-agent").await;assert_eq!(client.post(&url).bearer_auth(&agent.owner_token).json(&input).send().await.unwrap().status(),403);
    let request={let client=client.clone();let url=url.clone();let input=input.clone();tokio::spawn(async move{client.post(url).bearer_auth("admin-test").json(&input).send().await.unwrap()})};
    let mut operations=vec![];
    tokio::time::timeout(std::time::Duration::from_secs(5),async{
        while operations.len()<2{
            let claimed=ctx.runtimes.claim(target_runtime,&format!("{target_runtime}-boot")).unwrap();
            for command in claimed["commands"].as_array().unwrap(){
                let kind=command["kind"].as_str().unwrap();operations.push(kind.to_string());
                let value=if kind=="create_session"{
                    assert_eq!(command["payload"]["cwd"],json!(s._root.path()));assert!(command["payload"]["backend_key"].as_str().unwrap().starts_with(&format!("{target_runtime}:")));
                    let mapped=ctx.runtimes.publish(&ctx,publication(target_runtime,"target",vec![])).unwrap();let id=mapped["sessions"][0]["id"].as_u64().unwrap();json!({"id":id,"runtime_session_id":"target"})
                }else{
                    assert_eq!(kind,"input");let text=command["payload"]["text"].as_str().unwrap();assert!(text.contains("Do the fixture task")&&text.contains("Prior answer"));assert!(!text.contains("PRIVATE PEER")&&!text.contains("HIDDEN REASONING"));json!({"accepted":true})
                };
                ctx.runtimes.settle(target_runtime,&format!("{target_runtime}-boot"),command["id"].as_str().unwrap(),json!({"value":value})).unwrap();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    let response=request.await.unwrap();assert!(response.status().is_success(),"{}",response.text().await.unwrap());let result:Value=response.json().await.unwrap();assert_eq!(result["sessionId"],"target");
    let repeated:Value=client.post(&url).bearer_auth("admin-test").json(&input).send().await.unwrap().json().await.unwrap();assert_eq!(result,repeated);
    assert!(ctx.runtimes.claim(target_runtime,&format!("{target_runtime}-boot")).unwrap()["commands"].as_array().unwrap().is_empty());
    let mut conflict=input.clone();conflict["source_session_id"]=json!("different");assert_eq!(client.post(&url).bearer_auth("admin-test").json(&conflict).send().await.unwrap().status(),400);
    let record=s.hub.store.document("agent-handoffs").unwrap();assert!(record["value"]["fixture-request"]["task"].is_null());assert_eq!(record["value"]["fixture-request"]["result"],result);
}
#[test]
#[cfg(unix)]
fn backend_extension_commit_failure_restores_updated_and_pruned_links(){
    let root=tempfile::tempdir().unwrap();let old=root.path().join("old");let new=root.path().join("new");std::fs::create_dir(&old).unwrap();std::fs::create_dir(&new).unwrap();
    let one=root.path().join("one");let two=root.path().join("two");std::os::unix::fs::symlink(&old,&one).unwrap();std::os::unix::fs::symlink(&old,&two).unwrap();
    let previous=vec![json!({"path":one,"to":old}),json!({"path":two,"to":old})];let next=vec![json!({"path":one,"to":new})];
    assert!(super::extension_files::replace(&previous,&next,||anyhow::bail!("fixture commit failed")).is_err());
    assert_eq!(std::fs::read_link(one).unwrap(),old);assert_eq!(std::fs::read_link(two).unwrap(),old);
}
