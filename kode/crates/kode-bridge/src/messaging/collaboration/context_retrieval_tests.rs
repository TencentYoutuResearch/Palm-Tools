//! Explicit summary approvals tested against fictional private messages only.
use super::*;
use crate::messaging::coordinator_context_retrieval::ApproveSummary;
use sha2::{Digest, Sha256};

const PRIVATE: &str = "PRIVATE_CANARY_DO_NOT_COPY hidden credentials discussion";
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn summary_fixture(cross_team: bool) -> (tempfile::TempDir, Store, ApproveSummary) {
    let (dir, store, mut source) = fixture("dm", Kind::Dm);
    let message = store
        .send_collaboration_message(
            "dm",
            Send {
                interactive_selection: None,
                request_id: "private-root".into(),
                expected_revision: 1,
                thread_id: None,
                content: PRIVATE.into(),
                mentions: vec![],
            },
        )
        .unwrap();
    source.thread_id = message["id"].as_str().unwrap().into();
    let source = store.register_coordinator_context(source).unwrap();
    let team = if cross_team { "other-team" } else { "team" };
    if cross_team {
        let spec = store.team("team", None).unwrap().unwrap()["spec"].clone();
        store
            .save_team(teams::Save {
                id: team.into(),
                request_id: "other-team".into(),
                expected_revision: 0,
                spec: serde_json::from_value(spec).unwrap(),
            })
            .unwrap();
    }
    store
        .change_collaboration_surface(
            "destination",
            SurfaceChange {
                request_id: "target-surface".into(),
                expected_revision: 0,
                scope: Scope {
                    home_hub: "home".into(),
                    host_id: "home".into(),
                    workspace_id: "workspace".into(),
                    root_ref: "/fixture/project".into(),
                },
                kind: Kind::Channel,
                title: "Destination".into(),
                team_ids: vec![team.into()],
                enabled: true,
            },
        )
        .unwrap();
    let message = store
        .send_collaboration_message(
            "destination",
            Send {
                interactive_selection: None,
                request_id: "target-root".into(),
                expected_revision: 1,
                thread_id: None,
                content: "Target context".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let target = store
        .register_coordinator_context(Register {
            request_id: "target-context".into(),
            surface_id: "destination".into(),
            thread_id: message["id"].as_str().unwrap().into(),
            team_id: team.into(),
            team_revision: 1,
            audience_revision: 1,
        })
        .unwrap();
    let summary = "Owner approved sharing: a review is needed.";
    let input = ApproveSummary {
        request_id: "approve-summary".into(),
        source_context_key: source.key,
        target_context_key: target.key,
        source_message_id: source.thread_id,
        expected_source_content_sha256: hash(PRIVATE),
        expected_target_audience_revision: 1,
        summary: summary.into(),
        summary_sha256: hash(summary),
    };
    (dir, store, input)
}

#[test]
fn context_summary_requires_approval_and_returns_only_exact_summary_for_target() {
    for cross_team in [false, true] {
        let (_dir, store, input) = summary_fixture(cross_team);
        assert!(store
            .approved_context_summary(&input.target_context_key, &input.request_id)
            .is_err());
        let result = store.approve_context_summary(input.clone()).unwrap();
        assert_eq!(result["summary"], input.summary);
        assert_eq!(
            result["source_reference"]["message_id"],
            input.source_message_id
        );
        assert_eq!(result["execution_authorized"], false);
        assert_eq!(
            store
                .approved_context_summary(&input.target_context_key, &input.request_id)
                .unwrap(),
            result
        );
        assert!(store
            .approved_context_summary(&input.source_context_key, &input.request_id)
            .is_err());
        assert!(!result.to_string().contains(PRIVATE));
        for field in [
            "content",
            "message",
            "thread_context",
            "source_scope",
            "source_thread",
            "history",
        ] {
            assert!(result.get(field).is_none(), "unexpected {field}");
        }
        let db = store.db.lock();
        let receipt:String=db.query_row("SELECT value FROM workbench_documents WHERE key LIKE 'coordinator-context-summary-v2:%'",[],|r|r.get(0)).unwrap();
        assert!(!receipt.contains(PRIVATE));
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
    }
}

#[test]
fn context_summary_approval_is_idempotent_durable_and_conflict_checked() {
    let (dir, store, input) = summary_fixture(true);
    let result = store.approve_context_summary(input.clone()).unwrap();
    assert_eq!(
        store.approve_context_summary(input.clone()).unwrap(),
        result
    );
    for field in ["summary", "target", "source", "hash", "audience"] {
        let mut changed = input.clone();
        match field {
            "summary" => {
                changed.summary = "Changed approval".into();
                changed.summary_sha256 = hash(&changed.summary);
            }
            "target" => changed.target_context_key = changed.source_context_key.clone(),
            "source" => changed.source_message_id = "unrelated".into(),
            "hash" => changed.expected_source_content_sha256 = "a".repeat(64),
            _ => changed.expected_target_audience_revision = 2,
        }
        assert!(store.approve_context_summary(changed).is_err(), "{field}");
    }
    drop(store);
    let store = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
    assert_eq!(
        store
            .approved_context_summary(&input.target_context_key, &input.request_id)
            .unwrap(),
        result
    );
    assert_eq!(store.approve_context_summary(input).unwrap(), result);
}

#[test]
fn context_summary_exact_target_cannot_be_replaced_by_another_valid_context() {
    let (_dir, store, input) = summary_fixture(true);
    store.approve_context_summary(input.clone()).unwrap();
    let message = store
        .send_collaboration_message(
            "destination",
            Send {
                interactive_selection: None,
                request_id: "other-target-root".into(),
                expected_revision: 1,
                thread_id: None,
                content: "Another legitimate target".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let target = store
        .register_coordinator_context(Register {
            request_id: "another-target".into(),
            surface_id: "destination".into(),
            thread_id: message["id"].as_str().unwrap().into(),
            team_id: "other-team".into(),
            team_revision: 1,
            audience_revision: 1,
        })
        .unwrap();
    assert!(store
        .approved_context_summary(&target.key, &input.request_id)
        .is_err());
    let mut retargeted = input;
    retargeted.target_context_key = target.key;
    assert!(store
        .approve_context_summary(retargeted)
        .unwrap_err()
        .to_string()
        .contains("identity conflict"));
}

#[test]
fn context_summary_source_and_destination_revocation_are_rechecked_on_read_and_retry() {
    for surface in ["dm", "destination"] {
        for field in ["enabled", "audience", "membership", "team_revision"] {
            let (_dir, store, input) = summary_fixture(true);
            store.approve_context_summary(input.clone()).unwrap();
            let db = store.db.lock();
            match field {
                "enabled" => {
                    db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false')) WHERE id=?1",[surface]).unwrap();
                }
                "audience" => {
                    db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.audience_revision',2) WHERE id=?1",[surface]).unwrap();
                }
                "membership" => {
                    db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.team_ids',json('[]')) WHERE id=?1",[surface]).unwrap();
                }
                _ => {
                    db.execute("UPDATE team_revisions SET body=json_set(body,'$.revision',2) WHERE team_id=?1",[if surface=="dm" {"team"} else {"other-team"}]).unwrap();
                }
            }
            drop(db);
            assert!(
                store
                    .approved_context_summary(&input.target_context_key, &input.request_id)
                    .is_err(),
                "{surface}/{field}"
            );
            assert!(
                store.approve_context_summary(input).is_err(),
                "{surface}/{field}"
            );
        }
    }
}

#[test]
fn context_summary_source_changes_missing_message_and_workspace_revoke_access() {
    for field in ["content", "actor", "kind", "thread", "workspace", "deleted"] {
        let (_dir, store, input) = summary_fixture(false);
        store.approve_context_summary(input.clone()).unwrap();
        let db = store.db.lock();
        match field {
            "content" => {
                db.execute("UPDATE collaboration_messages SET body=json_set(body,'$.content','changed') WHERE id=?1",[&input.source_message_id]).unwrap();
            }
            "actor" => {
                db.execute("UPDATE collaboration_messages SET body=json_set(body,'$.actor.id','other') WHERE id=?1",[&input.source_message_id]).unwrap();
            }
            "kind" => {
                db.execute(
                    "UPDATE collaboration_messages SET kind='task' WHERE id=?1",
                    [&input.source_message_id],
                )
                .unwrap();
            }
            "thread" => {
                db.execute(
                    "UPDATE collaboration_messages SET thread_id='other' WHERE id=?1",
                    [&input.source_message_id],
                )
                .unwrap();
            }
            "workspace" => {
                db.execute("UPDATE workbench_documents SET value=json_set(value,'$.tables.workspaces.workspace.path','/fixture/moved') WHERE key='workspaces'",[]).unwrap();
            }
            _ => {
                db.execute(
                    "DELETE FROM collaboration_messages WHERE id=?1",
                    [&input.source_message_id],
                )
                .unwrap();
            }
        }
        drop(db);
        assert!(
            store
                .approved_context_summary(&input.target_context_key, &input.request_id)
                .is_err(),
            "{field}"
        );
        assert!(store.approve_context_summary(input).is_err(), "{field}");
    }
}

#[test]
fn context_summary_invalid_or_unapproved_data_never_creates_receipt() {
    let (_dir, store, input) = summary_fixture(false);
    for field in [
        "summary_hash",
        "empty",
        "long",
        "same_scope",
        "unknown_source",
        "unknown_target",
    ] {
        let mut changed = input.clone();
        match field {
            "summary_hash" => changed.summary_sha256 = "a".repeat(64),
            "empty" => {
                changed.summary.clear();
                changed.summary_sha256 = hash("");
            }
            "long" => {
                changed.summary = "x".repeat(16385);
                changed.summary_sha256 = hash(&changed.summary);
            }
            "same_scope" => changed.target_context_key = changed.source_context_key.clone(),
            "unknown_source" => changed.source_context_key = "b".repeat(64),
            _ => changed.target_context_key = "b".repeat(64),
        }
        assert!(store.approve_context_summary(changed).is_err(), "{field}");
    }
    assert_eq!(store.db.lock().query_row("SELECT count(*) FROM workbench_documents WHERE key LIKE 'coordinator-context-summary-v2:%'",[],|r|r.get::<_,u64>(0)).unwrap(),0);
    let mut wire = serde_json::to_value(input).unwrap();
    wire["all_history"] = json!(true);
    assert!(serde_json::from_value::<ApproveSummary>(wire).is_err());
}

#[test]
fn context_summary_title_changes_do_not_expand_or_revoke_exact_audience_approval() {
    let (_dir, store, input) = summary_fixture(false);
    let result = store.approve_context_summary(input.clone()).unwrap();
    store.db.lock().execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.title','Renamed','$.revision',2) WHERE id='destination'",[]).unwrap();
    assert_eq!(
        store
            .approved_context_summary(&input.target_context_key, &input.request_id)
            .unwrap(),
        result
    );
}
