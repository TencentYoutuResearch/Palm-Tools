//! Candidate contract tests only: in-process Router::oneshot, no listeners or Hub start.
use super::control_tests::{bind_input, prepare, ready};
use super::*;
use crate::messaging::{api::coordinator_context_routes, Config, Hub};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tower::ServiceExt;

const OWNER: &str = "fictional-contract-owner-token";
#[path = "runtime_host_enrollment_tests.rs"]
mod enrollment_tests;
const PREFIX: &str = "/api/v1/messaging/context-v2";
struct Fixture {
    _dir: tempfile::TempDir,
    _ctx: Arc<crate::Ctx>,
    hub: Arc<Hub>,
    key: String,
    session_token: String,
}
fn fixture_http() -> Fixture {
    let (dir, store, _, context) = ready();
    drop(store);
    fixture_from_store(dir,context.key)
}
fn fixture_from_store(dir:tempfile::TempDir,key:String)->Fixture {
    let mut config = kode_core::config::Config::default();
    config.backends.clear();
    // Construct the actual context data without build_runtime_ctx's background tasks.
    let (core_tx, _core_rx) = tokio::sync::mpsc::unbounded_channel();
    let ctx = Arc::new(crate::Ctx {
        cloud_sync: Default::default(),
        runtimes: Default::default(),
        agent_backends: Default::default(),
        acp: Arc::new(crate::acp::Registry::default()),
        config,
        sessions: Default::default(),
        core_tx,
        next_id: Arc::new(parking_lot::Mutex::new(1)),
        bus: Arc::new(crate::BridgeBus::new()),
        token: Arc::new(OWNER.into()),
        shells: Arc::new(crate::ShellManager::new()),
        memory: None,
        listen_addr: Default::default(),
        hook_relay_socket: None,
    });
    let hub = Hub::open_with_agent_home(
        Config {
            node_id: "home".into(),
            database: dir.path().join("store.sqlite"),
            peers: vec![],
        },
        &ctx,
        dir.path().join("agent-home"),
    )
    .unwrap();
    let registration = hub
        .store
        .register(crate::messaging::model::RegisterRequest {
            session_id: "ordinary-session".into(),
            title: "Fictional session".into(),
            runtime: "fixture".into(),
            owner_token: None,
        })
        .unwrap();
    Fixture {
        _dir: dir,
        _ctx: ctx,
        hub,
        key,
        session_token: registration.owner_token,
    }
}
fn candidate(f: &Fixture) -> Router {
    coordinator_context_routes::router().with_state(f.hub.clone())
}
async fn call(
    router: Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let body = if let Some(body) = body {
        request = request.header("content-type", "application/json");
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let response = router.oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&bytes)}));
    (status, value)
}
fn create_body(request: &str) -> Value {
    json!({"request_id":request,"surface_id":"channel","expected_surface_revision":1,
        "team_id":"team","team_revision":2,"audience_revision":1,"content":"Exact API root"})
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn contracts(key: &str) -> Vec<(&'static str, String, Option<Value>)> {
    vec![
        (
            "POST",
            format!("{PREFIX}/threads"),
            Some(create_body("contract")),
        ),
        ("GET", format!("{PREFIX}/contexts/{key}"), None),
        ("GET", format!("{PREFIX}/contexts/{key}/control"), None),
        (
            "POST",
            format!("{PREFIX}/contexts/{key}/control"),
            Some(json!({"request_id":"bind","expected_revision":0,
            "team_revision":2,"activation_revision":1,"operation_id":"operation","operation_revision":1,"attempt":1,"epoch":1,"target_id":"engine"})),
        ),
        (
            "POST",
            format!("{PREFIX}/contexts/{key}/inputs"),
            Some(json!({"request_id":"input","source_message_id":"source",
            "expected_content_sha256":"a".repeat(64),"explicitly_continue_stored":true})),
        ),
        ("GET", format!("{PREFIX}/contexts/{key}/inputs/input"), None),
        (
            "POST",
            format!("{PREFIX}/summary-approvals"),
            Some(json!({"request_id":"approve","source_context_key":key,
            "target_context_key":"b".repeat(64),"source_message_id":"source","expected_source_content_sha256":"a".repeat(64),
            "expected_target_audience_revision":1,"summary":"Approved","summary_sha256":hash("Approved")})),
        ),
        (
            "GET",
            format!("{PREFIX}/contexts/{key}/summary-approvals/approve"),
            None,
        ),
    ]
}

#[tokio::test]
async fn scoped_http_contract_all_candidate_routes_require_real_admin_auth() {
    let f = fixture_http();
    let before: f64 = f
        .hub
        .store
        .db
        .lock()
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    for (method, path, body) in contracts(&f.key) {
        for (token, expected) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some("incorrect-token"), StatusCode::UNAUTHORIZED),
            (Some(f.session_token.as_str()), StatusCode::FORBIDDEN),
        ] {
            let (status, _) = call(candidate(&f), method, &path, token, body.clone()).await;
            assert_eq!(status, expected, "{method} {path}");
        }
    }
    let after: f64 = f
        .hub
        .store
        .db
        .lock()
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn scoped_http_unapproved_contracts_remain_absent_from_production_router() {
    let f = fixture_http();
    for (method, path, body) in contracts(&f.key).into_iter().filter(|(_,p,_)|p.contains("summary-approvals") || p.ends_with("/inputs/input")) {
        assert_eq!(
            call(f.hub.router(), method, &path, Some(OWNER), body)
                .await
                .0,
            StatusCode::NOT_FOUND,
            "{method} {path}"
        );
    }
    for suffix in ["dispatch", "recovery"] {
        assert_eq!(
            call(
                candidate(&f),
                "POST",
                &format!("{PREFIX}/contexts/{}/{suffix}", f.key),
                Some(OWNER),
                Some(json!({}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
}

#[tokio::test]
async fn scoped_http_contract_create_read_and_exact_input_remain_not_ready() {
    let f = fixture_http();
    let (status, created) = call(
        candidate(&f),
        "POST",
        &format!("{PREFIX}/threads"),
        Some(OWNER),
        Some(create_body("create")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["runtime_ready"], false);
    let key = created["thread"]["context_key"].as_str().unwrap();
    let root = created["thread"]["thread_id"].as_str().unwrap();
    let input = created["thread"]["input_request_id"].as_str().unwrap();
    assert_eq!(
        call(
            candidate(&f),
            "POST",
            &format!("{PREFIX}/threads"),
            Some(OWNER),
            Some(create_body("create"))
        )
        .await
        .1,
        created
    );
    for path in [
        format!("{PREFIX}/contexts/{key}"),
        format!("{PREFIX}/contexts/{key}/control"),
        format!("{PREFIX}/contexts/{key}/inputs/{input}"),
    ] {
        let (status, value) = call(candidate(&f), "GET", &path, Some(OWNER), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["runtime_ready"], false);
    }
    let message = f
        .hub
        .store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "exact-followup".into(),
                expected_revision: 1,
                thread_id: Some(root.into()),
                content: "Only this followup".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let body = json!({"request_id":"followup","source_message_id":message["id"],"expected_content_sha256":hash("Only this followup"),"explicitly_continue_stored":false});
    let (status, recorded) = call(
        candidate(&f),
        "POST",
        &format!("{PREFIX}/contexts/{key}/inputs"),
        Some(OWNER),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(recorded["runtime_ready"], false);
    let (status, read) = call(
        candidate(&f),
        "GET",
        &format!("{PREFIX}/contexts/{key}/inputs/followup"),
        Some(OWNER),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["input"]["message"]["content"], "Only this followup");
    assert!(!read.to_string().contains("Exact API root"));
    let mut invalid = create_body("invalid");
    invalid["context_scope"] = json!({"version":2});
    assert_eq!(
        call(
            candidate(&f),
            "POST",
            &format!("{PREFIX}/threads"),
            Some(OWNER),
            Some(invalid)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        f.hub
            .store
            .db
            .lock()
            .query_row(
                "SELECT count(*) FROM collaboration_coordinator_inputs",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn scoped_http_contract_real_control_binding_never_admits_runtime() {
    let f = fixture_http();
    let bundle = prepare(&f.hub.store, &format!("context-{}", f.key), "http-control");
    let body = serde_json::to_value(bind_input(&bundle)).unwrap();
    let path = format!("{PREFIX}/contexts/{}/control", f.key);
    let (status, bound) = call(
        candidate(&f),
        "POST",
        &path,
        Some(OWNER),
        Some(body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bound["runtime_ready"], false);
    assert_eq!(bound["control"]["runtime_ready"], false);
    assert_eq!(
        call(candidate(&f), "POST", &path, Some(OWNER), Some(body))
            .await
            .1,
        bound
    );
    assert_eq!(
        call(candidate(&f), "GET", &path, Some(OWNER), None).await.1,
        bound
    );
    assert!(f.hub.store.coordinator_control("team").unwrap().is_none());
    let op = f
        .hub
        .store
        .operation(bundle["operation"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert!(crate::messaging::coordinator_control::lease_gate(
        &f.hub.store.db.lock(),
        &op,
        crate::messaging::model::now()
    )
    .is_err());
}

#[tokio::test]
async fn scoped_http_contract_summary_approval_never_returns_source_chat() {
    let f = fixture_http();
    let (_, target) = call(
        candidate(&f),
        "POST",
        &format!("{PREFIX}/threads"),
        Some(OWNER),
        Some(create_body("summary-target")),
    )
    .await;
    let key = target["thread"]["context_key"].as_str().unwrap();
    let source = f.hub.store.coordinator_context(&f.key).unwrap();
    let request = json!({"request_id":"summary","source_context_key":f.key,"target_context_key":key,
        "source_message_id":source.thread_id,"expected_source_content_sha256":hash("Fresh discussion"),
        "expected_target_audience_revision":1,"summary":"Approved review note","summary_sha256":hash("Approved review note")});
    let (status, approved) = call(
        candidate(&f),
        "POST",
        &format!("{PREFIX}/summary-approvals"),
        Some(OWNER),
        Some(request),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(approved["runtime_ready"], false);
    let (status, read) = call(
        candidate(&f),
        "GET",
        &format!("{PREFIX}/contexts/{key}/summary-approvals/summary"),
        Some(OWNER),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read, approved);
    assert_eq!(read["approval"]["summary"], "Approved review note");
    assert!(!read.to_string().contains("Fresh discussion"));
    assert_eq!(
        call(
            candidate(&f),
            "GET",
            &format!("{PREFIX}/contexts/{}/summary-approvals/summary", f.key),
            Some(OWNER),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[path="context_runtime_route_tests.rs"]
mod runtime_routes;

#[path="../interactive_team_route_tests.rs"]
mod interactive_routes;
