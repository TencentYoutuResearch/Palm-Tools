use super::*;
use crate::messaging::{builder_authority, model::now};
use serde::de::DeserializeOwned;
use std::sync::{Arc, Barrier};

fn decode<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn fixture() -> (tempfile::TempDir, Arc<Store>, Value, Value) {
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&temp.path().join("hub.sqlite"), "local").unwrap());
    let at = now();
    store
        .change_resource_account(decode(
            json!({"id":"account","expected_epoch":0,"enabled":true}),
        ))
        .unwrap();
    store.bind_resource_account(decode(json!({"host":"local","profile":"profile","account_id":"account","account_epoch":1,"expected_revision":0}))).unwrap();
    store.configure_budget(decode(json!({"id":"creation","scope":"team","scope_id":"builder","unit":"credits","limit":100,"starts_at":at-1000,"ends_at":at+600000,"expected_revision":0})), at).unwrap();
    let target = json!({"host":"local","workspace":"fixture","root":"/fixture"});
    let tools = json!([
        "kode_builder_read_draft",
        "kode_builder_preflight",
        "kode_builder_inspect_workspace",
        "kode_builder_prepare_questions",
        "kode_builder_save_draft",
        "kode_builder_catalog",
        "kode_builder_policy_details"
    ]);
    let grant = json!({"team_id":"builder","revision":1,"target":target,"capabilities":["read","builder_draft_write"],"tools":tools,"network":false,"budget_ids":["creation"]});
    store.write_team_grant(decode(json!({"expected_revision":0,"policy":{"id":"grant","team_id":"builder","enabled":true,"expires_at":at+600000,"targets":[target],"capabilities":grant["capabilities"],"tools":tools,"network":false,"budget_ids":["creation"]}})), at).unwrap();
    store.create_price(decode(json!({"id":"price","model":"model","model_policy":"requested_model","unit":"credits","input_per_million":1000000,"cached_per_million":1000000,"output_per_million":1000000}))).unwrap();
    store.save_builder_draft(decode(json!({"id":"draft","request_id":"create","expected_revision":0,"revoked":false,"interview":{"purpose":"Create a team","workspace_refs":[{"host_id":"local","workspace_id":"fixture","root_ref":"/fixture"}],"answers":{},"questions":[],"proposed_team":null}}))).unwrap();
    let selected = json!({"request_id":"select","expected_revision":0,"draft_revision":1,"selection":{"profile_id":"profile","provider":"provider","model":"model","effort":null,"workspace":{"host_id":"local","workspace_id":"fixture","root_ref":"/fixture"}}});
    store
        .save_builder_selection("draft", decode(selected.clone()))
        .unwrap();
    let start = json!({"draft_id":"draft","draft_revision":1,"price_id":"price","operation":{"owner_session":"owner","request_key":"start","worker":{"node_id":"local","session_id":"builder"},"selection_policy":{"profile_revision":"a".repeat(64),"model":"model","effort":null,"scope":"executor_configuration"},"funding":{"budget_ids":["creation"],"amount":10,"unit":"credits"},"resource":{"host":"local","profile":"profile","account_id":"account","account_epoch":1,"binding_revision":1,"limit_ids":[],"unknown_quota":"team_budget"},"grant_id":"grant","grant_scope":grant}});
    (temp, store, start, selected)
}

fn selection_change(selected: &Value, field: &str, value: Value) -> Value {
    let mut command = selected.clone();
    command["request_id"] = json!(format!("change-{field}"));
    command["expected_revision"] = json!(1);
    command["selection"][field] = value;
    command
}

#[test]
fn builder_selection_pending_lock_preserves_cas_noop_and_receipt_replay() {
    let (_temp, store, start, selected) = fixture();
    let receipt = store
        .save_builder_selection("draft", decode(selected.clone()))
        .unwrap();
    let started = store.prepare_builder_start(decode(start.clone())).unwrap();
    let read = store.builder_selection("draft").unwrap();
    assert_eq!(read["runtime_binding"]["state"], "pending_start");
    assert_eq!(read["runtime_binding"]["selection_snapshot"], receipt);
    assert_eq!(read["model_change_supported"], false);
    assert_eq!(read["runtime_binding"]["binding_count"], 1);
    assert_eq!(read["runtime_binding"]["profile_id"], "profile");
    assert_eq!(read["runtime_binding"]["profile_revision"], "a".repeat(64));
    assert_eq!(read["runtime_binding"]["worker"]["session_id"], "builder");
    assert!(read["runtime_binding"].get("scope").is_none());
    assert!(read["runtime_binding"].get("operation").is_none());
    for (field, value) in [
        ("profile_id", json!("other")),
        ("provider", json!("other")),
        ("model", json!("other")),
        ("effort", json!("high")),
    ] {
        let command = selection_change(&selected, field, value);
        assert!(store
            .save_builder_selection("draft", decode(command))
            .unwrap_err()
            .to_string()
            .contains("selection locked"));
    }
    let mut stale = selection_change(&selected, "profile_id", json!("other"));
    stale["expected_revision"] = json!(0);
    assert!(store
        .save_builder_selection("draft", decode(stale))
        .unwrap_err()
        .to_string()
        .contains("revision conflict"));
    let mut noop = selected.clone();
    noop["request_id"] = json!("noop");
    noop["expected_revision"] = json!(1);
    assert_eq!(
        store.save_builder_selection("draft", decode(noop)).unwrap()["revision"],
        2
    );
    assert_eq!(
        store
            .save_builder_selection("draft", decode(selected.clone()))
            .unwrap(),
        receipt
    );
    let mut conflicting = selected;
    conflicting["selection"]["model"] = json!("changed");
    assert!(store
        .save_builder_selection("draft", decode(conflicting))
        .unwrap_err()
        .to_string()
        .contains("identity conflict"));
    assert_eq!(
        store.prepare_builder_start(decode(start.clone())).unwrap(),
        started
    );
    let mut other = start;
    other["operation"]["request_key"] = json!("other-start");
    other["operation"]["worker"]["session_id"] = json!("other-worker");
    assert!(store
        .prepare_builder_start(decode(other))
        .unwrap_err()
        .to_string()
        .contains("already bound"));
    assert_eq!(store.budget("creation").unwrap()["budget"]["reserved"], 10);
}

#[test]
fn builder_selection_failed_preparation_and_safe_abandon_allow_recovery() {
    let (_temp, store, start, selected) = fixture();
    let mut invalid = start.clone();
    invalid["draft_revision"] = json!(2);
    assert!(store.prepare_builder_start(decode(invalid)).is_err());
    assert!(store.builder_selection("draft").unwrap()["runtime_binding"].is_null());
    assert_eq!(store.budget("creation").unwrap()["budget"]["reserved"], 0);
    let started = store.prepare_builder_start(decode(start.clone())).unwrap();
    let op = &started["bundle"]["operation"];
    store
        .abandon_operation_bundle(
            op["id"].as_str().unwrap(),
            decode(json!({"request_id":"abandon","expected_revision":op["revision"]})),
        )
        .unwrap();
    assert!(store.builder_selection("draft").unwrap()["runtime_binding"].is_null());
    // Historical receipts remain historical, never dispatch a different operation.
    assert_eq!(
        store.prepare_builder_start(decode(start.clone())).unwrap(),
        started
    );
    let change = selection_change(&selected, "provider", json!("replacement"));
    assert!(store
        .save_builder_selection("draft", decode(change))
        .is_ok());
    let mut retry = start;
    retry["operation"]["request_key"] = json!("retry");
    retry["operation"]["worker"]["session_id"] = json!("retry-worker");
    assert!(store.prepare_builder_start(decode(retry)).is_ok());
}

#[test]
fn builder_selection_started_and_legacy_stopped_scopes_stay_locked() {
    let (temp, store, start, selected) = fixture();
    let started = store.prepare_builder_start(decode(start.clone())).unwrap();
    let op = &started["bundle"]["operation"];
    let id = op["id"].as_str().unwrap();
    let active = store.command_operation(id, decode(json!({"attempt":op["attempt"],"epoch":op["epoch"],"expected_revision":op["revision"],"selection_ack":start["operation"]["selection_policy"],"action":{"kind":"claim_resource","lease_ms":3000,"resource":{"profile":"profile","account_epoch":1,"binding_revision":1}}})), now()).unwrap().operation;
    assert_eq!(
        store.builder_selection("draft").unwrap()["runtime_binding"]["state"],
        "started_or_occupied"
    );
    assert!(store
        .abandon_operation_bundle(
            id,
            decode(json!({"request_id":"unsafe-abandon","expected_revision":active.revision}))
        )
        .is_err());
    let cancelled = store.command_operation(id, decode(json!({"attempt":active.attempt,"epoch":active.epoch,"expected_revision":active.revision,"action":{"kind":"cancel"}})), now()).unwrap().operation;
    store.command_operation(id, decode(json!({"attempt":cancelled.attempt,"epoch":cancelled.epoch,"expected_revision":cancelled.revision,"action":{"kind":"attest_stopped","reason":"test owner stopped worker"}})), now()).unwrap();
    // Simulate a pre-upgrade scope (no new snapshot) and verify reopen compatibility.
    store.db.lock().execute("UPDATE workbench_documents SET value=json_remove(value,'$.selection_snapshot') WHERE key LIKE 'builder-scope:%'", []).unwrap();
    drop(store);
    let store = Store::open(&temp.path().join("hub.sqlite"), "local").unwrap();
    assert_eq!(
        store.builder_selection("draft").unwrap()["runtime_binding"]["state"],
        "started_or_occupied"
    );
    assert!(store
        .save_builder_selection(
            "draft",
            decode(selection_change(&selected, "profile_id", json!("other")))
        )
        .is_err());
    assert_eq!(store.prepare_builder_start(decode(start)).unwrap(), started);
}

#[test]
fn builder_selection_concurrent_starts_have_one_durable_draft_owner() {
    let (_temp, store, start, _) = fixture();
    let gate = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|n| {
            let store = store.clone();
            let gate = gate.clone();
            let mut start = start.clone();
            start["operation"]["request_key"] = json!(format!("start-{n}"));
            start["operation"]["worker"]["session_id"] = json!(format!("worker-{n}"));
            std::thread::spawn(move || {
                gate.wait();
                store.prepare_builder_start(decode(start))
            })
        })
        .collect();
    gate.wait();
    let results: Vec<_> = workers.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(store.budget("creation").unwrap()["budget"]["reserved"], 10);
    let second = store
        .prepare_granted_operation(
            "owner",
            "direct",
            decode(json!({"node_id":"local","session_id":"direct-worker"})),
            true,
            false,
            true,
        )
        .unwrap();
    assert!(store
        .bind_builder_scope(
            &second.id,
            builder_authority::Attach {
                expected_revision: second.revision,
                attempt: second.attempt,
                epoch: second.epoch,
                draft_id: "draft".into(),
                draft_revision: 1
            }
        )
        .unwrap_err()
        .to_string()
        .contains("already bound"));
}

#[test]
fn builder_selection_exact_concurrent_replays_and_scope_replays_remain_safe() {
    let (_temp, store, start, _) = fixture();
    let gate = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let store = store.clone();
            let gate = gate.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                gate.wait();
                store.prepare_builder_start(decode(start)).unwrap()
            })
        })
        .collect();
    gate.wait();
    let receipts: Vec<_> = workers.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(receipts[0], receipts[1]);
    let receipt = &receipts[0];
    let id = receipt["bundle"]["operation"]["id"].as_str().unwrap();
    assert_eq!(
        store
            .bind_builder_scope(id, decode(receipt["scope"]["request"].clone()))
            .unwrap(),
        receipt["scope"]
    );
    let mut changed = start;
    changed["operation"]["worker"]["session_id"] = json!("changed-worker");
    assert!(store
        .prepare_builder_start(decode(changed))
        .unwrap_err()
        .to_string()
        .contains("identity conflict"));
    assert_eq!(store.budget("creation").unwrap()["budget"]["reserved"], 10);
}

#[test]
fn builder_selection_unclaimed_legacy_stop_is_not_safe_abandonment() {
    let (_temp, store, start, selected) = fixture();
    let started = store.prepare_builder_start(decode(start)).unwrap();
    let op = &started["bundle"]["operation"];
    store.command_operation(op["id"].as_str().unwrap(), decode(json!({"attempt":op["attempt"],"epoch":op["epoch"],"expected_revision":op["revision"],"action":{"kind":"cancel"}})), now()).unwrap();
    store.db.lock().execute("UPDATE workbench_documents SET value=json_remove(value,'$.selection_snapshot') WHERE key LIKE 'builder-scope:%'", []).unwrap();
    assert_eq!(
        store.builder_selection("draft").unwrap()["runtime_binding"]["state"],
        "started_or_occupied"
    );
    assert!(store
        .save_builder_selection(
            "draft",
            decode(selection_change(&selected, "profile_id", json!("other")))
        )
        .unwrap_err()
        .to_string()
        .contains("selection locked"));
}

#[test]
fn builder_selection_legacy_multiple_scopes_report_conflict_without_arbitrary_identity() {
    let (_temp, store, start, selected) = fixture();
    store.prepare_builder_start(decode(start.clone())).unwrap();
    let other = store
        .prepare_granted_operation(
            "owner",
            "legacy",
            decode(json!({"node_id":"local","session_id":"legacy-worker"})),
            true,
            false,
            true,
        )
        .unwrap();
    // Fixture simulates pre-upgrade duplicate scope data, not a permitted new API write.
    let scope = json!({"operation_id":other.id,"request":{"attempt":other.attempt,"draft_id":"draft"},"worker":other.worker});
    store
        .db
        .lock()
        .execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                format!("builder-scope:{}", json!([other.id, other.attempt])),
                scope.to_string()
            ],
        )
        .unwrap();
    let binding = store.builder_selection("draft").unwrap()["runtime_binding"].clone();
    assert_eq!(
        binding,
        json!({"state":"legacy_conflict","reason":"multiple_builder_bindings","binding_count":2})
    );
    assert!(store
        .save_builder_selection(
            "draft",
            decode(selection_change(&selected, "profile_id", json!("other")))
        )
        .unwrap_err()
        .to_string()
        .contains("multiple_builder_bindings"));
    let mut next = start;
    next["operation"]["request_key"] = json!("new-start");
    assert!(store
        .prepare_builder_start(decode(next))
        .unwrap_err()
        .to_string()
        .contains("multiple_builder_bindings"));
}

#[test]
fn builder_selection_races_start_without_mixed_runtime_identity() {
    for _ in 0..8 {
        let (_temp, store, mut start, selected) = fixture();
        let draft = store.builder_draft("draft").unwrap().unwrap();
        store.save_builder_draft(decode(json!({"id":"draft","request_id":"initialize","expected_revision":1,"revoked":false,"interview":draft["interview"]}))).unwrap();
        start["draft_revision"] = json!(2);
        start["selection_ref"] = json!({"revision":1,"draft_revision":1,"provider":"provider"});
        let mut change = selection_change(&selected, "profile_id", json!("other"));
        change["draft_revision"] = json!(2);
        let gate = Arc::new(Barrier::new(3));
        let a = {
            let store = store.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait();
                store.prepare_builder_start(decode(start))
            })
        };
        let b = {
            let store = store.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait();
                store.save_builder_selection("draft", decode(change))
            })
        };
        gate.wait();
        let (a, b) = (a.join().unwrap(), b.join().unwrap());
        assert_ne!(a.is_ok(), b.is_ok());
        let read = store.builder_selection("draft").unwrap();
        if a.is_ok() {
            assert_eq!(read["record"]["selection"]["profile_id"], "profile");
        } else {
            assert!(read["runtime_binding"].is_null());
        }
    }
}
