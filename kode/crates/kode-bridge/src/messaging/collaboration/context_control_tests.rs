//! Offline admission tests: real Store policies, no Hub or model runtime.
use super::*;
use crate::messaging::{coordinator_control, model::now};
use serde_json::Value;

pub(super) fn ready() -> (tempfile::TempDir, Store, Register, registry::Record) {
    let (dir, store, mut request) = fixture("channel", Kind::Channel);
    configure(&store);
    request.team_revision = 2;
    let record = store.register_coordinator_context(request.clone()).unwrap();
    store
        .create_price(
            serde_json::from_value(json!({"id":"price","model":"fixture-model",
        "model_policy":"requested_model","unit":"credits","input_per_million":1,
        "cached_per_million":1,"output_per_million":1}))
            .unwrap(),
        )
        .unwrap();
    (dir, store, request, record)
}
pub(super) fn prepare(store: &Store, session: &str, request: &str) -> Value {
    prepare_target(
        store,
        session,
        request,
        json!({"host":"home","workspace":"workspace","root":"/fixture/project"}),
    )
}
fn prepare_target(store: &Store, session: &str, request: &str, target: Value) -> Value {
    let bundle=store.prepare_operation_bundle(serde_json::from_value(json!({
        "owner_session":"owner","request_key":request,"worker":{"node_id":"home","session_id":session},
        "selection_policy":{"profile_revision":"a".repeat(64),"model":"fixture-model","effort":null,"scope":"executor_configuration"},
        "funding":{"budget_ids":["budget"],"amount":10,"unit":"credits"},
        "resource":{"host":"home","profile":"fixture-engine","account_id":"account","account_epoch":1,"binding_revision":1,"limit_ids":[],"unknown_quota":"team_budget"},
        "grant_id":"grant","grant_scope":{"team_id":"team","revision":1,
        "target":target,
        "capabilities":["read","delegate"],"tools":[],"network":false,"budget_ids":["budget"]}
    })).unwrap()).unwrap();
    store
        .bind_price(
            bundle["reservation"]["request"]["id"].as_str().unwrap(),
            "price",
        )
        .unwrap();
    bundle
}
pub(super) fn bind_input(bundle: &Value) -> coordinator_control::Bind {
    serde_json::from_value(json!({"request_id":bundle["operation"]["id"],"expected_revision":0,
        "team_revision":2,"activation_revision":1,"operation_id":bundle["operation"]["id"],
        "operation_revision":bundle["operation"]["revision"],"attempt":1,"epoch":1,"target_id":"engine"})).unwrap()
}

#[test]
fn scoped_control_real_bind_is_idempotent_durable_and_leaves_legacy_unchanged() {
    let (dir, store, _, record) = ready();
    let legacy = prepare(&store, "legacy-coordinator", "legacy");
    let legacy_control = store
        .bind_coordinator_control("team", bind_input(&legacy))
        .unwrap();
    let legacy_op = store
        .operation(legacy["operation"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert!(crate::messaging::operation_grant::admit(&store.db.lock(), &legacy_op, now()).is_ok());
    let bundle = prepare(&store, &format!("context-{}", record.key), "first");
    let control = store
        .bind_context_coordinator_control(&record.key, bind_input(&bundle))
        .unwrap();
    assert_eq!(control["runtime_ready"], false);
    assert!(uuid::Uuid::parse_str(control["journal_id"].as_str().unwrap()).is_ok());
    assert_eq!(control["dispatch_state"], "not_ready");
    assert_eq!(
        store
            .bind_context_coordinator_control(&record.key, bind_input(&bundle))
            .unwrap(),
        control
    );
    let mut changed = bind_input(&bundle);
    changed.target_id = "other".into();
    assert!(store
        .bind_context_coordinator_control(&record.key, changed)
        .unwrap_err()
        .to_string()
        .contains("identity conflict"));
    let mut changed = bind_input(&bundle);
    changed.request_id = "replacement".into();
    assert!(store
        .bind_context_coordinator_control(&record.key, changed)
        .unwrap_err()
        .to_string()
        .contains("recovery not ready"));
    let op = store
        .operation(bundle["operation"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        coordinator_control::lease_gate(&store.db.lock(), &op, now())
            .unwrap_err()
            .to_string(),
        "scoped Coordinator runtime not ready"
    );
    assert_eq!(
        store.coordinator_control("team").unwrap().unwrap(),
        legacy_control
    );
    assert!(crate::messaging::operation_grant::admit(&store.db.lock(), &legacy_op, now()).is_ok());
    drop(store);
    let store = Store::open(&dir.path().join("store.sqlite"), "home").unwrap();
    assert_eq!(
        store
            .context_coordinator_control(&record.key)
            .unwrap()
            .unwrap(),
        control
    );
    assert_eq!(
        store
            .bind_context_coordinator_control(&record.key, bind_input(&bundle))
            .unwrap(),
        control
    );
    assert_eq!(
        store.coordinator_control("team").unwrap().unwrap(),
        legacy_control
    );
}

#[test]
fn scoped_control_two_threads_bind_distinct_operations_and_sessions() {
    let (_dir, store, mut request, first) = ready();
    let message = store
        .send_collaboration_message(
            "channel",
            Send {
                interactive_selection: None,
                request_id: "second-root".into(),
                expected_revision: 1,
                thread_id: None,
                content: "Separate".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    request.thread_id = message["id"].as_str().unwrap().into();
    request.request_id = "second-context".into();
    let second = store.register_coordinator_context(request).unwrap();
    let mut results = vec![];
    for (i, record) in [&first, &second].into_iter().enumerate() {
        let bundle = prepare(
            &store,
            &format!("context-{}", record.key),
            &format!("prepare-{i}"),
        );
        let control = store
            .bind_context_coordinator_control(&record.key, bind_input(&bundle))
            .unwrap();
        assert_eq!(
            store
                .context_coordinator_control(&record.key)
                .unwrap()
                .unwrap(),
            control
        );
        results.push(control);
    }
    assert_ne!(results[0]["worker"], results[1]["worker"]);
    assert_ne!(
        results[0]["request"]["operation_id"],
        results[1]["request"]["operation_id"]
    );
    assert!(store.coordinator_control("team").unwrap().is_none());
    assert!(store.sessions().unwrap().is_empty());
}

#[test]
fn scoped_control_rejects_another_legitimate_team_workspace_despite_team_admission() {
    let (_dir, store, mut request) = fixture("channel", Kind::Channel);
    let catalog = store.document("workspaces").unwrap();
    let mut workspaces = catalog["value"].clone();
    workspaces["tables"]["workspaces"]["other-workspace"] = json!({"path":"/fixture/other"});
    workspaces["global"]["workspaceIds"]
        .as_array_mut()
        .unwrap()
        .push(json!("other-workspace"));
    store
        .save_document(
            "workspaces",
            catalog["revision"].as_u64().unwrap(),
            workspaces,
        )
        .unwrap();
    configure_workspaces(&store, true);
    request.team_revision = 2;
    let context = store.register_coordinator_context(request).unwrap();
    store
        .create_price(
            serde_json::from_value(json!({"id":"price","model":"fixture-model",
        "model_policy":"requested_model","unit":"credits","input_per_million":1,
        "cached_per_million":1,"output_per_million":1}))
            .unwrap(),
        )
        .unwrap();
    let bundle = prepare_target(
        &store,
        &format!("context-{}", context.key),
        "other-workspace-operation",
        json!({"host":"home","workspace":"other-workspace","root":"/fixture/other"}),
    );
    {
        let mut db = store.db.lock();
        let tx = db.transaction().unwrap();
        // This is a fully valid activated Team operation, not a malformed fixture.
        assert!(
            coordinator_control::admit_binding(&tx, "home", "team", &bind_input(&bundle)).is_ok()
        );
    }
    assert_eq!(
        store
            .bind_context_coordinator_control(&context.key, bind_input(&bundle))
            .unwrap_err()
            .to_string(),
        "scoped Coordinator grant differs from exact context workspace"
    );
    assert!(store
        .context_coordinator_control(&context.key)
        .unwrap()
        .is_none());
    assert!(store.coordinator_control("team").unwrap().is_none());
    assert!(!coordinator_control::bound(
        &store.db.lock(),
        bundle["operation"]["id"].as_str().unwrap()
    )
    .unwrap());
}

#[test]
fn scoped_control_rejects_existing_or_other_operation_session_history() {
    for mode in ["registered", "other_operation", "wrong_session"] {
        let (_dir, store, _, record) = ready();
        let session = format!("context-{}", record.key);
        let bundle = prepare(
            &store,
            if mode == "wrong_session" {
                "foreign-session"
            } else {
                &session
            },
            "first",
        );
        if mode == "registered" {
            store
                .register(
                    serde_json::from_value(
                        json!({"session_id":session,"title":"Existing","runtime":"external"}),
                    )
                    .unwrap(),
                )
                .unwrap();
        } else if mode == "other_operation" {
            prepare(&store, &session, "other");
        }
        let error = store
            .bind_context_coordinator_control(&record.key, bind_input(&bundle))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(if mode == "wrong_session" {
                "fresh context session"
            } else {
                "cannot adopt session history"
            }),
            "{mode}: {error}"
        );
        assert!(store
            .context_coordinator_control(&record.key)
            .unwrap()
            .is_none());
    }
}

#[test]
fn scoped_control_funding_grant_and_scope_revocation_fail_before_writes() {
    for mode in ["budget", "grant", "scope"] {
        let (_dir, store, _, record) = ready();
        let bundle = prepare(&store, &format!("context-{}", record.key), "first");
        let db = store.db.lock();
        match mode {
            "budget" => {
                db.execute("DELETE FROM operation_budget_bindings", [])
                    .unwrap();
            }
            "grant" => {
                db.execute(
                    "DELETE FROM workbench_documents WHERE key LIKE 'operation-grant:%'",
                    [],
                )
                .unwrap();
            }
            _ => {
                db.execute("UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false'))",[]).unwrap();
            }
        }
        drop(db);
        assert!(
            store
                .bind_context_coordinator_control(&record.key, bind_input(&bundle))
                .is_err(),
            "{mode}"
        );
        assert_eq!(store.db.lock().query_row("SELECT count(*) FROM workbench_documents WHERE key LIKE 'coordinator-context-control-v2:%' OR key LIKE 'coordinator-operation:%'",[],|r|r.get::<_,u64>(0)).unwrap(),0);
    }
}

#[test]
fn scoped_control_receipt_replay_is_historical_not_new_authority() {
    let (_dir, store, _, record) = ready();
    let bundle = prepare(&store, &format!("context-{}", record.key), "first");
    let control = store
        .bind_context_coordinator_control(&record.key, bind_input(&bundle))
        .unwrap();
    store
        .db
        .lock()
        .execute(
            "DELETE FROM workbench_documents WHERE key LIKE 'operation-grant:%'",
            [],
        )
        .unwrap();
    let changes = || {
        store
            .db
            .lock()
            .query_row("SELECT total_changes()", [], |r| r.get::<_, u64>(0))
            .unwrap()
    };
    let before = changes();
    assert_eq!(
        store
            .bind_context_coordinator_control(&record.key, bind_input(&bundle))
            .unwrap(),
        control
    );
    assert_eq!(changes(), before);
    assert_eq!(control["runtime_ready"], false);
    let op = store
        .operation(bundle["operation"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert!(coordinator_control::lease_gate(&store.db.lock(), &op, now()).is_err());
    store
        .db
        .lock()
        .execute(
            "UPDATE collaboration_surfaces SET body=json_set(body,'$.enabled',json('false'))",
            [],
        )
        .unwrap();
    assert!(store
        .bind_context_coordinator_control(&record.key, bind_input(&bundle))
        .is_err());
    assert!(store.context_coordinator_control(&record.key).is_err());
}

fn reference(row: &Value) -> Value {
    json!({"id":row["id"],"version":row["version"],"hash":row["hash"]})
}
fn policy(row: &Value) -> Value {
    json!({"id":row["id"],"revision":row["revision"],"hash":row["hash"]})
}
fn configure(s: &Store) {
    configure_workspaces(s, false);
}
fn configure_workspaces(s: &Store, second: bool) {
    let workspace =
        json!({"host_id":"home","workspace_id":"workspace","root_ref":"/fixture/project"});
    let workflow=s.save_workflow(serde_json::from_value(json!({"id":"flow","version":"1","inputs":["request"],
        "stages":[{"id":"implement","role":"implementation","requires":["request"],"produces":["artifact"],"independent_from":[],
          "execution":{"task_tag":"fixture-task","repository_binding":"code","capabilities":["read"],"tools":[],"network":false}}],
        "completion_stages":["implement"],"evidence_rules":{"artifact":{"kind":"artifact","repository_binding":"code"}}})).unwrap()).unwrap();
    let project=s.save_project_config(serde_json::from_value(json!({"id":"project","version":"1","spec":{"kind":"project_bindings",
        "repositories":{"code":{"repository_id":"fixture-repo","workspace":workspace}},"environments":{},"commands":{},"connections":{}}})).unwrap()).unwrap();
    let delivery=s.save_project_config(serde_json::from_value(json!({"id":"delivery","version":"1","spec":{"kind":"delivery_policy",
        "project":reference(&project),"workflow":reference(&workflow),"targets":[{"kind":"local","repository_binding":"code"}],"required_outputs":["artifact"]}})).unwrap()).unwrap();
    let mut spec = s.team("team", None).unwrap().unwrap()["spec"].clone();
    if second {
        spec["workspace_refs"].as_array_mut().unwrap().push(
            json!({"host_id":"home","workspace_id":"other-workspace","root_ref":"/fixture/other"}),
        );
    }
    spec["execution_targets"] = json!([{"id":"engine","host_id":"home","executor_profile_id":"fixture-engine","executor_profile_revision":"a".repeat(64),"provider_id":"fixture-provider","model_id":"fixture-model","account_binding_id":"account","capability_profile_revision":"1"}]);
    spec["coordinator_targets"] = json!(["engine"]);
    spec["workers"][0]["allowed_target_ids"] = json!(["engine"]);
    spec["workflow_pack_refs"] = json!([reference(&workflow)]);
    spec["delivery_bindings"] = json!([{"id":"local","workflow":reference(&workflow),"project":reference(&project),"delivery_policy":reference(&delivery)}]);
    spec["grant_id"] = json!("grant");
    spec["budget_policy_id"] = json!("budget-policy");
    spec["scheduling_policy_id"] = json!("schedule-policy");
    s.save_team(teams::Save {
        id: "team".into(),
        request_id: "configure".into(),
        expected_revision: 1,
        spec: serde_json::from_value(spec).unwrap(),
    })
    .unwrap();
    let at = now();
    let expiry = at + 3600000;
    s.configure_budget(serde_json::from_value(json!({"id":"budget","scope":"team","scope_id":"team","unit":"credits","limit":100,"starts_at":at-1,"ends_at":expiry,"expected_revision":0})).unwrap(),at).unwrap();
    let budget=s.write_team_policy(serde_json::from_value(json!({"id":"budget-policy","team_id":"team","expected_revision":0,"policy":{"kind":"budget","budget_ids":["budget"],"unit":"credits","max_assignment_charge":10}})).unwrap()).unwrap();
    let schedule=s.write_team_policy(serde_json::from_value(json!({"id":"schedule-policy","team_id":"team","expected_revision":0,"policy":{"kind":"scheduling","targets":{"engine":{"resource":{"host":"home","profile":"fixture-engine","account_id":"account","account_epoch":1,"binding_revision":1,"limit_ids":[],"unknown_quota":"team_budget"},"capability_id":"capability","capability_revision":1,"preferred":false}},"weights":{"quality":1,"cost":0,"latency":0},"minimum_quality":0,"minimum_confidence":0}})).unwrap()).unwrap();
    let mut targets =
        vec![json!({"host":"home","workspace":"workspace","root":"/fixture/project"})];
    if second {
        targets.push(json!({"host":"home","workspace":"other-workspace","root":"/fixture/other"}));
    }
    s.write_team_grant(serde_json::from_value(json!({"expected_revision":0,"policy":{"id":"grant","team_id":"team","enabled":true,"expires_at":expiry,"targets":targets,"capabilities":["read","delegate"],"tools":[],"network":false,"budget_ids":["budget"]}})).unwrap(),at).unwrap();
    s.change_resource_account(
        serde_json::from_value(json!({"id":"account","expected_epoch":0,"enabled":true})).unwrap(),
    )
    .unwrap();
    s.bind_resource_account(serde_json::from_value(json!({"host":"home","profile":"fixture-engine","account_id":"account","account_epoch":1,"expected_revision":0})).unwrap()).unwrap();
    s.save_capability_profile(serde_json::from_value(json!({"id":"capability","expected_revision":0,"host":"home","profile":"fixture-engine","model":"fixture-model","assessments":{"fit":{"evaluation":{"kind":"task_fit","tag":"fixture-task","score":80},"source":"user","confidence":1.0,"evidence":[],"updated_at":at,"valid_until":expiry,"pinned":false}}})).unwrap()).unwrap();
    s.configure_assignment_capacity(
        serde_json::from_value(
            json!({"account_id":"account","expected_revision":0,"max_active_assignments":1}),
        )
        .unwrap(),
    )
    .unwrap();
    s.change_team_activation("team",serde_json::from_value(json!({"action":"activate","request_id":"activate","expected_revision":0,"team_revision":2,"grant_revision":1,"budget_policy":policy(&budget),"scheduling_policy":policy(&schedule)})).unwrap()).unwrap();
}
