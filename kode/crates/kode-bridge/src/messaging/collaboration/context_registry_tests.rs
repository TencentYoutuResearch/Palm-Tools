use super::super::model::*;
use crate::messaging::{
    coordinator_context_registry::{self as registry, Register},
    coordinator_context_scope::Kind as ContextKind,
    store::Store,
    teams,
};
use serde_json::json;

fn fixture(surface_id: &str, kind: Kind) -> (tempfile::TempDir, Store, Register) {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(&root.path().join("store.sqlite"), "home").unwrap();
    store
        .save_document(
            "workspaces",
            0,
            json!({"version":2,"tables":{"workspaces":{
        "workspace":{"path":"/fixture/project"}}},"global":{"workspaceIds":["workspace"]}}),
        )
        .unwrap();
    let refs = json!([{"host_id":"home","workspace_id":"workspace","root_ref":"/fixture/project"}]);
    let spec = json!({"name":"Fixture","purpose":"offline context tests","kind":"coordinator",
        "workspace_refs":refs,"execution_targets":[],"workers":[{"id":"worker","role":"implementation",
        "responsibilities":["Test"],"allowed_target_ids":[],"required_capabilities":[],"workspace_refs":refs,"max_parallel":1}],
        "coordinator_targets":[],"workflow_pack_refs":[],"grant_id":null,"budget_policy_id":null,
        "scheduling_policy_id":null,"limits":{"max_active_assignments":2,"max_active_runs":2},"proactive_mode":"off"});
    store
        .save_team(teams::Save {
            id: "team".into(),
            request_id: "team-create".into(),
            expected_revision: 0,
            spec: serde_json::from_value(spec).unwrap(),
        })
        .unwrap();
    store
        .change_collaboration_surface(
            surface_id,
            SurfaceChange {
                request_id: "surface-create".into(),
                expected_revision: 0,
                scope: Scope {
                    home_hub: "home".into(),
                    host_id: "home".into(),
                    workspace_id: "workspace".into(),
                    root_ref: "/fixture/project".into(),
                },
                kind,
                title: "Fixture".into(),
                team_ids: vec!["team".into()],
                enabled: true,
            },
        )
        .unwrap();
    let thread = store
        .send_collaboration_message(
            surface_id,
            Send {
                interactive_selection: None,
                request_id: "message".into(),
                expected_revision: 1,
                thread_id: None,
                content: "Fresh discussion".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let request = Register {
        request_id: "register".into(),
        surface_id: surface_id.into(),
        thread_id: thread["id"].as_str().unwrap().into(),
        team_id: "team".into(),
        team_revision: 1,
        audience_revision: 1,
    };
    (root, store, request)
}

#[test]
fn registry_registration_is_durable_idempotent_and_not_runtime_readiness() {
    let (dir, store, input) = fixture("channel", Kind::Channel);
    let row = store.register_coordinator_context(input.clone()).unwrap();
    assert_eq!(row.start_sequence, 1);
    store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "after-registration".into(),
                expected_revision: 1,
                thread_id: Some(input.thread_id.clone()),
                content: "New input".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    assert_eq!(row.context_scope.kind, ContextKind::DiscussionThread);
    assert_eq!(
        store.register_coordinator_context(input.clone()).unwrap(),
        row
    );
    assert_eq!(store.coordinator_context(&row.key).unwrap(), row);
    assert!(registry::read_in(&store.db.lock(), "other-home", &row.key).is_err());
    let pending: u64 = store
        .db
        .lock()
        .query_row(
            "SELECT count(*) FROM collaboration_coordinator_inputs",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 0);
    assert!(store
        .document(&format!("coordinator-control:{}", json!("team")))
        .unwrap()["value"]
        .is_null());
    drop(store);
    let reopened = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
    assert_eq!(reopened.coordinator_context(&row.key).unwrap(), row);
    assert_eq!(reopened.register_coordinator_context(input).unwrap(), row);
}

#[test]
fn registry_dm_scope_is_private_and_threads_have_distinct_keys() {
    let (_dir, store, input) = fixture("dm", Kind::Dm);
    let row = store.register_coordinator_context(input.clone()).unwrap();
    assert_eq!(row.context_scope.kind, ContextKind::TeamPrivate);
    let thread = store
        .send_collaboration_message(
            "dm",
            Send {
                interactive_selection: None,
                request_id: "second".into(),
                expected_revision: 1,
                thread_id: None,
                content: "Separate".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let mut second = input;
    second.request_id = "register-second".into();
    second.thread_id = thread["id"].as_str().unwrap().into();
    assert_ne!(
        store.register_coordinator_context(second).unwrap().key,
        row.key
    );
}

#[test]
fn registry_rejects_request_mutation_scope_conflict_and_untrusted_scope_fields() {
    let (_dir, store, input) = fixture("channel", Kind::Channel);
    store.register_coordinator_context(input.clone()).unwrap();
    let mut changed = input.clone();
    changed.request_id = "another".into();
    assert!(store.register_coordinator_context(changed).is_err());
    let root = store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "another-root".into(),
                expected_revision: 1,
                thread_id: None,
                content: "Separate".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let mut changed = input.clone();
    changed.thread_id = root["id"].as_str().unwrap().into();
    assert!(store.register_coordinator_context(changed).is_err());
    let mut wire = serde_json::to_value(input).unwrap();
    wire["context_scope"] = json!({"home_hub":"home"});
    assert!(serde_json::from_value::<Register>(wire).is_err());
}

#[test]
fn registry_rejects_missing_root_reply_foreign_team_and_wrong_revisions() {
    let (_dir, store, input) = fixture("channel", Kind::Channel);
    let reply = store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "reply".into(),
                expected_revision: 1,
                thread_id: Some(input.thread_id.clone()),
                content: "Reply".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    for field in [
        "missing",
        "reply",
        "team",
        "team_revision",
        "audience_revision",
        "surface",
    ] {
        let mut bad = input.clone();
        match field {
            "missing" => bad.thread_id = "absent".into(),
            "reply" => bad.thread_id = reply["id"].as_str().unwrap().into(),
            "team" => bad.team_id = "foreign-team".into(),
            "team_revision" => bad.team_revision = 2,
            "audience_revision" => bad.audience_revision = 2,
            _ => bad.surface_id = "absent".into(),
        }
        assert!(store.register_coordinator_context(bad).is_err(), "{field}");
    }
}

#[test]
fn registry_rechecks_revocation_workspace_team_and_origin_on_read_and_retry() {
    for field in [
        "enabled",
        "audience",
        "membership",
        "workspace",
        "root",
        "team_revision",
        "origin",
        "root_kind",
    ] {
        let (_dir, store, input) = fixture("channel", Kind::Channel);
        let row = store.register_coordinator_context(input.clone()).unwrap();
        let db = store.db.lock();
        match field {
            "enabled" => {
                db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false'))", []).unwrap();
            }
            "audience" => {
                db.execute(
                    "UPDATE collaboration_surfaces SET body=json_set(body,'$.audience_revision',2)",
                    [],
                )
                .unwrap();
            }
            "membership" => {
                db.execute(
                    "UPDATE collaboration_surfaces SET body=json_set(body,'$.team_ids',json('[]'))",
                    [],
                )
                .unwrap();
            }
            "workspace" => {
                db.execute("UPDATE workbench_documents SET value=json_set(value,'$.global.workspaceIds',json('[]')) WHERE key='workspaces'", []).unwrap();
            }
            "root" => {
                db.execute("UPDATE workbench_documents SET value=json_set(value,'$.tables.workspaces.workspace.path','/fixture/moved') WHERE key='workspaces'", []).unwrap();
            }
            "team_revision" => {
                db.execute("UPDATE team_revisions SET body=json_set(body,'$.revision',2) WHERE team_id='team'", []).unwrap();
            }
            "origin" => {
                db.execute("UPDATE collaboration_messages SET body=json_set(body,'$.scope.root_ref','/fixture/foreign')", []).unwrap();
            }
            _ => {
                db.execute("UPDATE collaboration_messages SET kind='task'", [])
                    .unwrap();
            }
        }
        drop(db);
        assert!(store.coordinator_context(&row.key).is_err(), "read {field}");
        assert!(
            store.register_coordinator_context(input).is_err(),
            "retry {field}"
        );
    }
}

#[test]
fn registry_never_adopts_legacy_team_controls_or_unknown_keys() {
    let (_dir, store, input) = fixture("channel", Kind::Channel);
    store
        .save_document(
            "coordinator-control:\"team\"",
            0,
            json!({"session_id":"legacy-session"}),
        )
        .unwrap();
    assert!(store.coordinator_context(&"a".repeat(64)).is_err());
    let row = store.register_coordinator_context(input).unwrap();
    assert!(serde_json::to_string(&row)
        .unwrap()
        .find("legacy-session")
        .is_none());
    assert_eq!(
        store.document("coordinator-control:\"team\"").unwrap()["value"]["session_id"],
        "legacy-session"
    );
}

#[path = "context_control_tests.rs"]
mod control_tests;

#[path = "context_input_tests.rs"]
mod input_tests;

#[path = "scoped_thread_create_tests.rs"]
mod scoped_thread_create_tests;

#[path = "context_retrieval_tests.rs"]
mod retrieval_tests;

#[path = "context_routes_tests.rs"]
mod routes_tests;

#[path = "context_inbox_tests.rs"]
mod inbox_tests;

#[path = "context_tools_tests.rs"]
mod tools_tests;

#[path = "context_pending_tests.rs"]
mod pending_tests;

#[path = "context_active_tests.rs"]
mod active_tests;

#[path = "context_host_binding_tests.rs"]
mod host_binding_tests;

#[path = "context_call_tests.rs"]
mod call_tests;
#[path = "context_native_input_tests.rs"]
mod native_input_tests;
