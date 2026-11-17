//! Server-owned staging grants and atomic outbox tests, with no runtime consumer.
use super::*;
use crate::messaging::coordinator_context_inbox::{Finish, Outcome};
use crate::messaging::coordinator_context_retrieval::ApproveSummary;
use crate::messaging::coordinator_context_tools::{
    self as tools, Invocation, Issue, Stage, Target,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn setup() -> (tempfile::TempDir, Store, String, Value, Issue) {
    let (dir, store, key, _, claim) = super::inbox_tests::setup();
    let claimed = store.claim_context_input(&key, claim.clone()).unwrap();
    let issue = Issue {
        request_id: "issue-reply".into(),
        entry_id: claim.entry_id,
        claim_id: claimed["receipt"]["entry"]["claim_id"]
            .as_str()
            .unwrap()
            .into(),
        target: Target::PublishReply,
    };
    let grant = store.issue_context_tool_grant(&key, issue.clone()).unwrap();
    (dir, store, key, grant, issue)
}
fn invocation(grant: &Value, args: Value, seq: u64) -> Stage {
    let grant = &grant["grant"];
    let mut invocation = Invocation {
        request_id: String::new(),
        session_id: grant["authority"]["session_id"].as_str().unwrap().into(),
        journal_id: grant["authority"]["journal_id"].as_str().unwrap().into(),
        source_receipt_id: grant["issue"]["entry_id"].as_str().unwrap().into(),
        tool_call_seq: seq,
        tool_call_id: "model-call-label".into(),
        tool_name: grant["action"].as_str().unwrap().into(),
        arguments_sha256: tools::hash(&args),
    };
    invocation.request_id = tools::request_id(&invocation);
    Stage {
        grant_id: grant["grant_id"].as_str().unwrap().into(),
        invocation,
        schema_hash: grant["schema_hash"].as_str().unwrap().into(),
        implementation_id: tools::IMPLEMENTATION.into(),
        args,
    }
}
fn count(store: &Store, prefix: &str) -> u64 {
    store
        .db
        .lock()
        .query_row(
            "SELECT count(*) FROM workbench_documents WHERE substr(key,1,length(?1))=?1",
            [prefix],
            |r| r.get(0),
        )
        .unwrap()
}
fn raw_hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn summary_grant(store: &Store, key: &str, issue: &Issue) -> Value {
    let message = store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "private-summary-source".into(),
                expected_revision: 1,
                thread_id: None,
                content: "PRIVATE_RAW_CANARY_never_return".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let source = store
        .register_coordinator_context(Register {
            request_id: "summary-source-context".into(),
            surface_id: "channel".into(),
            thread_id: message["id"].as_str().unwrap().into(),
            team_id: "team".into(),
            team_revision: 2,
            audience_revision: 1,
        })
        .unwrap();
    store
        .approve_context_summary(ApproveSummary {
            request_id: "owner-approval".into(),
            source_context_key: source.key,
            target_context_key: key.into(),
            source_message_id: source.thread_id,
            expected_source_content_sha256: raw_hash("PRIVATE_RAW_CANARY_never_return"),
            expected_target_audience_revision: 1,
            summary: "Precisely approved summary".into(),
            summary_sha256: raw_hash("Precisely approved summary"),
        })
        .unwrap();
    let mut input = issue.clone();
    input.request_id = "issue-summary".into();
    input.target = Target::ReadApprovedSummary {
        approval_request_id: "owner-approval".into(),
    };
    store.issue_context_tool_grant(key, input).unwrap()
}

#[test]
fn scoped_tools_schema_and_host_request_hash_match_js_golden() {
    assert_eq!(
        tools::hash(&tools::schema(&Target::ReadApprovedSummary {
            approval_request_id: "approval".into()
        })),
        "d746974fa9afd5e951f76f9af38954b0ad7f436f2120dc974da65e5ee39f856f"
    );
    assert_eq!(
        tools::hash(&tools::schema(&Target::PublishReply)),
        "6f5f0d5caccdf94104b372c7c60367b8e621eda0b93033f4fb6dd26a6734fb91"
    );
    assert_eq!(
        tools::hash(&json!({"text":"hello"})),
        "cbbbdcd27692344de5dbab3abcaba413fb0f45307267de7081401576df1cb176"
    );
    let inv = Invocation {
        request_id: String::new(),
        session_id: "context-fixture".into(),
        journal_id: "journal".into(),
        source_receipt_id: "entry".into(),
        tool_call_seq: 3,
        tool_call_id: "untrusted".into(),
        tool_name: "publish_reply".into(),
        arguments_sha256: String::new(),
    };
    assert_eq!(
        tools::request_id(&inv),
        "tool:780d9a83615463ba4c578ed589c79d065ea432c872200e7220ce0fbc27a1b6ed"
    );
    assert_eq!(
        tools::canonical(&json!({"b":[{"z":1,"a":2}],"a":"x"})),
        "{\"a\":\"x\",\"b\":[{\"a\":2,\"z\":1}]}"
    );
}

#[test]
fn scoped_tools_reply_outbox_is_atomic_source_bound_and_response_loss_is_read_only() {
    let (dir, store, key, grant, issue) = setup();
    assert_eq!(store.issue_context_tool_grant(&key, issue).unwrap(), grant);
    let input = invocation(
        &grant,
        json!({"text":"Reply only to this original thread"}),
        1,
    );
    let result = store.stage_context_tool(&key, input.clone()).unwrap();
    assert_eq!(result["status"], "staging_outbox");
    assert_eq!(result["runtime_ready"], false);
    assert!(result.get("published").is_none());
    assert_eq!(
        result["data"]["target"]["source_message_id"],
        grant["grant"]["source"]["source_message_id"]
    );
    assert_eq!(
        result["data"]["target"]["thread_id"],
        grant["grant"]["authority"]["thread_id"]
    );
    let replay = store.stage_context_tool(&key, input.clone()).unwrap();
    assert_eq!(replay["status"], "already_recorded");
    assert_eq!(replay["status_read_required"], true);
    assert!(replay.get("data").is_none());
    assert_eq!(count(&store, "coordinator-context-tool-outbox-v2:"), 1);
    assert_eq!(count(&store, "coordinator-context-tool-receipt-v2:"), 1);
    assert_eq!(
        store
            .db
            .lock()
            .query_row("SELECT count(*) FROM collaboration_messages", [], |r| r
                .get::<_, u64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        store
            .db
            .lock()
            .query_row(
                "SELECT count(*) FROM collaboration_coordinator_replies",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
    drop(store);
    let store = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
    let changes = store
        .db
        .lock()
        .query_row("SELECT total_changes()", [], |r| r.get::<_, u64>(0))
        .unwrap();
    assert_eq!(
        store
            .context_tool_status(&key, &input.grant_id, &input.invocation.request_id)
            .unwrap(),
        result
    );
    assert_eq!(
        store
            .db
            .lock()
            .query_row("SELECT total_changes()", [], |r| r.get::<_, u64>(0))
            .unwrap(),
        changes
    );
}

#[test]
fn scoped_tools_summary_returns_only_approved_text_and_rechecks_private_source() {
    let (_dir, store, key, _, issue) = setup();
    let grant = summary_grant(&store, &key, &issue);
    let input = invocation(&grant, json!({}), 1);
    let result = store.stage_context_tool(&key, input.clone()).unwrap();
    assert_eq!(result["status"], "staged_summary");
    assert_eq!(result["data"]["summary"], "Precisely approved summary");
    assert!(!result.to_string().contains("PRIVATE_RAW_CANARY"));
    assert_eq!(count(&store, "coordinator-context-tool-outbox-v2:"), 0);
    let source = grant["grant"]["target"]["source_reference"]["message_id"]
        .as_str()
        .unwrap();
    store.db.lock().execute("UPDATE collaboration_messages SET body=json_set(body,'$.content','changed') WHERE id=?1",[source]).unwrap();
    assert!(store
        .context_tool_status(&key, &input.grant_id, &input.invocation.request_id)
        .is_err());
    assert!(store.stage_context_tool(&key, input).is_err());
}

#[test]
fn scoped_tools_reject_schema_source_implementation_and_model_authority_attacks() {
    let (_dir, store, key, grant, _) = setup();
    for field in [
        "grant",
        "schema",
        "implementation",
        "source",
        "session",
        "journal",
        "seq",
        "request",
        "name",
        "args_hash",
        "model_target",
        "model_request",
    ] {
        let mut input = invocation(&grant, json!({"text":"Reply"}), 1);
        match field {
            "grant" => input.grant_id = "client-signed-manifest".into(),
            "schema" => input.schema_hash = "a".repeat(64),
            "implementation" => input.implementation_id = "arbitrary-implementation".into(),
            "source" => input.invocation.source_receipt_id = "other-entry".into(),
            "session" => input.invocation.session_id = "other-session".into(),
            "journal" => input.invocation.journal_id = "other-journal".into(),
            "seq" => input.invocation.tool_call_seq = 0,
            "request" => input.invocation.request_id = "model-picked-request".into(),
            "name" => input.invocation.tool_name = "read_approved_summary".into(),
            "args_hash" => input.invocation.arguments_sha256 = "a".repeat(64),
            "model_target" => {
                input.args["target"] = json!("other-thread");
                input.invocation.arguments_sha256 = tools::hash(&input.args);
            }
            _ => {
                input.args["request_id"] = json!("model-picked");
                input.invocation.arguments_sha256 = tools::hash(&input.args);
            }
        }
        if ["source", "session", "journal", "seq"].contains(&field) {
            input.invocation.request_id = tools::request_id(&input.invocation);
        }
        assert!(store.stage_context_tool(&key, input).is_err(), "{field}");
    }
    assert_eq!(count(&store, "coordinator-context-tool-receipt-v2:"), 0);
    assert_eq!(count(&store, "coordinator-context-tool-outbox-v2:"), 0);
    let mut wire = serde_json::to_value(invocation(&grant, json!({"text":"Reply"}), 1)).unwrap();
    wire["manifest"] = json!({"trusted":true});
    assert!(serde_json::from_value::<Stage>(wire).is_err());
}

#[test]
fn scoped_tools_same_host_call_changed_payload_conflicts_and_grants_are_single_use() {
    let (_dir, store, key, grant, issue) = setup();
    let input = invocation(&grant, json!({"text":"First reply"}), 7);
    store.stage_context_tool(&key, input.clone()).unwrap();
    let changed = invocation(&grant, json!({"text":"Changed reply"}), 7);
    assert!(store
        .stage_context_tool(&key, changed)
        .unwrap_err()
        .to_string()
        .contains("payload conflict"));
    assert!(store
        .stage_context_tool(&key, invocation(&grant, json!({"text":"First reply"}), 8))
        .is_err());
    let mut second = issue;
    second.request_id = "second-grant".into();
    let second = store.issue_context_tool_grant(&key, second).unwrap();
    assert!(store
        .stage_context_tool(
            &key,
            invocation(&second, json!({"text":"Another grant cannot duplicate"}), 9)
        )
        .unwrap_err()
        .to_string()
        .contains("already has a staged reply"));
    assert_eq!(count(&store, "coordinator-context-tool-outbox-v2:"), 1);
}

#[test]
fn scoped_tools_authority_and_exact_source_revocation_block_stage_and_status() {
    for field in ["audience", "grant", "source", "scope", "journal"] {
        let (_dir, store, key, grant, _) = setup();
        let input = invocation(&grant, json!({"text":"Reply"}), 1);
        store.stage_context_tool(&key, input.clone()).unwrap();
        let db = store.db.lock();
        match field {
            "audience" => {
                db.execute(
                    "UPDATE collaboration_surfaces SET body=json_set(body,'$.audience_revision',2)",
                    [],
                )
                .unwrap();
            }
            "grant" => {
                db.execute(
                    "DELETE FROM workbench_documents WHERE key LIKE 'operation-grant:%'",
                    [],
                )
                .unwrap();
            }
            "source" => {
                db.execute("UPDATE collaboration_messages SET body=json_set(body,'$.content','changed') WHERE id=?1",[grant["grant"]["source"]["source_message_id"].as_str().unwrap()]).unwrap();
            }
            "scope" => {
                db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false'))",[]).unwrap();
            }
            _ => {
                db.execute("UPDATE workbench_documents SET value=json_set(value,'$.journal_id','other') WHERE key LIKE 'coordinator-context-control-v2:%'",[]).unwrap();
            }
        }
        drop(db);
        assert!(
            store
                .context_tool_status(&key, &input.grant_id, &input.invocation.request_id)
                .is_err(),
            "{field}"
        );
        assert!(store.stage_context_tool(&key, input).is_err(), "{field}");
    }
}

#[test]
fn scoped_tools_outbox_receipt_and_usage_fence_failures_are_atomic() {
    for prefix in [
        "coordinator-context-tool-outbox-v2:",
        "coordinator-context-tool-receipt-v2:",
        "coordinator-context-tool-used-v2:",
    ] {
        let (_dir, store, key, grant, _) = setup();
        let input = invocation(&grant, json!({"text":"Reply"}), 1);
        store.db.lock().execute_batch(&format!("CREATE TEMP TRIGGER reject_stage BEFORE INSERT ON workbench_documents WHEN NEW.key LIKE '{prefix}%' BEGIN SELECT RAISE(ABORT,'stage failpoint'); END;")).unwrap();
        assert!(store
            .stage_context_tool(&key, input.clone())
            .unwrap_err()
            .to_string()
            .contains("stage failpoint"));
        for p in [
            "coordinator-context-tool-outbox-v2:",
            "coordinator-context-tool-receipt-v2:",
            "coordinator-context-tool-used-v2:",
            "coordinator-context-tool-reply-source-v2:",
        ] {
            assert_eq!(count(&store, p), 0, "{prefix}/{p}");
        }
        store
            .db
            .lock()
            .execute_batch("DROP TRIGGER reject_stage")
            .unwrap();
        assert_eq!(
            store.stage_context_tool(&key, input).unwrap()["status"],
            "staging_outbox"
        );
    }
}

#[test]
fn scoped_tools_settled_source_allows_status_only_and_cross_context_is_rejected() {
    let (_dir, store, key, grant, issue) = setup();
    let input = invocation(&grant, json!({"text":"Reply"}), 1);
    let result = store.stage_context_tool(&key, input.clone()).unwrap();
    assert!(store
        .context_tool_status(
            &"a".repeat(64),
            &input.grant_id,
            &input.invocation.request_id
        )
        .is_err());
    assert!(store
        .stage_context_tool(&"a".repeat(64), input.clone())
        .is_err());
    store
        .finish_context_input(
            &key,
            Finish {
                request_id: "settle".into(),
                entry_id: issue.entry_id,
                claim_id: issue.claim_id,
                operation_id: grant["grant"]["authority"]["operation_id"]
                    .as_str()
                    .unwrap()
                    .into(),
                journal_id: input.invocation.journal_id.clone(),
                outcome: Outcome::Completed,
                reply: Some("Scoped reply".into()),
            },
        )
        .unwrap();
    assert_eq!(
        store
            .context_tool_status(&key, &input.grant_id, &input.invocation.request_id)
            .unwrap(),
        result
    );
    assert!(store.stage_context_tool(&key, input).is_err());
}
