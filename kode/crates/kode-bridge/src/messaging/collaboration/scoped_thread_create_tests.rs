//! Only temporary Store fixtures; never starts a Hub, session or provider runtime.
use super::*;
use crate::messaging::collaboration::scoped_thread_create::Create;
use serde_json::Value;

fn create(surface: &str) -> Create {
    Create {
        request_id: "create-scoped".into(),
        surface_id: surface.into(),
        expected_surface_revision: 1,
        team_id: "team".into(),
        team_revision: 1,
        audience_revision: 1,
        content: "Exact new root only".into(),
    }
}
fn counts(store: &Store) -> (u64, u64) {
    let db = store.db.lock();
    (
        db.query_row("SELECT count(*) FROM collaboration_messages", [], |r| {
            r.get(0)
        })
        .unwrap(),
        db.query_row("SELECT count(*) FROM workbench_documents", [], |r| r.get(0))
            .unwrap(),
    )
}

#[test]
fn scoped_thread_create_atomic_root_scope_reference_is_durable_and_idempotent() {
    let (dir, store, old) = fixture("channel", Kind::Channel);
    let result = store.create_scoped_thread(create("channel")).unwrap();
    assert_ne!(result["thread_id"], old.thread_id);
    assert_eq!(result["source_message_id"], result["thread_id"]);
    assert_eq!(result["runtime_ready"], false);
    assert_eq!(result["execution_authorized"], false);
    let context_key = result["context_key"].as_str().unwrap();
    let context = store.coordinator_context(context_key).unwrap();
    let exact = store
        .context_input(context_key, result["input_request_id"].as_str().unwrap())
        .unwrap();
    assert_eq!(exact["message"]["content"], create("channel").content);
    assert_eq!(
        context.start_sequence,
        exact["receipt"]["source_sequence"].as_u64().unwrap()
    );
    let before = counts(&store);
    assert_eq!(
        store.create_scoped_thread(create("channel")).unwrap(),
        result
    );
    assert_eq!(counts(&store), before);
    let db = store.db.lock();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM collaboration_coordinator_inputs",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM operations", [], |r| r
            .get::<_, u64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM workbench_documents WHERE value LIKE '%Exact new root only%'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
    let receipt: String = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key LIKE 'coordinator-thread-create-v2:%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&receipt).unwrap()["origin_kind"],
        "atomic_new_root"
    );
    drop(db);
    drop(store);
    let store = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
    assert_eq!(
        store.create_scoped_thread(create("channel")).unwrap(),
        result
    );
    assert_eq!(counts(&store), before);
}

#[test]
fn scoped_thread_create_has_one_atomic_identity_under_concurrent_retries() {
    let (_dir, store, _) = fixture("dm", Kind::Dm);
    let store = std::sync::Arc::new(store);
    let handles = (0..4)
        .map(|_| {
            let store = store.clone();
            std::thread::spawn(move || store.create_scoped_thread(create("dm")).unwrap())
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert!(results.iter().all(|r| r == &results[0]));
    assert_eq!(results[0]["context_scope"]["kind"], "team_private");
    assert_eq!(counts(&store).0, 2);
}

#[test]
fn scoped_thread_create_rejects_changed_request_invalid_scope_and_external_source_identity() {
    let (_dir, store, _) = fixture("channel", Kind::Channel);
    store.create_scoped_thread(create("channel")).unwrap();
    let before = counts(&store);
    for field in ["content", "revision", "team", "audience", "request_empty"] {
        let mut request = create("channel");
        match field {
            "content" => request.content = "Changed".into(),
            "revision" => request.expected_surface_revision = 2,
            "team" => request.team_id = "foreign-team".into(),
            "audience" => request.audience_revision = 2,
            _ => request.request_id = String::new(),
        }
        assert!(store.create_scoped_thread(request).is_err(), "{field}");
        assert_eq!(counts(&store), before);
    }
    let mut wire = serde_json::to_value(create("channel")).unwrap();
    wire["source_message_id"] = json!("old-message");
    assert!(serde_json::from_value::<Create>(wire).is_err());
}

#[test]
fn scoped_thread_create_failure_rolls_back_root_registry_and_input_reference() {
    // Fail each persistence stage after the root insert. The complete transaction,
    // including the root and any prior successful stage, must disappear.
    for prefix in [
        "coordinator-context-v2:",
        "coordinator-context-input-v2:",
        "coordinator-thread-create-v2:",
    ] {
        let (_dir, store, _) = fixture("channel", Kind::Channel);
        let before = counts(&store);
        store.db.lock().execute_batch(&format!("CREATE TEMP TRIGGER fixture_reject_write BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE '{prefix}%' BEGIN SELECT RAISE(ABORT,'fixture stage failure'); END;")).unwrap();
        assert!(store
            .create_scoped_thread(create("channel"))
            .unwrap_err()
            .to_string()
            .contains("fixture stage failure"));
        assert_eq!(counts(&store), before, "{prefix}");
        store
            .db
            .lock()
            .execute_batch("DROP TRIGGER fixture_reject_write")
            .unwrap();
        assert!(store.create_scoped_thread(create("channel")).is_ok());
        assert_eq!(counts(&store).0, before.0 + 1);
    }
}

#[test]
fn scoped_thread_create_retry_rechecks_source_and_revocation_without_duplicating() {
    for field in ["scope", "content", "delivered"] {
        let (_dir, store, _) = fixture("channel", Kind::Channel);
        let result = store.create_scoped_thread(create("channel")).unwrap();
        let db = store.db.lock();
        match field {
            "scope" => {
                db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false'))",[]).unwrap();
            }
            "content" => {
                db.execute("UPDATE collaboration_messages SET body=json_set(body,'$.content','Changed') WHERE id=?1",[result["source_message_id"].as_str().unwrap()]).unwrap();
            }
            _ => {
                db.execute("UPDATE collaboration_messages SET body=json_set(body,'$.delivery_state','delivered') WHERE id=?1",[result["source_message_id"].as_str().unwrap()]).unwrap();
            }
        }
        drop(db);
        let before = counts(&store);
        assert!(
            store.create_scoped_thread(create("channel")).is_err(),
            "{field}"
        );
        assert_eq!(counts(&store), before);
    }
}

#[test]
fn scoped_thread_create_new_request_always_creates_new_root_without_adopting_old_history() {
    let (_dir, store, old) = fixture("channel", Kind::Channel);
    let first = store.create_scoped_thread(create("channel")).unwrap();
    let mut request = create("channel");
    request.request_id = "another-create".into();
    let second = store.create_scoped_thread(request).unwrap();
    assert_ne!(first["thread_id"], second["thread_id"]);
    assert_ne!(first["context_key"], second["context_key"]);
    let old_source = format!("coordinator-context-source-v2:{}", json!(old.thread_id));
    assert!(store.document(&old_source).unwrap()["value"].is_null());
    assert!(store.coordinator_control("team").unwrap().is_none());
    assert!(store.sessions().unwrap().is_empty());
}
