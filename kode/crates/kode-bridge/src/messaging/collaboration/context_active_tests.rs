//! Simulated Active ledger inspections, NOT successful scoped claim/runtime tests.
use super::control_tests::{bind_input, prepare, ready};
use super::*;
use crate::messaging::{
    coordinator_context_active::Check,
    model::now,
    operations::{Operation, State},
    runtime_host_enrollment::{Challenge, Register as HostRegister, Revoke},
};

fn save_mock(store: &Store, op: &Operation) {
    let mut db = store.db.lock();
    let tx = db.transaction().unwrap();
    crate::messaging::operations::save(
        &tx,
        op,
        json!({"kind":"test_only_simulated_active_ledger","operation":op}),
    )
    .unwrap();
    tx.commit().unwrap();
}
fn simulated_active_ledger() -> (tempfile::TempDir, Store, Check) {
    let (dir, store, _, context) = ready();
    let bundle = prepare(
        &store,
        &format!("context-{}", context.key),
        "inspect-active",
    );
    let control = store
        .bind_context_coordinator_control(&context.key, bind_input(&bundle))
        .unwrap();
    let challenge = store
        .challenge_runtime_host(Challenge {
            request_id: "host-challenge".into(),
            host_id: "home".into(),
            boot_id: "boot".into(),
            protocol_version: 1,
        })
        .unwrap();
    let enrollment = store
        .register_runtime_host(HostRegister {
            request_id: "host-register".into(),
            challenge_id: challenge["challenge_id"].as_str().unwrap().into(),
            nonce: challenge["nonce"].as_str().unwrap().into(),
            host_id: "home".into(),
            boot_id: "boot".into(),
            protocol_version: 1,
        })
        .unwrap();
    let mut op = store
        .operation(control["request"]["operation_id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    op.state = State::Active;
    op.revision += 1;
    op.lease_until = Some(now() + 30_000);
    save_mock(&store, &op);
    let check = Check {
        context_key: context.key,
        control_revision: 1,
        operation_id: op.id,
        current_operation_revision: op.revision,
        attempt: op.attempt,
        epoch: op.epoch,
        owner: op.owner,
        session_id: op.worker.session_id,
        journal_id: control["journal_id"].as_str().unwrap().into(),
        enrollment_id: enrollment["enrollment"]["id"].as_str().unwrap().into(),
        boot_id: "boot".into(),
    };
    (dir, store, check)
}

#[test]
fn scoped_active_inspection_simulated_renew_changes_only_lease_not_identity() {
    let (_dir, store, mut check) = simulated_active_ledger();
    let before: f64 = store
        .db
        .lock()
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    let first = store.inspect_active_context(check.clone()).unwrap();
    assert_eq!(first["execution_authorized"], false);
    assert_eq!(first["runtime_ready"], false);
    assert_eq!(first["host_scope_attested"], false);
    assert!(first["identity"]
        .get("current_operation_revision")
        .is_none());
    assert_eq!(
        store
            .db
            .lock()
            .query_row("SELECT total_changes()", [], |r| r.get::<_, f64>(0))
            .unwrap(),
        before
    );
    let mut op = store.operation(&check.operation_id).unwrap().unwrap();
    assert_eq!(
        crate::messaging::coordinator_control::lease_gate(&store.db.lock(), &op, now())
            .unwrap_err()
            .to_string(),
        "scoped Coordinator runtime not ready"
    );
    op.revision += 1;
    op.lease_until = Some(now() + 40_000);
    save_mock(&store, &op);
    assert!(store.inspect_active_context(check.clone()).is_err());
    check.current_operation_revision = op.revision;
    let second = store.inspect_active_context(check.clone()).unwrap();
    assert_eq!(first["identity"], second["identity"]);
    assert_ne!(
        first["lease_observation"]["revision"],
        second["lease_observation"]["revision"]
    );
    assert_ne!(
        first["lease_observation"]["expires_at"],
        second["lease_observation"]["expires_at"]
    );
    assert_eq!(
        store
            .context_coordinator_control(&check.context_key)
            .unwrap()
            .unwrap()["request"]["operation_revision"],
        first["identity"]["initial_operation_revision"]
    );
}

#[test]
fn scoped_active_inspection_rejects_prepared_expired_and_changed_identity() {
    for field in [
        "state",
        "expiry",
        "owner",
        "attempt",
        "epoch",
        "worker",
        "initial_revision",
    ] {
        let (_dir, store, mut check) = simulated_active_ledger();
        let mut op = store.operation(&check.operation_id).unwrap().unwrap();
        match field {
            "state" => op.state = State::Prepared,
            "expiry" => op.lease_until = Some(now() - 1),
            "owner" => {
                op.owner = "changed-owner".into();
                check.owner = op.owner.clone();
            }
            "attempt" => {
                op.attempt += 1;
                check.attempt = op.attempt;
            }
            "epoch" => {
                op.epoch += 1;
                check.epoch = op.epoch;
            }
            "worker" => {
                op.worker.session_id = "other-session".into();
                check.session_id = op.worker.session_id.clone();
            }
            "initial_revision" => {
                op.revision -= 1;
                check.current_operation_revision = op.revision;
            }
            _ => unreachable!(),
        }
        save_mock(&store, &op);
        assert!(store.inspect_active_context(check).is_err(), "{field}");
    }
}

#[test]
fn scoped_active_inspection_rechecks_policy_origin_enrollment_and_fences() {
    for field in [
        "scope",
        "audience",
        "grant",
        "budget",
        "resource",
        "journal",
        "fence",
        "origin",
        "host_revoke",
        "unknown_enrollment",
        "boot",
        "selection",
    ] {
        let (_dir, store, mut check) = simulated_active_ledger();
        assert!(store.inspect_active_context(check.clone()).is_ok());
        if field == "host_revoke" {
            store
                .revoke_runtime_host(Revoke {
                    request_id: "revoke".into(),
                    enrollment_id: check.enrollment_id.clone(),
                    expected_revision: 1,
                })
                .unwrap();
        } else if field == "unknown_enrollment" {
            check.enrollment_id = "self-reported".into();
        } else if field == "boot" {
            check.boot_id = "self-reported-boot".into();
        } else {
            let db = store.db.lock();
            match field {
                "scope" => {
                    db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false'))",[]).unwrap();
                }
                "audience" => {
                    db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.audience_revision',2)",[]).unwrap();
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
                "journal" => {
                    db.execute("UPDATE workbench_documents SET value=json_set(value,'$.journal_id','changed') WHERE key LIKE 'coordinator-context-control-v2:%'",[]).unwrap();
                }
                "fence" => {
                    db.execute(
                        "DELETE FROM workbench_documents WHERE key LIKE 'coordinator-operation:%'",
                        [],
                    )
                    .unwrap();
                }
                "origin" => {
                    db.execute("UPDATE workbench_documents SET value=json_set(value,'$.scope.target.root','/other') WHERE key LIKE 'operation-grant:%'",[]).unwrap();
                }
                "selection" => {
                    db.execute("INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",rusqlite::params![check.operation_id,json!({"kind":"selection_evidence","evidence":{"attempt":check.attempt,"epoch":check.epoch},"rejected":true}).to_string()]).unwrap();
                }
                _ => unreachable!(),
            }
        }
        assert!(store.inspect_active_context(check).is_err(), "{field}");
    }
}

#[test]
fn scoped_active_inspection_rejects_body_readiness_and_preserves_legacy_admit() {
    let (_dir, store, check) = simulated_active_ledger();
    let mut raw = serde_json::to_value(&check).unwrap();
    raw["ready"] = json!(true);
    assert!(serde_json::from_value::<Check>(raw).is_err());
    let mut raw = serde_json::to_value(&check).unwrap();
    raw["enrollment"] = json!({"status":"active"});
    assert!(serde_json::from_value::<Check>(raw).is_err());
    let bundle = prepare(&store, "legacy-worker", "legacy-operation");
    let op = store
        .operation(bundle["operation"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert!(crate::messaging::operation_grant::admit(&store.db.lock(), &op, now()).is_ok());
}
