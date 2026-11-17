use super::interactive_team_tests::fixture;
use crate::messaging::store::Store;
use serde_json::{json, Value};
fn edit(store: &Store, revision: u64, update: impl FnOnce(&mut Value)) -> Value {
    let mut spec = store.team("team", None).unwrap().unwrap()["spec"].clone();
    update(&mut spec);
    store.save_team(serde_json::from_value(json!({"id":"team","request_id":format!("save-{revision}"),"expected_revision":revision,"spec":spec})).unwrap()).unwrap()
}
fn command(t: &Value, parent: u64) -> Value {
    json!({"request_id":format!("confirm-{}",t["revision"]),"expected_revision":t["revision"],"parent_accepted_revision":parent,"spec":t["spec"]})
}
fn accept(store: &Store, c: Value) -> anyhow::Result<Value> {
    store.accept_team_configuration("team", serde_json::from_value(c).unwrap())
}
#[test]
fn team_configuration_acceptance_blocks_save_then_exact_retry_stores_once() {
    let (_d, store, _) = fixture();
    let t = edit(&store, 1, |s| {
        s["purpose"] = json!("General development");
        s["execution_targets"][0]["model_id"] = json!("reviewed-model");
    });
    assert_eq!(
        store.team_configuration_acceptance_status("team").unwrap()["accepted"],
        false
    );
    let status = store.team_configuration_acceptance_status("team").unwrap();
    assert_eq!(status["parent_accepted_revision"], 1);
    assert_eq!(status["builder_lineage"]["draft_id"], "draft");
    let input = json!({"request_id":"original-message","expected_revision":1,"thread_id":null,"content":"New configuration message","mentions":[],"interactive_selection":{"team_id":"team","team_revision":2,"participant_id":"coordinator","target_id":"target","workspace_id":"workspace","audience_revision":1}});
    let count = || {
        store.db.lock().query_row("SELECT count(*) FROM collaboration_messages WHERE json_extract(body,'$.content')='New configuration message'",[],|r|r.get::<_,u64>(0)).unwrap()
    };
    assert!(store
        .send_collaboration_message_with_status(
            "channel",
            serde_json::from_value(input.clone()).unwrap()
        )
        .is_err());
    assert_eq!(count(), 0);
    let c = command(&t, 1);
    let r = accept(&store, c.clone()).unwrap();
    assert_eq!(r["activation_performed"], false);
    assert_eq!(r["builder_lineage"]["team"]["revision"], 1);
    assert_eq!(accept(&store, c.clone()).unwrap(), r);
    let (message, new) = store
        .send_collaboration_message_with_status(
            "channel",
            serde_json::from_value(input.clone()).unwrap(),
        )
        .unwrap();
    assert!(new);
    assert_eq!(count(), 1);
    let (again, new) = store
        .send_collaboration_message_with_status("channel", serde_json::from_value(input).unwrap())
        .unwrap();
    assert!(!new);
    assert_eq!(message, again);
    assert_eq!(count(), 1);
    assert_eq!(store.team("team", None).unwrap().unwrap(), t);
    assert_eq!(
        store.team_configuration_acceptance_status("team").unwrap()["accepted"],
        true
    );
    let mut conflict = c;
    conflict["spec"]["purpose"] = json!("Different");
    assert!(accept(&store, conflict).is_err());
}
#[test]
fn team_configuration_acceptance_rejects_stale_exact_and_authority_changes() {
    for field in ["grant_id", "scheduling_policy_id", "proactive_mode"] {
        let (_d, s, _) = fixture();
        let t = edit(&s, 1, |v| {
            v[field] = json!(if field == "proactive_mode" {
                "auto"
            } else {
                "changed"
            })
        });
        assert!(accept(&s, command(&t, 1)).is_err(), "{field}");
        assert_eq!(
            s.team_configuration_acceptance_status("team").unwrap()["accepted"],
            false
        );
    }
    let (_d, s, _) = fixture();
    let t = edit(&s, 1, |v| v["purpose"] = json!("Changed"));
    let mut c = command(&t, 1);
    c["spec"]["name"] = json!("Not saved");
    assert!(accept(&s, c).is_err());
    let t3 = edit(&s, 2, |v| v["purpose"] = json!("Changed again"));
    assert!(accept(&s, command(&t, 1)).is_err());
    accept(&s, command(&t3, 1)).unwrap();
    let t4 = edit(&s, 3, |v| v["purpose"] = json!("Fourth"));
    assert!(accept(&s, command(&t4, 1)).is_err());
    accept(&s, command(&t4, 3)).unwrap();
    assert_eq!(
        s.team_configuration_acceptance_status("team").unwrap()["accepted"],
        true
    );
}
#[test]
fn team_configuration_acceptance_requires_atomic_event_and_full_builder_lineage() {
    for tamper in ["event", "lineage", "builder"] {
        let (_d, s, _) = fixture();
        let t = edit(&s, 1, |v| v["purpose"] = json!("Changed"));
        let c = command(&t, 1);
        accept(&s, c.clone()).unwrap();
        {
            let db = s.db.lock();
            match tamper {
                "event" => {
                    db.execute("DELETE FROM team_events WHERE json_extract(body,'$.kind')='team_configuration_accepted'",[]).unwrap();
                }
                "lineage" => {
                    db.execute("UPDATE workbench_documents SET value=json_set(value,'$.builder_lineage.draft_id','forged') WHERE key LIKE 'team-configuration-acceptance:%'",[]).unwrap();
                }
                _ => {
                    db.execute(
                        "DELETE FROM workbench_documents WHERE key LIKE 'builder-accept:%'",
                        [],
                    )
                    .unwrap();
                }
            }
        }
        assert_eq!(
            s.team_configuration_acceptance_status("team").unwrap()["accepted"],
            false,
            "{tamper}"
        );
        assert!(accept(&s, c).is_err());
    }
}

#[test]
fn team_configuration_acceptance_allows_reviewed_native_target_and_role_mapping_only() {
    for invalid in ["", "account", "capability", "host", "removed"] {
        let (_d, s, _) = fixture();
        let t = edit(&s, 1, |spec| {
            let mut target = spec["execution_targets"][0].clone();
            target["id"] = json!("new-native");
            target["executor_profile_id"] = json!("builtin-codex");
            target["model_id"] = json!("astra-6");
            match invalid {
                "account" => target["account_binding_id"] = json!("new-account"),
                "capability" => target["capability_profile_revision"] = json!("new-capability"),
                "host" => target["host_id"] = json!("other-host"),
                _ => {}
            }
            spec["execution_targets"]
                .as_array_mut()
                .unwrap()
                .push(target);
            spec["coordinator_targets"] = json!(["new-native"]);
            if invalid == "removed" {
                spec["execution_targets"].as_array_mut().unwrap().remove(0);
            }
        });
        let result = accept(&s, command(&t, 1));
        assert_eq!(result.is_ok(), invalid.is_empty(), "{invalid}: {result:?}");
    }
}

#[test]
fn team_configuration_acceptance_preserves_worker_identity_and_allows_many_targets() {
    let (_d, s, _) = fixture();
    let mut spec = s.team("team", None).unwrap().unwrap()["spec"].clone();
    spec["workers"] = json!([{"id":"backend","role":"Backend","responsibilities":["Implement"],"allowed_target_ids":["target"],"required_capabilities":[],"workspace_refs":spec["workspace_refs"],"max_parallel":1}]);
    s.save_builder_draft(serde_json::from_value(json!({"id":"worker-draft","request_id":"worker-save","expected_revision":0,"revoked":false,"interview":{"purpose":"Development","workspace_refs":spec["workspace_refs"],"answers":{},"questions":[],"proposed_team":spec}})).unwrap()).unwrap();
    s.accept_builder_proposal("worker-draft",serde_json::from_value(json!({"request_id":"accept-workers","expected_revision":1,"team_id":"team","team_revision":1})).unwrap()).unwrap();
    let t = edit(&s, 2, |spec| {
        let mut target = spec["execution_targets"][0].clone();
        target["id"] = json!("codex-target");
        target["executor_profile_id"] = json!("builtin-codex");
        target["model_id"] = json!("astra-6");
        spec["execution_targets"]
            .as_array_mut()
            .unwrap()
            .push(target);
        spec["workers"][0]["allowed_target_ids"] = json!(["codex-target", "other-target"]);
    });
    let receipt = accept(&s, command(&t, 2)).unwrap();
    assert_eq!(receipt["builder_lineage"]["draft_id"], "worker-draft");
    let t4 = edit(&s, 3, |spec| {
        spec["workers"][0]["id"] = json!("replacement")
    });
    assert!(accept(&s, command(&t4, 3)).is_err());
}
