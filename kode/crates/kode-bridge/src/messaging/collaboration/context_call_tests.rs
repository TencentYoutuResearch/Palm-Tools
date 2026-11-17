//! Provider compatibility only. Native drivers retain their own original usage path.
use super::*;
use crate::messaging::{
    coordinator_context_host_binding::Bind,
    model::now,
    official_calls::{Begin, Counters, Evidence, Kind},
    runtime_host_enrollment::{Challenge, Register as HostRegister, Revoke},
};
use sha2::{Digest, Sha256};

pub(super) fn setup() -> (tempfile::TempDir, Store, Begin, String) {
    let (dir, store, key, _, claim) = super::inbox_tests::setup();
    let claimed = store.claim_context_input(&key, claim.clone()).unwrap();
    let challenge = store
        .challenge_runtime_host(Challenge {
            request_id: "challenge".into(),
            host_id: "home".into(),
            boot_id: "boot".into(),
            protocol_version: 1,
        })
        .unwrap();
    let host = store
        .register_runtime_host(HostRegister {
            request_id: "register".into(),
            challenge_id: challenge["challenge_id"].as_str().unwrap().into(),
            nonce: challenge["nonce"].as_str().unwrap().into(),
            host_id: "home".into(),
            boot_id: "boot".into(),
            protocol_version: 1,
        })
        .unwrap();
    let host_id = host["enrollment"]["id"].as_str().unwrap().to_string();
    let op = store.operation(&claim.operation_id).unwrap().unwrap();
    let binding = store
        .bind_context_host(Bind {
            request_id: "bind".into(),
            context_key: key.clone(),
            expected_control_revision: 1,
            enrollment_id: host_id.clone(),
            expected_enrollment_revision: 1,
            expected_operation_revision: op.revision,
            expected_binding_revision: 0,
        })
        .unwrap();
    let op = store
        .command_operation(
            &op.id,
            super::host_binding_tests::command(&op, false),
            now(),
        )
        .unwrap()
        .operation;
    let source = &claimed["receipt"]["entry"];
    let proof = json!({"schema_version":1,"profile_id":"conversation_reply_v1","host_binding_id":binding["binding_id"],
        "context_key":key,"session_id":op.worker.session_id,"journal_id":claim.journal_id,"entry_id":claim.entry_id,
        "claim_id":source["claim_id"],"source_message_id":source["source_message_id"],"source_content_sha256":source["source_content_sha256"],
        "request_sha256":format!("{:x}",Sha256::digest(b"fictional owned provider request")),
        "tools_sha256":format!("{:x}",Sha256::digest(b"[]")),"manifest_sha256":binding["frozen"]["manifest_sha256"]});
    let begin=serde_json::from_value(json!({"call_id":"provider-call","operation_id":op.id,"attempt":op.attempt,"epoch":op.epoch,
        "worker_session":op.worker.session_id,"provider":"fixture-provider","model":"fixture-model",
        "prompt_provenance":{"schema_version":1,"source":"official_prepared_input","system_sha256":"a".repeat(64),"system_messages":1,
            "instruction":{"role":"coordinator","version":"conversation_reply_v1","sha256":"a".repeat(64)},"scoped_call":proof}})).unwrap();
    (dir, store, begin, host_id)
}
#[test]
fn scoped_conversation_call_provider_compatibility_has_one_admission_and_original_accounting() {
    let (_dir, store, begin, host) = setup();
    let first = store.begin_official_call(begin.clone(), now()).unwrap();
    assert!(!first.duplicate);
    assert!(first.call.accounting.is_some());
    assert!(
        store
            .begin_official_call(begin.clone(), now())
            .unwrap()
            .duplicate
    );
    let mut again = begin.clone();
    again.call_id = "another-call".into();
    assert!(store.begin_official_call(again, now()).is_err());
    store
        .revoke_runtime_host(Revoke {
            request_id: "revoke".into(),
            enrollment_id: host,
            expected_revision: 1,
        })
        .unwrap();
    let event = Evidence {
        sequence: 1,
        kind: Kind::Usage,
        usage: Some(Counters {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 0,
            cache_write_input_tokens: 0,
        }),
        reason: "fixture-usage".into(),
    };
    assert_eq!(
        store
            .record_official_call(&begin.call_id, event.clone())
            .unwrap()
            .call
            .accounting_status,
        "estimated_pending_reconciliation"
    );
    assert!(
        store
            .record_official_call(&begin.call_id, event.clone())
            .unwrap()
            .duplicate
    );
    let mut finished = event;
    finished.sequence = 2;
    finished.kind = Kind::Finished;
    assert_eq!(
        store
            .record_official_call(&begin.call_id, finished)
            .unwrap()
            .call
            .state,
        "finished"
    );
    assert!(store.begin_official_call(begin, now()).unwrap().duplicate);
}
#[test]
fn scoped_conversation_call_rejects_cross_source_manifest_models_and_legacy_envelope() {
    let (_dir, store, begin, _) = setup();
    for field in [
        "host_binding_id",
        "context_key",
        "session_id",
        "journal_id",
        "entry_id",
        "claim_id",
        "source_message_id",
        "source_content_sha256",
        "tools_sha256",
        "manifest_sha256",
    ] {
        let mut wire = serde_json::to_value(&begin).unwrap();
        wire["prompt_provenance"]["scoped_call"][field] =
            json!(if field.ends_with("sha256") || field == "context_key" {
                "b".repeat(64)
            } else {
                "wrong".into()
            });
        assert!(
            store
                .begin_official_call(serde_json::from_value(wire).unwrap(), now())
                .is_err(),
            "{field}"
        );
    }
    for field in ["provider", "model"] {
        let mut wire = serde_json::to_value(&begin).unwrap();
        wire[field] = json!("another-provider-or-model");
        assert!(store
            .begin_official_call(serde_json::from_value(wire).unwrap(), now())
            .is_err());
    }
    let mut old = begin.clone();
    old.prompt_provenance = None;
    assert_eq!(
        store
            .begin_official_call(old, now())
            .unwrap_err()
            .to_string(),
        "scoped conversation call provenance not ready"
    );
    assert!(!store.begin_official_call(begin, now()).unwrap().duplicate);
}
#[test]
fn scoped_conversation_call_fence_and_original_call_commit_atomically() {
    let (_dir, store, begin, _) = setup();
    store.db.lock().execute_batch("CREATE TEMP TRIGGER reject_call BEFORE INSERT ON official_calls BEGIN SELECT RAISE(ABORT,'call failpoint'); END;").unwrap();
    assert!(store.begin_official_call(begin.clone(), now()).is_err());
    let count:u64=store.db.lock().query_row("SELECT count(*) FROM workbench_documents WHERE key LIKE 'coordinator-context-call-source-v2:%'",[],|r|r.get(0)).unwrap();
    assert_eq!(count, 0);
    store
        .db
        .lock()
        .execute_batch("DROP TRIGGER reject_call")
        .unwrap();
    assert!(!store.begin_official_call(begin, now()).unwrap().duplicate);
}
