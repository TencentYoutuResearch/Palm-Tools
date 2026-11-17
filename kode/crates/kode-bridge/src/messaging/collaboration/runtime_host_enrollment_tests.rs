//! Local Store and oneshot tests only, no Host/service registration or listeners.
use super::*;
use crate::messaging::api::runtime_host_enrollment_routes;
use crate::messaging::runtime_host_enrollment::{Challenge, Register, Revoke};

const BASE: &str = "/api/v1/messaging/runtime-host-v1";
fn request(id: &str, boot: &str) -> Challenge {
    Challenge {
        request_id: id.into(),
        host_id: "fixture-host".into(),
        boot_id: boot.into(),
        protocol_version: 1,
    }
}
fn register_request(store: &Store, id: &str, boot: &str) -> Register {
    let challenge = store
        .challenge_runtime_host(request(&format!("challenge-{id}"), boot))
        .unwrap();
    Register {
        request_id: id.into(),
        challenge_id: challenge["challenge_id"].as_str().unwrap().into(),
        nonce: challenge["nonce"].as_str().unwrap().into(),
        host_id: "fixture-host".into(),
        boot_id: boot.into(),
        protocol_version: 1,
    }
}
fn isolated() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
    (dir, store)
}
fn rows(store: &Store) -> Vec<(String, String)> {
    let db = store.db.lock();
    let mut q = db
        .prepare("SELECT key,value FROM workbench_documents ORDER BY key")
        .unwrap();
    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn host_enrollment_receipt_restart_revocation_and_boot_tombstones() {
    let (dir, store) = isolated();
    let input = register_request(&store, "register", "boot-1");
    let first = store.register_runtime_host(input.clone()).unwrap();
    assert_eq!(first["status"], "active");
    assert_eq!(first["runtime_authorized"], false);
    assert_eq!(first["enrollment"]["home"], "home");
    let baseline = rows(&store);
    assert_eq!(
        store.runtime_host_register_status("register").unwrap()["enrollment"],
        first["enrollment"]
    );
    assert_eq!(
        store.register_runtime_host(input.clone()).unwrap()["receipt_replay"],
        true
    );
    assert_eq!(rows(&store), baseline);
    let mut conflict = input.clone();
    conflict.boot_id = "other-boot".into();
    assert!(store.register_runtime_host(conflict).is_err());
    let second = register_request(&store, "second", "boot-2");
    assert!(store.register_runtime_host(second.clone()).is_err());
    let revoke = Revoke {
        request_id: "revoke".into(),
        enrollment_id: first["enrollment"]["id"].as_str().unwrap().into(),
        expected_revision: 1,
    };
    store.revoke_runtime_host(revoke.clone()).unwrap();
    assert_eq!(
        store.revoke_runtime_host(revoke).unwrap()["status"],
        "revoked"
    );
    assert_eq!(
        store.register_runtime_host(input.clone()).unwrap()["status"],
        "revoked"
    );
    assert_eq!(
        store.runtime_host_register_status("register").unwrap()["status"],
        "revoked"
    );
    let second = store.register_runtime_host(second).unwrap();
    store
        .revoke_runtime_host(Revoke {
            request_id: "revoke-second".into(),
            enrollment_id: second["enrollment"]["id"].as_str().unwrap().into(),
            expected_revision: 1,
        })
        .unwrap();
    let forbidden = register_request(&store, "old-boot-again", "boot-1");
    assert_eq!(
        store
            .register_runtime_host(forbidden)
            .unwrap_err()
            .to_string(),
        "Host boot already enrolled"
    );
    drop(store);
    let store = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
    assert_eq!(
        store.runtime_host_register_status("register").unwrap()["status"],
        "revoked"
    );
    assert_eq!(
        store.runtime_host_register_status("missing").unwrap()["status"],
        "not_found"
    );
    assert_eq!(
        store.runtime_host_status(&input.challenge_id).unwrap()["status"],
        "not_found"
    );
}

#[test]
fn host_enrollment_challenge_exact_identity_expiry_and_single_consumer() {
    let (_dir, store) = isolated();
    let input = register_request(&store, "register", "boot");
    for field in ["nonce", "host_id", "boot_id", "challenge_id"] {
        let mut raw = serde_json::to_value(&input).unwrap();
        raw[field] = json!("wrong");
        assert!(store
            .register_runtime_host(serde_json::from_value(raw).unwrap())
            .is_err());
    }
    let mut unsupported = request("bad", "boot");
    unsupported.protocol_version = 2;
    assert!(store.challenge_runtime_host(unsupported).is_err());
    store.db.lock().execute("UPDATE workbench_documents SET value=json_set(value,'$.expires_at',0) WHERE key LIKE 'runtime-host-enrollment-v1:challenge:%'",[]).unwrap();
    assert!(store.register_runtime_host(input).is_err());
    let input = register_request(&store, "concurrent", "boot");
    let store = Arc::new(store);
    let mut other = input.clone();
    other.request_id = "other-consumer".into();
    let s = store.clone();
    let a = std::thread::spawn(move || s.register_runtime_host(input));
    let s = store.clone();
    let b = std::thread::spawn(move || s.register_runtime_host(other));
    assert_eq!(
        usize::from(a.join().unwrap().is_ok()) + usize::from(b.join().unwrap().is_ok()),
        1
    );
}

#[test]
fn host_enrollment_challenge_and_register_failpoints_are_atomic() {
    for prefix in ["challenge", "challenge-request"] {
        let (_dir, store) = isolated();
        store.db.lock().execute_batch(&format!("CREATE TEMP TRIGGER fail_enrollment BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE 'runtime-host-enrollment-v1:{prefix}:%' BEGIN SELECT RAISE(ABORT,'enrollment failpoint'); END;")).unwrap();
        let before = rows(&store);
        assert!(store
            .challenge_runtime_host(request("challenge", "boot"))
            .is_err());
        assert_eq!(rows(&store), before);
    }
    for prefix in ["enrollment", "boot", "host", "register-request"] {
        let (_dir, store) = isolated();
        let input = register_request(&store, "register", "boot");
        let before = rows(&store);
        store.db.lock().execute_batch(&format!("CREATE TEMP TRIGGER fail_enrollment BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE 'runtime-host-enrollment-v1:{prefix}:%' BEGIN SELECT RAISE(ABORT,'enrollment failpoint'); END;")).unwrap();
        assert!(store.register_runtime_host(input.clone()).is_err());
        assert_eq!(rows(&store), before);
        store
            .db
            .lock()
            .execute_batch("DROP TRIGGER fail_enrollment")
            .unwrap();
        assert_eq!(
            store.register_runtime_host(input).unwrap()["status"],
            "active"
        );
    }
}

#[tokio::test]
async fn host_enrollment_routes_enforce_owner_auth_and_reject_ready_claims() {
    let f = fixture_http();
    let routes = vec![
        (
            "POST",
            "challenges",
            Some(serde_json::to_value(request("challenge", "boot")).unwrap()),
        ),
        (
            "POST",
            "enrollments",
            Some(
                json!({"request_id":"register","challenge_id":"challenge","nonce":"nonce","host_id":"host","boot_id":"boot","protocol_version":1}),
            ),
        ),
        (
            "POST",
            "revocations",
            Some(json!({"request_id":"revoke","enrollment_id":"enrollment","expected_revision":1})),
        ),
        ("GET", "enrollments/enrollment", None),
        ("GET", "register-requests/request", None),
    ];
    let before = rows(&f.hub.store);
    for (method, suffix, body) in routes {
        let path = format!("{BASE}/{suffix}");
        for (token, status) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some("wrong"), StatusCode::UNAUTHORIZED),
            (Some(f.session_token.as_str()), StatusCode::FORBIDDEN),
        ] {
            assert_eq!(
                call(
                    runtime_host_enrollment_routes::router().with_state(f.hub.clone()),
                    method,
                    &path,
                    token,
                    body.clone()
                )
                .await
                .0,
                status
            );
        }
        assert_eq!(
            call(f.hub.router(), method, &path, Some(&f.session_token), body.clone())
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        if let Some(mut body) = body {
            body["ready"] = json!(true);
            assert_eq!(
                call(
                    runtime_host_enrollment_routes::router().with_state(f.hub.clone()),
                    method,
                    &path,
                    Some(OWNER),
                    Some(body)
                )
                .await
                .0,
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }
    assert_eq!(rows(&f.hub.store), before);
}

#[tokio::test]
async fn host_enrollment_owner_roundtrip_status_never_opens_scoped_gate() {
    let f = fixture_http();
    let router = || f.hub.router();
    let (status, challenge) = call(
        router(),
        "POST",
        &format!("{BASE}/challenges"),
        Some(OWNER),
        Some(serde_json::to_value(request("challenge", "boot")).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let input = json!({"request_id":"register","challenge_id":challenge["challenge_id"],"nonce":challenge["nonce"],"host_id":"fixture-host","boot_id":"boot","protocol_version":1});
    let (status, enrolled) = call(
        router(),
        "POST",
        &format!("{BASE}/enrollments"),
        Some(OWNER),
        Some(input),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(enrolled["runtime_authorized"], false);
    let (_, read) = call(
        router(),
        "GET",
        &format!("{BASE}/register-requests/register"),
        Some(OWNER),
        None,
    )
    .await;
    assert_eq!(read["enrollment"], enrolled["enrollment"]);
    assert!(read.get("nonce").is_none());
    let (_,revoked)=call(router(),"POST",&format!("{BASE}/revocations"),Some(OWNER),Some(json!({"request_id":"revoke","enrollment_id":enrolled["enrollment"]["id"],"expected_revision":1}))).await;
    assert_eq!(revoked["status"], "revoked");
    let (_, read) = call(
        router(),
        "GET",
        &format!("{BASE}/register-requests/register"),
        Some(OWNER),
        None,
    )
    .await;
    assert_eq!(read["status"], "revoked");
    // Actual existing scoped operation gate still rejects even with enrollment.
    let (_dir, store, key, _, claim) = super::super::inbox_tests::setup();
    let input = register_request(&store, "register", "boot");
    store.register_runtime_host(input).unwrap();
    let op = store.operation(&claim.operation_id).unwrap().unwrap();
    assert_eq!(
        crate::messaging::coordinator_control::lease_gate(
            &store.db.lock(),
            &op,
            crate::messaging::model::now()
        )
        .unwrap_err()
        .to_string(),
        "scoped Coordinator runtime not ready"
    );
    assert_eq!(
        store.context_inbox_authority(&key).unwrap()["runtime_ready"],
        false
    );
}
