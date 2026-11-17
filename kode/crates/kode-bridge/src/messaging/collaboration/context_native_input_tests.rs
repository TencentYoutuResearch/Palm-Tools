//! Real Store claim/accounting/publication, fictional observations; no Native CLI.
use super::*;
use crate::messaging::{
    coordinator_context_native_input::{Begin, Finish, Outcome},
    model::now,
};
use sha2::{Digest, Sha256};
fn setup() -> (
    tempfile::TempDir,
    Store,
    Begin,
    crate::messaging::official_calls::Begin,
    String,
) {
    let (d, s, p, h) = super::call_tests::setup();
    let proof = p
        .prompt_provenance
        .as_ref()
        .unwrap()
        .scoped_call
        .as_ref()
        .unwrap();
    let request = format!(
        "native:{:x}",
        Sha256::digest(
            json!([
                "native-turn-v1",
                proof.session_id,
                proof.journal_id,
                proof.entry_id,
                proof.claim_id
            ])
            .to_string()
            .as_bytes()
        )
    );
    let b = Begin {
        request_id: request,
        host_binding_id: proof.host_binding_id.clone(),
        context_key: proof.context_key.clone(),
        session_id: proof.session_id.clone(),
        journal_id: proof.journal_id.clone(),
        entry_id: proof.entry_id.clone(),
        claim_id: proof.claim_id.clone(),
        source_message_id: proof.source_message_id.clone(),
        source_content_sha256: proof.source_content_sha256.clone(),
        manifest_sha256: proof.manifest_sha256.clone(),
    };
    (d, s, b, p, h)
}
#[test]
fn scoped_native_single_source_replay_conflict_and_provider_fence() {
    let (_d, s, b, p, _) = setup();
    for field in [
        "host_binding_id",
        "source_message_id",
        "source_content_sha256",
        "manifest_sha256",
    ] {
        let mut wire = serde_json::to_value(&b).unwrap();
        wire[field] = json!("wrong");
        assert!(
            s.begin_native_context_input(serde_json::from_value(wire).unwrap())
                .is_err(),
            "{field}"
        );
    }
    let mut wire = serde_json::to_value(&b).unwrap();
    wire["ready"] = json!(true);
    assert!(serde_json::from_value::<Begin>(wire).is_err());
    let first = s.begin_native_context_input(b.clone()).unwrap();
    assert_eq!(first["dispatch_allowed"], true);
    let status = s
        .native_context_request_status(&b.context_key, &b.request_id)
        .unwrap();
    assert_eq!(status["admission_id"], first["admission_id"]);
    assert_eq!(status["dispatch_allowed"], false);
    assert_eq!(
        s.native_context_request_status(&b.context_key, "missing")
            .unwrap()["state"],
        "not_found"
    );
    assert_eq!(
        s.begin_native_context_input(b.clone()).unwrap()["dispatch_allowed"],
        false
    );
    assert!(s.begin_official_call(p, now()).is_err());
    let mut changed = b.clone();
    changed.source_content_sha256 = "b".repeat(64);
    assert!(s.begin_native_context_input(changed).is_err());
    let id = first["admission_id"].as_str().unwrap();
    assert!(s.native_context_input_status("wrong", id).is_err());
    let f = Finish {
        request_id: "uncertain".into(),
        admission_id: id.into(),
        outcome: Outcome::Uncertain {
            reason: "lost driver response".into(),
        },
    };
    assert_eq!(
        s.finish_native_context_input(&b.context_key, f.clone())
            .unwrap()["state"],
        "uncertain"
    );
    assert_eq!(
        s.finish_native_context_input(&b.context_key, f).unwrap()["dispatch_allowed"],
        false
    );
    assert!(s.publish_native_context_reply(&b.context_key, id).is_err());
}
#[test]
fn scoped_native_admission_atomic_failure_and_revocation() {
    let (_d, s, b, _, h) = setup();
    s.db.lock().execute_batch("CREATE TEMP TRIGGER reject_native BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE 'coordinator-context-native-id-v2:%' BEGIN SELECT RAISE(ABORT,'native failpoint'); END;").unwrap();
    assert!(s.begin_native_context_input(b.clone()).is_err());
    let count:u64=s.db.lock().query_row("SELECT count(*) FROM workbench_documents WHERE key LIKE 'coordinator-context-call-source-v2:%'",[],|r|r.get(0)).unwrap();
    assert_eq!(count, 0);
    s.db.lock()
        .execute_batch("DROP TRIGGER reject_native")
        .unwrap();
    s.revoke_runtime_host(crate::messaging::runtime_host_enrollment::Revoke {
        request_id: "revoke".into(),
        enrollment_id: h,
        expected_revision: 1,
    })
    .unwrap();
    assert!(s.begin_native_context_input(b).is_err());
}
#[test]
fn scoped_native_reported_usage_and_exact_reply_commit_once() {
    let (_d, s, b, p, _) = setup();
    let admitted = s.begin_native_context_input(b.clone()).unwrap();
    let id = admitted["admission_id"].as_str().unwrap();
    let op = s.operation(&p.operation_id).unwrap().unwrap();
    let policy = op.selection_policy.as_ref().unwrap();
    let observation = |value: Option<String>| crate::messaging::selection_evidence::Observation {
        requested: value.clone(),
        status: if value.is_some() {
            crate::messaging::selection_evidence::Status::Reported
        } else {
            crate::messaging::selection_evidence::Status::Unverifiable
        },
        observed: value,
        source: Some("fictional-native-observation".into()),
    };
    s.record_selection_evidence(crate::messaging::selection_evidence::Evidence {
        record_id: "selection".into(),
        operation_id: op.id.clone(),
        worker_session: op.worker.session_id.clone(),
        attempt: op.attempt,
        epoch: op.epoch,
        profile_revision: policy.profile_revision.clone(),
        thread_id: "native-thread".into(),
        turn_id: "native-turn".into(),
        input_ids: vec![b.entry_id.clone()],
        scope: policy.scope.clone(),
        observed_at: now(),
        model: observation(Some(policy.model.clone())),
        effort: observation(policy.effort.clone()),
        rejected: false,
    })
    .unwrap();
    let reservation:String=s.db.lock().query_row("SELECT reservation_id FROM operation_budget_bindings WHERE operation_id=?1 AND attempt=?2",rusqlite::params![op.id,op.attempt],|r|r.get(0)).unwrap();
    let revision: u64 =
        s.db.lock()
            .query_row(
                "SELECT json_extract(body,'$.revision') FROM budget_reservations WHERE id=?1",
                [&reservation],
                |r| r.get(0),
            )
            .unwrap();
    s.record_usage(
        crate::messaging::pricing::Usage {
            attribution: crate::messaging::pricing::Attribution::RequestedModel {
                rerouted: false,
                cache_write_input_tokens: 0,
            },
            event_id: "native-meter".into(),
            reservation_id: reservation,
            expected_revision: revision,
            model: policy.model.clone(),
            input_tokens: 100,
            output_tokens: 10,
            cached_input_tokens: 0,
        },
        now(),
    )
    .unwrap();
    let mut cmd = super::host_binding_tests::command(&op, true);
    cmd.action = crate::messaging::operations::Action::Report {
        report_id: "native-report".into(),
        content: "completed fixture turn".into(),
    };
    assert!(s.command_operation(&op.id, cmd, now()).unwrap().applied);
    let finish = Finish {
        request_id: "finish".into(),
        admission_id: id.into(),
        outcome: Outcome::Completed {
            usage_event_id: "native-meter".into(),
            text: "exact scope answer".into(),
        },
    };
    let missing = Finish {
        request_id: "missing".into(),
        admission_id: id.into(),
        outcome: Outcome::Completed {
            usage_event_id: "not-a-receipt".into(),
            text: "not accepted".into(),
        },
    };
    assert!(s
        .finish_native_context_input(&b.context_key, missing)
        .is_err());
    s.db.lock().execute_batch("CREATE TEMP TRIGGER reject_native_finish BEFORE UPDATE ON workbench_documents WHEN NEW.key LIKE 'coordinator-context-native-id-v2:%' BEGIN SELECT RAISE(ABORT,'finish failpoint'); END;").unwrap();
    assert!(s
        .finish_native_context_input(&b.context_key, finish.clone())
        .is_err());
    assert_eq!(
        s.native_context_input_status(&b.context_key, id).unwrap()["state"],
        "admitted"
    );
    s.db.lock()
        .execute_batch("DROP TRIGGER reject_native_finish")
        .unwrap();
    s.finish_native_context_input(&b.context_key, finish.clone())
        .unwrap();
    s.db.lock().execute_batch("CREATE TEMP TRIGGER reject_native_reply BEFORE INSERT ON collaboration_messages WHEN NEW.kind='superagent_reply' BEGIN SELECT RAISE(ABORT,'reply failpoint'); END;").unwrap();
    assert!(s.publish_native_context_reply(&b.context_key, id).is_err());
    assert_eq!(
        s.native_context_input_status(&b.context_key, id).unwrap()["state"],
        "outbox"
    );
    s.db.lock()
        .execute_batch("DROP TRIGGER reject_native_reply")
        .unwrap();
    let result = s.publish_native_context_reply(&b.context_key, id).unwrap();
    assert_eq!(result["new_publication"], true);
    assert_eq!(
        s.publish_native_context_reply(&b.context_key, id).unwrap()["new_publication"],
        false
    );
    assert_eq!(
        s.finish_native_context_input(&b.context_key, finish)
            .unwrap()["state"],
        "published"
    );
    let count:u64=s.db.lock().query_row("SELECT count(*) FROM collaboration_messages WHERE kind='superagent_reply' AND json_extract(body,'$.source_message_id')=?1",[&b.source_message_id],|r|r.get(0)).unwrap();
    assert_eq!(count, 1);
}
