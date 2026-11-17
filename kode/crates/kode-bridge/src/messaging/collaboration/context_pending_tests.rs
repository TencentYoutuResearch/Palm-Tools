use super::*;
use crate::messaging::coordinator_context_inbox::{Finish, Outcome};
use crate::messaging::coordinator_context_tools::{
    self as tools, Invocation, Issue, Stage, Target,
};

#[test]
fn scoped_pending_counts_transitions_and_preserves_legacy() {
    let (_dir, store, key, _, claim) = super::inbox_tests::setup();
    store.db.lock().execute("INSERT INTO workbench_documents(key,revision,value) VALUES ('coordinator-control:legacy',1,'{\"canary\":\"unchanged\"}')", []).unwrap();
    let before = store.document("coordinator-control:legacy").unwrap();
    let read = || {
        store
            .context_pending(&key, &claim.operation_id, &claim.journal_id)
            .unwrap()
    };
    assert_eq!(read().pending, 1);
    assert!(!read().is_drained());
    assert!(store
        .context_pending(&key, "wrong-operation", &claim.journal_id)
        .is_err());
    assert!(store
        .context_pending(&key, &claim.operation_id, "wrong-journal")
        .is_err());
    let result = store.claim_context_input(&key, claim.clone()).unwrap();
    assert_eq!(read().claimed, 1);
    store
        .finish_context_input(
            &key,
            Finish {
                request_id: "uncertain".into(),
                entry_id: claim.entry_id,
                claim_id: result["receipt"]["entry"]["claim_id"]
                    .as_str()
                    .unwrap()
                    .into(),
                operation_id: claim.operation_id.clone(),
                journal_id: claim.journal_id.clone(),
                outcome: Outcome::Uncertain,
                reply: None,
            },
        )
        .unwrap();
    assert_eq!(read().uncertain, 1);
    assert!(!read().is_drained());
    assert_eq!(
        store.document("coordinator-control:legacy").unwrap(),
        before
    );
}

#[test]
fn scoped_pending_completed_input_does_not_hide_staged_outbox() {
    let (_dir, store, key, _, claim) = super::inbox_tests::setup();
    let result = store.claim_context_input(&key, claim.clone()).unwrap();
    let claim_id = result["receipt"]["entry"]["claim_id"]
        .as_str()
        .unwrap()
        .to_string();
    let grant = store
        .issue_context_tool_grant(
            &key,
            Issue {
                request_id: "grant".into(),
                entry_id: claim.entry_id.clone(),
                claim_id: claim_id.clone(),
                target: Target::PublishReply,
            },
        )
        .unwrap();
    let args = json!({"text":"PRIVATE_REPLY_CANARY"});
    let mut invocation = Invocation {
        request_id: String::new(),
        session_id: format!("context-{key}"),
        journal_id: claim.journal_id.clone(),
        source_receipt_id: claim.entry_id.clone(),
        tool_call_seq: 1,
        tool_call_id: "call".into(),
        tool_name: "publish_reply".into(),
        arguments_sha256: tools::hash(&args),
    };
    invocation.request_id = tools::request_id(&invocation);
    store
        .stage_context_tool(
            &key,
            Stage {
                grant_id: grant["grant"]["grant_id"].as_str().unwrap().into(),
                invocation,
                schema_hash: grant["grant"]["schema_hash"].as_str().unwrap().into(),
                implementation_id: tools::IMPLEMENTATION.into(),
                args,
            },
        )
        .unwrap();
    store
        .finish_context_input(
            &key,
            Finish {
                request_id: "completed".into(),
                entry_id: claim.entry_id,
                claim_id,
                operation_id: claim.operation_id.clone(),
                journal_id: claim.journal_id.clone(),
                outcome: Outcome::Completed,
                reply: Some("done".into()),
            },
        )
        .unwrap();
    let pending = store
        .context_pending(&key, &claim.operation_id, &claim.journal_id)
        .unwrap();
    assert_eq!(pending.completed, 1);
    assert_eq!(pending.unconsumed_tool_outbox, 1);
    assert!(!pending.is_drained());
    assert!(!serde_json::to_string(&pending).unwrap().contains("CANARY"));
    store.db.lock().execute("UPDATE workbench_documents SET value=json_set(value,'$.state','future_consumed') WHERE key LIKE 'coordinator-context-tool-outbox-v2:%'", []).unwrap();
    assert!(store
        .context_pending(&key, &claim.operation_id, &claim.journal_id)
        .is_err());
}

#[test]
fn scoped_pending_unknown_or_wrongly_bound_inbox_fails_closed() {
    for (field, value) in [
        ("state", "future_state"),
        ("operation_id", "wrong"),
        ("journal_id", "wrong"),
    ] {
        let (_dir, store, key, _, claim) = super::inbox_tests::setup();
        store
            .db
            .lock()
            .execute(
                "UPDATE workbench_documents SET value=json_set(value,?1,?2) WHERE key=?3",
                rusqlite::params![
                    format!("$.{field}"),
                    value,
                    format!("coordinator-context-inbox-v2:{key}:{}", claim.entry_id)
                ],
            )
            .unwrap();
        assert!(store
            .context_pending(&key, &claim.operation_id, &claim.journal_id)
            .is_err());
    }
}
