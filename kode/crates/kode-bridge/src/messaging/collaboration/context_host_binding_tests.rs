//! Original claim/renew transactions on temporary Stores; no simulated Active rows.
use super::control_tests::{bind_input, prepare, ready};
use super::*;
use crate::messaging::{
    coordinator_context_host_binding::{Bind, Revoke},
    model::now,
    operations::{Action, Command, Operation, State},
    resource_admission::Acknowledgement,
    runtime_host_enrollment::{Challenge, Register as HostRegister},
};

pub(super) fn setup() -> (tempfile::TempDir, Store, Bind, Operation) {
    let (dir, store, _, context) = ready();
    let bundle = prepare(&store, &format!("context-{}", context.key), "claim-real");
    store
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
    let op = store
        .operation(bundle["operation"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    let bind = Bind {
        request_id: "freeze-host".into(),
        context_key: context.key,
        expected_control_revision: 1,
        enrollment_id: enrollment["enrollment"]["id"].as_str().unwrap().into(),
        expected_enrollment_revision: 1,
        expected_operation_revision: op.revision,
        expected_binding_revision: 0,
    };
    (dir, store, bind, op)
}
pub(super) fn command(op: &Operation, renew: bool) -> Command {
    let p = op.resource.as_ref().unwrap();
    let resource = Acknowledgement {
        profile: p.profile.clone(),
        account_epoch: p.account_epoch,
        binding_revision: p.binding_revision,
    };
    Command {
        attempt: op.attempt,
        epoch: op.epoch,
        expected_revision: op.revision,
        selection_ack: op.selection_policy.clone(),
        action: if renew {
            Action::RenewResource {
                lease_ms: 30_000,
                resource,
            }
        } else {
            Action::ClaimResource {
                lease_ms: 30_000,
                resource,
            }
        },
    }
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
fn scoped_host_binding_real_original_claim_renew_and_legacy_begin_rejected() {
    let (_dir, store, bind, prepared) = setup();
    assert!(store
        .command_operation(&prepared.id, command(&prepared, false), now())
        .is_err());
    let frozen = store.bind_context_host(bind.clone()).unwrap();
    assert_eq!(
        frozen["frozen"]["manifest"],
        json!({"profile":"conversation_reply_v1","version":1,"tools":[]})
    );
    assert_eq!(frozen["claim_allowed"], false);
    let active = store
        .command_operation(&prepared.id, command(&prepared, false), now())
        .unwrap()
        .operation;
    assert_eq!(active.state, State::Active);
    assert!(active.revision > prepared.revision);
    let renewed = store
        .command_operation(&active.id, command(&active, true), now())
        .unwrap()
        .operation;
    assert_eq!(renewed.state, State::Active);
    assert!(renewed.revision > active.revision);
    assert!(store
        .command_operation(&active.id, command(&active, true), now())
        .is_err());
    assert_eq!(
        store.bind_context_host(bind.clone()).unwrap()["frozen"],
        frozen["frozen"]
    );
    let begin=serde_json::from_value(json!({"call_id":"legacy-begin","operation_id":active.id,"attempt":active.attempt,"epoch":active.epoch,
        "worker_session":active.worker.session_id,"provider":"fixture-provider","model":"fixture-model"})).unwrap();
    assert_eq!(
        store
            .begin_official_call(begin, now())
            .unwrap_err()
            .to_string(),
        "scoped conversation call provenance not ready"
    );
    let legacy = prepare(&store, "legacy-session", "legacy-claim");
    let legacy = store
        .operation(legacy["operation"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        store
            .command_operation(&legacy.id, command(&legacy, false), now())
            .unwrap()
            .operation
            .state,
        State::Active
    );
}
#[test]
fn scoped_host_binding_revoke_conflict_and_response_loss_are_durable() {
    let (dir, store, bind, op) = setup();
    let first = store.bind_context_host(bind.clone()).unwrap();
    let before = rows(&store);
    assert_eq!(
        store.bind_context_host(bind.clone()).unwrap()["binding_id"],
        first["binding_id"]
    );
    assert_eq!(rows(&store), before);
    let mut changed = bind.clone();
    changed.request_id = "different".into();
    assert!(store.bind_context_host(changed).is_err());
    let revoke = Revoke {
        request_id: "revoke".into(),
        binding_id: first["binding_id"].as_str().unwrap().into(),
        expected_revision: 1,
    };
    store
        .revoke_context_host(&bind.context_key, revoke.clone())
        .unwrap();
    assert_eq!(
        store
            .revoke_context_host(&bind.context_key, revoke)
            .unwrap()["state"],
        "revoked"
    );
    assert_eq!(
        store.bind_context_host(bind.clone()).unwrap()["state"],
        "revoked"
    );
    assert!(store
        .command_operation(&op.id, command(&op, false), now())
        .is_err());
    drop(store);
    let store = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
    assert_eq!(store.bind_context_host(bind).unwrap()["state"], "revoked");
    assert!(store
        .command_operation(&op.id, command(&op, false), now())
        .is_err());
}
#[test]
fn scoped_host_binding_revocation_or_scope_change_blocks_actual_renew() {
    for field in ["host", "scope", "grant", "resource", "budget", "manifest"] {
        let (_dir, store, bind, op) = setup();
        store.bind_context_host(bind.clone()).unwrap();
        let active = store
            .command_operation(&op.id, command(&op, false), now())
            .unwrap()
            .operation;
        if field == "host" {
            store
                .revoke_runtime_host(crate::messaging::runtime_host_enrollment::Revoke {
                    request_id: "revoke-host".into(),
                    enrollment_id: bind.enrollment_id,
                    expected_revision: 1,
                })
                .unwrap();
        } else {
            let db = store.db.lock();
            let sql=match field {
                "scope"=>"UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false'))",
                "grant"=>"DELETE FROM workbench_documents WHERE key LIKE 'operation-grant:%'",
                "resource"=>"UPDATE resource_accounts SET enabled=0",
                "budget"=>"DELETE FROM operation_budget_bindings",
                "manifest"=>"UPDATE workbench_documents SET value=json_set(value,'$.frozen.manifest.tools',json('[\"forged\"]')) WHERE key LIKE 'coordinator-context-host-binding-v2:%'",
                _=>unreachable!(),
            };
            db.execute(sql, []).unwrap();
        }
        assert!(
            store
                .command_operation(&active.id, command(&active, true), now())
                .is_err(),
            "{field}"
        );
    }
}
#[test]
fn scoped_host_binding_insert_and_revoke_receipt_failures_roll_back() {
    let (_dir, store, bind, op) = setup();
    let before = rows(&store);
    store.db.lock().execute_batch("CREATE TEMP TRIGGER fail_binding BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE 'coordinator-context-host-binding-v2:%' BEGIN SELECT RAISE(ABORT,'binding failpoint'); END;").unwrap();
    assert!(store.bind_context_host(bind.clone()).is_err());
    assert_eq!(rows(&store), before);
    assert!(store
        .command_operation(&op.id, command(&op, false), now())
        .is_err());
    store
        .db
        .lock()
        .execute_batch("DROP TRIGGER fail_binding")
        .unwrap();
    let first = store.bind_context_host(bind.clone()).unwrap();
    let before = rows(&store);
    store.db.lock().execute_batch("CREATE TEMP TRIGGER fail_revoke BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE 'coordinator-context-host-revoke-v2:%' BEGIN SELECT RAISE(ABORT,'revoke failpoint'); END;").unwrap();
    assert!(store
        .revoke_context_host(
            &bind.context_key,
            Revoke {
                request_id: "revoke".into(),
                binding_id: first["binding_id"].as_str().unwrap().into(),
                expected_revision: 1
            }
        )
        .is_err());
    assert_eq!(rows(&store), before);
    assert_eq!(
        store
            .command_operation(&op.id, command(&op, false), now())
            .unwrap()
            .operation
            .state,
        State::Active
    );
}
