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
    let root = tempfile::tempdir().unwrap();
    let ctx = crate::build_test_ctx(kode_core::config::Config::default(), "admin-test".into());
    let hub = Hub::open(
        Config {
            node_id: node.into(),
            database: root.path().join("messages.sqlite"),
            peers,
        },
        &ctx,
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
async fn workbench_configuration_is_durable_versioned_and_not_agent_accessible() {
    let s = server("workbench-test", vec![]).await;
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/workbench/documents/ssh-hosts", s.url);
    let absent: Value = client.get(&url).bearer_auth("admin-test").send().await.unwrap().json().await.unwrap();
    assert_eq!(absent, json!({"revision":0,"value":null}));
    let saved: Value = client.post(&url).bearer_auth("admin-test").json(&json!({"expected_revision":0,"value":[{"id":"build","token":"server-only-secret"}]})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(saved["revision"], 1);
    let stale = client.post(&url).bearer_auth("admin-test").json(&json!({"expected_revision":0,"value":[]})).send().await.unwrap();
    assert_eq!(stale.status(), 400);
    let owner = register(&s, "agent-reader").await;
    assert_eq!(client.get(&url).bearer_auth(owner.owner_token).send().await.unwrap().status(), 403);
    let current: Value = client.get(&url).bearer_auth("admin-test").send().await.unwrap().json().await.unwrap();
    assert_eq!(current, saved);
    assert_eq!(client.get(format!("{}/api/v1/messaging/workbench/documents/arbitrary-file", s.url)).bearer_auth("admin-test").send().await.unwrap().status(), 400);
}

#[tokio::test]
async fn archived_legacy_gui_tabs_need_no_adapter_and_are_restorable_without_losing_metadata() {
    let s=server("cold-archive",vec![]).await;
    let native_id="session-kode-example";
    let tab=json!({"backend_key":"removed-claude","session_id":"old-native-thread","cwd":"/srv/project","title":"Original title","endpoint_id":null});
    let mut native=tab.clone();native["dsh_session_id"]=json!(native_id);native["title"]=json!("Saved metadata title");
    let index=s.hub.store.document("session-index").unwrap();
    s.hub.store.save_document("session-index",index["revision"].as_u64().unwrap(),json!({"version":1,"gui":{"tabs":[tab],"endpoints":[]},"native_sessions":[native]})).unwrap();
    let document=super::workspaces::ensure(&s.hub).unwrap();
    let mut workspaces=document["value"].clone();workspaces["global"]["archivedSessionIds"]=json!([native_id]);
    let archived=s.hub.store.save_document("workspaces",document["revision"].as_u64().unwrap(),workspaces.clone()).unwrap();
    let client=reqwest::Client::new();
    let catalog:Value=client.get(format!("{}/api/v1/messaging/workbench/catalog",s.url)).bearer_auth("admin-test").send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert!(catalog["tabs"].as_array().unwrap().is_empty());
    workspaces["global"]["archivedSessionIds"]=json!([]);
    s.hub.store.save_document("workspaces",archived["revision"].as_u64().unwrap(),workspaces).unwrap();
    let restored:Value=client.get(format!("{}/api/v1/messaging/workbench/catalog",s.url)).bearer_auth("admin-test").send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(restored["tabs"][0]["title"],"Saved metadata title");
    assert_eq!(restored["tabs"][0]["session_id"],"old-native-thread");
    assert_eq!(s.hub.store.document("session-index").unwrap()["value"]["gui"]["tabs"].as_array().unwrap().len(),1);
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
        protocol: None,
        command: "/bin/sh".into(),
        args: vec!["-c".into(), "cat".into()],
        default_model: None,
        model_flag: None,
        permission_mode_flag: None,
        mcp_setup: None,
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

fn empty_workspaces() -> Value { json!({"version":2,"tables":{"workspaces":{}},"global":{"initialized":true,"workspaceIds":[],"archivedSessionIds":[],"pinnedSessionIds":[]}}) }
#[tokio::test]
async fn native_catalog_survives_opened_tab_saves_and_uses_workspace_titles() {
    let s=server("session-catalog-local",vec![]).await;
    let mut projects=empty_workspaces();
    projects["tables"]["workspaces"]["project"]=json!({"path":"/srv/project","title":"Named project","sessionIds":["inline-session"]});
    projects["global"]["workspaceIds"]=json!(["project"]);
    s.hub.store.save_document("workspaces",0,projects).unwrap();
    let tab=json!({"backend_key":"codex","cwd":"/srv/project","session_id":"native-thread","title":"Native helper","env":{"SECRET":"must-not-leak"}});
    s.hub.store.save_document("session-index",0,json!({"gui":{"tabs":[tab],"endpoints":[]}})).unwrap();
    let mut agents=s.hub.store.document("agents").unwrap();agents["value"]["bindings"]=json!({"inline-session":{"threadId":"native-thread","profile":{"env":{"SECRET":"must-not-leak"}}}});
    s.hub.store.save_document("agents",agents["revision"].as_u64().unwrap(),agents["value"].clone()).unwrap();
    let client=reqwest::Client::new();let url=format!("{}/api/v1/messaging/workbench/sessions",s.url);
    let first:Value=client.get(&url).bearer_auth("admin-test").send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(first["tabs"][0]["workspace_title"],"Named project");
    assert_eq!(first["tabs"][0]["dsh_session_id"],"inline-session");
    assert!(!first.to_string().contains("must-not-leak"));
    let mut index=s.hub.store.document("session-index").unwrap();index["value"]["gui"]["tabs"]=json!([]);
    s.hub.store.save_document("session-index",index["revision"].as_u64().unwrap(),index["value"].clone()).unwrap();
    let after:Value=client.get(&url).bearer_auth("admin-test").send().await.unwrap().json().await.unwrap();
    assert_eq!(after["tabs"].as_array().unwrap().len(),1);
    assert_eq!(after["tabs"][0]["session_id"],"native-thread");
    let owner=register(&s,"catalog-reader").await;
    assert_eq!(client.get(&url).bearer_auth(owner.owner_token).send().await.unwrap().status(),403);
}
#[tokio::test]
async fn peer_session_catalog_is_paginated_scoped_and_credential_free() {
    let remote=server("catalog-remote",vec![peer("catalog-local",None)]).await;
    let local=server("catalog-local",vec![peer("catalog-remote",Some(remote.url.clone()))]).await;
    remote.hub.store.save_document("workspaces",0,empty_workspaces()).unwrap();
    let rows=(0..50).map(|i|json!({"backend_key":"codex","session_id":format!("thread-{i}"),"cwd":format!("/srv/{}","directory".repeat(300)),"title":"Remote helper","env":{"SECRET":"private"}})).collect::<Vec<_>>();
    remote.hub.store.save_document("session-index",0,json!({"native_sessions":rows,"gui":{"tabs":[{"backend_key":"codex","session_id":"foreign","cwd":"/srv/foreign","endpoint_id":{"kind":"remote","id":"another.example"}}],"endpoints":[{"token":"private"}]}})).unwrap();
    let mut offset=0;let mut count=0;
    loop {
        let page=local.hub.workspace("catalog-remote",workspaces::Command::SessionCatalog{offset}).await.unwrap();
        assert_eq!(page["node_id"],"catalog-remote");assert!(page.to_string().len()<64*1024);
        assert!(!page.to_string().contains("private"));
        for row in page["tabs"].as_array().unwrap() {assert!(row["endpoint_id"].is_null());assert_eq!(row["workspace_title"],"未分组");}
        count+=page["tabs"].as_array().unwrap().len();
        if let Some(next)=page["next_offset"].as_u64(){offset=next as usize;}else{break;}
    }
    assert_eq!(count,50);assert!(local.hub.workspace_pending.lock().is_empty());
    let _=tokio::time::timeout(std::time::Duration::from_millis(1),local.hub.workspace("catalog-remote",workspaces::Command::List)).await;
    assert!(local.hub.workspace_pending.lock().is_empty());
}
#[tokio::test]
async fn workspaces_are_one_durable_node_owned_catalog_without_default_recreation() {
    let s=server("workspace-local",vec![]).await;
    s.hub.store.save_document("workspaces",0,empty_workspaces()).unwrap();
    let client=reqwest::Client::new();let url=format!("{}/api/v1/messaging/workbench/workspaces",s.url);
    let path=s._root.path().join("project");std::fs::create_dir(&path).unwrap();
    let created: Value=client.post(&url).bearer_auth("admin-test").json(&json!({"action":"create","path":path})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let id=created["workspace_id"].as_str().unwrap();
    assert_eq!(created["workspaces"].as_array().unwrap().len(),1);
    let doc=s.hub.store.document("workspaces").unwrap();assert_eq!(doc["value"]["tables"]["workspaces"][id]["path"],json!(std::fs::canonicalize(&path).unwrap()));
    let again:Value=client.post(&url).bearer_auth("admin-test").json(&json!({"action":"create","path":path})).send().await.unwrap().json().await.unwrap();assert_eq!(again["workspace_id"],id);
    assert_eq!(client.post(&url).bearer_auth("admin-test").json(&json!({"action":"create","path":"relative/path"})).send().await.unwrap().status(),400);
    let owner=register(&s,"workspace-reader").await;assert_eq!(client.get(&url).bearer_auth(owner.owner_token).send().await.unwrap().status(),403);
    client.post(&url).bearer_auth("admin-test").json(&json!({"action":"delete","id":id})).send().await.unwrap().error_for_status().unwrap();
    let empty:Value=client.get(&url).bearer_auth("admin-test").send().await.unwrap().json().await.unwrap();assert!(empty["workspaces"].as_array().unwrap().is_empty());assert!(path.is_dir());
    assert!(s.hub.store.document("workspaces").unwrap()["value"]["global"].get("defaultWorkspaceId").is_none());
}
#[tokio::test]
async fn workspace_operations_route_to_the_ssh_peer_node_and_cannot_use_local_ids() {
    let remote=server("workspace-remote",vec![peer("workspace-local",None)]).await;
    let local=server("workspace-local",vec![peer("workspace-remote",Some(remote.url.clone()))]).await;
    for s in [&local,&remote] {s.hub.store.save_document("workspaces",0,empty_workspaces()).unwrap();}
    let remote_path=remote._root.path().join("remote-project");std::fs::create_dir(&remote_path).unwrap();
    let client=reqwest::Client::new();let url=format!("{}/api/v1/messaging/workbench/workspaces",local.url);
    let created:Value=client.post(&url).bearer_auth("admin-test").json(&json!({"action":"create","node_id":"workspace-remote","path":remote_path,"title":"Remote project"})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert_eq!(created["node_id"],"workspace-remote");assert_eq!(created["workspaces"][0]["title"],"Remote project");
    assert!(local.hub.store.document("workspaces").unwrap()["value"]["tables"]["workspaces"].as_object().unwrap().is_empty());
    let wrong=client.post(&url).bearer_auth("admin-test").json(&json!({"action":"rename","node_id":"workspace-remote","id":"local-only-workspace","title":"Wrong"})).send().await.unwrap();assert_eq!(wrong.status(),400);
    let viewed:Value=client.get(&url).query(&[("node_id","workspace-remote")]).bearer_auth("admin-test").send().await.unwrap().json().await.unwrap();assert_eq!(viewed["workspaces"][0]["path"],json!(std::fs::canonicalize(&remote_path).unwrap()));
}
