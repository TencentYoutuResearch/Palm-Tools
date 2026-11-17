//! Prepared-only inbox transitions using real policies and temporary local Stores.
use super::control_tests::{bind_input, prepare, ready};
use super::*;
use crate::messaging::{
    coordinator_context_inbox::{Claim, Enqueue, Finish, Outcome},
    coordinator_context_input::RecordInput,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn enqueue() -> Enqueue {
    Enqueue {
        request_id: "enqueue".into(),
        input_request_id: "exact-input".into(),
    }
}
pub(super) fn setup() -> (tempfile::TempDir, Store, String, Value, Claim) {
    let (dir, store, request, context) = ready();
    let bundle = prepare(
        &store,
        &format!("context-{}", context.key),
        "inbox-operation",
    );
    let control = store
        .bind_context_coordinator_control(&context.key, bind_input(&bundle))
        .unwrap();
    let message = store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "exact-message".into(),
                expected_revision: 1,
                thread_id: Some(request.thread_id),
                content: "EXACT_NEW_INPUT_CANARY".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    store
        .record_context_input(
            &context.key,
            RecordInput {
                request_id: "exact-input".into(),
                source_message_id: message["id"].as_str().unwrap().into(),
                expected_content_sha256: format!("{:x}", Sha256::digest(b"EXACT_NEW_INPUT_CANARY")),
                explicitly_continue_stored: false,
            },
        )
        .unwrap();
    let entry = store
        .enqueue_context_input(&context.key, enqueue())
        .unwrap();
    let claim = Claim {
        request_id: "claim".into(),
        entry_id: entry["entry"]["id"].as_str().unwrap().into(),
        operation_id: control["request"]["operation_id"].as_str().unwrap().into(),
        journal_id: control["journal_id"].as_str().unwrap().into(),
    };
    (dir, store, context.key, entry, claim)
}
fn finish(claim: &Claim, result: &Value, outcome: Outcome) -> Finish {
    Finish {
        request_id: "finish".into(),
        entry_id: claim.entry_id.clone(),
        claim_id: result["receipt"]["entry"]["claim_id"]
            .as_str()
            .unwrap()
            .into(),
        operation_id: claim.operation_id.clone(),
        journal_id: claim.journal_id.clone(),
        reply: if outcome == Outcome::Completed {
            Some("Scoped reply only".into())
        } else {
            None
        },
        outcome,
    }
}

#[test]
fn scoped_inbox_exact_source_claim_and_completion_stay_bound_and_not_runtime_ready() {
    let (_dir, store, key, entry, claim) = setup();
    let authority = store.context_inbox_authority(&key).unwrap();
    assert_eq!(authority["context_key"], key);
    assert_eq!(authority["journal_id"], claim.journal_id);
    assert_eq!(authority["session_id"], format!("context-{key}"));
    assert_eq!(authority["origin"]["root_ref"], "/fixture/project");
    assert_eq!(authority["team_revision"], 2);
    assert_eq!(authority["audience_revision"], 1);
    assert_eq!(authority["runtime_ready"], false);
    assert_eq!(authority["stage"], "prepared_only");
    // Staging inspection is not a replacement for the unchanged runtime gate.
    let operation = store.operation(&claim.operation_id).unwrap().unwrap();
    assert_eq!(
        crate::messaging::operation_grant::admit(
            &store.db.lock(),
            &operation,
            crate::messaging::model::now()
        )
        .unwrap_err()
        .to_string(),
        "scoped Coordinator runtime not ready"
    );
    let pending = store.pending_context_inputs(&key, 25).unwrap();
    assert_eq!(pending["items"].as_array().unwrap().len(), 1);
    assert!(!pending.to_string().contains("EXACT_NEW_INPUT_CANARY"));
    let claimed = store.claim_context_input(&key, claim.clone()).unwrap();
    assert_eq!(claimed["new_claim"], true);
    assert_eq!(claimed["dispatch_allowed"], false);
    assert_eq!(claimed["message"]["content"], "EXACT_NEW_INPUT_CANARY");
    assert!(!claimed.to_string().contains("Fresh discussion"));
    assert!(store.pending_context_inputs(&key, 25).unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    let replay = store.claim_context_input(&key, claim.clone()).unwrap();
    assert_eq!(replay["new_claim"], false);
    assert!(replay.get("message").is_none());
    let complete = finish(&claim, &claimed, Outcome::Completed);
    let result = store.finish_context_input(&key, complete.clone()).unwrap();
    assert_eq!(result["entry"]["state"], "completed");
    assert_eq!(result["entry"]["reply"], "Scoped reply only");
    assert_eq!(
        result["entry"]["source_message_id"],
        entry["entry"]["source_message_id"]
    );
    assert_eq!(store.finish_context_input(&key, complete).unwrap(), result);
    assert_eq!(
        store.context_inbox_entry(&key, &claim.entry_id).unwrap(),
        result
    );
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
        db.query_row(
            "SELECT count(*) FROM collaboration_coordinator_replies",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(db.query_row("SELECT count(*) FROM workbench_documents WHERE key LIKE 'coordinator-context-inbox%' AND value LIKE '%EXACT_NEW_INPUT_CANARY%'",[],|r|r.get::<_,u64>(0)).unwrap(),0);
}

#[test]
fn scoped_inbox_uncertain_and_lost_claim_survive_restart_without_automatic_replay() {
    for settle in [false, true] {
        let (dir, store, key, _, claim) = setup();
        let claimed = store.claim_context_input(&key, claim.clone()).unwrap();
        if settle {
            store
                .finish_context_input(&key, finish(&claim, &claimed, Outcome::Uncertain))
                .unwrap();
        }
        drop(store);
        let store = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
        assert!(store.pending_context_inputs(&key, 25).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        let replay = store.claim_context_input(&key, claim.clone()).unwrap();
        assert_eq!(replay["new_claim"], false);
        assert!(replay.get("message").is_none());
        let mut retry = claim.clone();
        retry.request_id = "retry-different".into();
        assert!(store.claim_context_input(&key, retry).is_err());
        if settle {
            assert!(store
                .finish_context_input(&key, finish(&claim, &claimed, Outcome::Completed))
                .is_err());
        }
        assert_eq!(
            store.context_inbox_entry(&key, &claim.entry_id).unwrap()["entry"]["state"],
            if settle { "uncertain" } else { "claimed" }
        );
    }
}

#[test]
fn scoped_inbox_enqueue_deduplicates_exact_source_and_command_conflicts() {
    let (_dir, store, key, entry, claim) = setup();
    assert_eq!(store.enqueue_context_input(&key, enqueue()).unwrap(), entry);
    let mut duplicate = enqueue();
    duplicate.request_id = "another-enqueue".into();
    assert!(store.enqueue_context_input(&key, duplicate).is_err());
    let mut conflict = enqueue();
    conflict.input_request_id = "different-input".into();
    assert!(store
        .enqueue_context_input(&key, conflict)
        .unwrap_err()
        .to_string()
        .contains("identity conflict"));
    let mut wrong = claim.clone();
    wrong.operation_id = "wrong-operation".into();
    assert!(store.claim_context_input(&key, wrong).is_err());
    let mut wrong = claim.clone();
    wrong.journal_id = "wrong-journal".into();
    assert!(store.claim_context_input(&key, wrong).is_err());
    let claimed = store.claim_context_input(&key, claim.clone()).unwrap();
    let mut wrong = finish(&claim, &claimed, Outcome::Completed);
    wrong.claim_id = "wrong-claim".into();
    assert!(store.finish_context_input(&key, wrong).is_err());
    let complete = finish(&claim, &claimed, Outcome::Completed);
    store.finish_context_input(&key, complete.clone()).unwrap();
    let mut changed = complete;
    changed.reply = Some("Changed reply".into());
    assert!(store
        .finish_context_input(&key, changed)
        .unwrap_err()
        .to_string()
        .contains("identity conflict"));
}

#[test]
fn scoped_inbox_simultaneous_claims_have_exactly_one_fresh_delivery() {
    let (_dir, store, key, _, claim) = setup();
    let store = std::sync::Arc::new(store);
    let threads = (0..4)
        .map(|i| {
            let store = store.clone();
            let key = key.clone();
            let mut input = claim.clone();
            input.request_id = format!("claim-{i}");
            std::thread::spawn(move || store.claim_context_input(&key, input))
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results.into_iter().find_map(|r| r.ok()).unwrap()["new_claim"],
        true
    );
}

#[test]
fn scoped_inbox_dispatch_rechecks_live_authority_before_claim_and_reads() {
    for field in [
        "scope",
        "grant",
        "budget",
        "resource",
        "control",
        "operation_fence",
        "operation_revision",
        "operation_state",
        "source_hash",
        "source_fence",
    ] {
        let (_dir, store, key, entry, claim) = setup();
        let db = store.db.lock();
        match field {
            "scope" => {
                db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false'))",[]).unwrap();
            }
            "grant" => {
                db.execute(
                    "DELETE FROM workbench_documents WHERE key LIKE 'operation-grant:%'",
                    [],
                )
                .unwrap();
            }
            "budget" => {
                db.execute("DELETE FROM operation_budget_bindings", [])
                    .unwrap();
            }
            "resource" => {
                db.execute("UPDATE resource_accounts SET enabled=0", [])
                    .unwrap();
            }
            "control" => {
                db.execute("UPDATE workbench_documents SET value=json_set(value,'$.journal_id','changed') WHERE key LIKE 'coordinator-context-control-v2:%'",[]).unwrap();
            }
            "operation_fence" => {
                db.execute(
                    "DELETE FROM workbench_documents WHERE key LIKE 'coordinator-operation:%'",
                    [],
                )
                .unwrap();
            }
            "operation_revision" => {
                db.execute(
                    "UPDATE operations SET body=json_set(body,'$.revision',2)",
                    [],
                )
                .unwrap();
            }
            "operation_state" => {
                db.execute(
                    "UPDATE operations SET body=json_set(body,'$.state','active')",
                    [],
                )
                .unwrap();
            }
            "source_hash" => {
                db.execute("UPDATE collaboration_messages SET body=json_set(body,'$.content','Changed') WHERE id=?1",[entry["entry"]["source_message_id"].as_str().unwrap()]).unwrap();
            }
            _ => {
                db.execute("DELETE FROM workbench_documents WHERE key LIKE 'coordinator-context-source-v2:%'",[]).unwrap();
            }
        }
        drop(db);
        assert!(
            store.claim_context_input(&key, claim.clone()).is_err(),
            "claim {field}"
        );
        assert!(
            store.pending_context_inputs(&key, 25).is_err(),
            "pending {field}"
        );
        assert!(
            store.enqueue_context_input(&key, enqueue()).is_err(),
            "retry {field}"
        );
    }
}

#[test]
fn scoped_inbox_revoked_finish_preserves_claim_for_future_reconciliation() {
    let (_dir, store, key, _, claim) = setup();
    let claimed = store.claim_context_input(&key, claim.clone()).unwrap();
    store
        .db
        .lock()
        .execute("DELETE FROM operation_budget_bindings", [])
        .unwrap();
    assert!(store
        .finish_context_input(&key, finish(&claim, &claimed, Outcome::Completed))
        .is_err());
    let state:String=store.db.lock().query_row("SELECT json_extract(value,'$.state') FROM workbench_documents WHERE key LIKE 'coordinator-context-inbox-v2:%'",[],|r|r.get(0)).unwrap();
    assert_eq!(state, "claimed");
}

#[test]
fn scoped_inbox_cross_context_entry_and_claim_are_rejected() {
    let (_dir, store, key, entry, claim) = setup();
    let message = store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "other-thread".into(),
                expected_revision: 1,
                thread_id: None,
                content: "Unrelated thread".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let context = store
        .register_coordinator_context(Register {
            request_id: "other-context".into(),
            surface_id: "channel".into(),
            thread_id: message["id"].as_str().unwrap().into(),
            team_id: "team".into(),
            team_revision: 2,
            audience_revision: 1,
        })
        .unwrap();
    let bundle = prepare(
        &store,
        &format!("context-{}", context.key),
        "other-operation",
    );
    let control = store
        .bind_context_coordinator_control(&context.key, bind_input(&bundle))
        .unwrap();
    assert!(store
        .context_inbox_entry(&context.key, entry["entry"]["id"].as_str().unwrap())
        .is_err());
    let mut crossed = claim.clone();
    crossed.operation_id = control["request"]["operation_id"].as_str().unwrap().into();
    crossed.journal_id = control["journal_id"].as_str().unwrap().into();
    assert!(store.claim_context_input(&context.key, crossed).is_err());
    assert_eq!(
        store.context_inbox_entry(&key, &claim.entry_id).unwrap()["entry"]["state"],
        "pending"
    );
}

#[test]
fn scoped_inbox_claim_and_finish_receipt_failures_roll_back_state_atomically() {
    let (_dir, store, key, _, claim) = setup();
    store.db.lock().execute_batch("CREATE TEMP TRIGGER reject_claim_receipt BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE 'coordinator-context-inbox-command-v2:%' AND json_extract(NEW.value,'$.request.kind')='claim' BEGIN SELECT RAISE(ABORT,'claim receipt failure'); END;").unwrap();
    assert!(store
        .claim_context_input(&key, claim.clone())
        .unwrap_err()
        .to_string()
        .contains("claim receipt failure"));
    assert_eq!(
        store.context_inbox_entry(&key, &claim.entry_id).unwrap()["entry"]["state"],
        "pending"
    );
    store
        .db
        .lock()
        .execute_batch("DROP TRIGGER reject_claim_receipt")
        .unwrap();
    let claimed = store.claim_context_input(&key, claim.clone()).unwrap();
    let command = finish(&claim, &claimed, Outcome::Completed);
    store.db.lock().execute_batch("CREATE TEMP TRIGGER reject_finish_receipt BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE 'coordinator-context-inbox-command-v2:%' AND json_extract(NEW.value,'$.request.kind')='finish' BEGIN SELECT RAISE(ABORT,'finish receipt failure'); END;").unwrap();
    assert!(store
        .finish_context_input(&key, command.clone())
        .unwrap_err()
        .to_string()
        .contains("finish receipt failure"));
    assert_eq!(
        store.context_inbox_entry(&key, &claim.entry_id).unwrap()["entry"]["state"],
        "claimed"
    );
    store
        .db
        .lock()
        .execute_batch("DROP TRIGGER reject_finish_receipt")
        .unwrap();
    assert_eq!(
        store.finish_context_input(&key, command).unwrap()["entry"]["state"],
        "completed"
    );
}
