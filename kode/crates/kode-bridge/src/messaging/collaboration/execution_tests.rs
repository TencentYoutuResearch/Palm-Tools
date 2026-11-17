//! Task execution API regressions use the real WorkRun/activation store, never a provider CLI.
use super::super::execution::{self, Cancel, Dispatch};
use super::*;
use crate::messaging::{model::now, team_activation, work_runs};

fn reference(row: &Value) -> Value {
    json!({"id":row["id"],"version":row["version"],"hash":row["hash"]})
}
fn policy(row: &Value) -> Value {
    json!({"id":row["id"],"revision":row["revision"],"hash":row["hash"]})
}
fn configure(s: &Store) {
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
    spec["execution_targets"] = json!([{"id":"engine","host_id":"home","executor_profile_id":"fixture-engine","executor_profile_revision":"a".repeat(64),"provider_id":"fixture-provider","model_id":"fixture-model","account_binding_id":"account","capability_profile_revision":"1"}]);
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
    s.write_team_grant(serde_json::from_value(json!({"expected_revision":0,"policy":{"id":"grant","team_id":"team","enabled":true,"expires_at":expiry,"targets":[{"host":"home","workspace":"workspace","root":"/fixture/project"}],"capabilities":["read","delegate"],"tools":[],"network":false,"budget_ids":["budget"]}})).unwrap(),at).unwrap();
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
fn task(s: &Store) -> Value {
    let m = s
        .send_collaboration_message("dm", send("Never publish this secret; fix avatar"))
        .unwrap();
    let mut input = create(m["id"].as_str().unwrap());
    input.team_revision = 2;
    s.create_collaboration_task(input).unwrap()
}
fn input(s: &Store, id: &str) -> Dispatch {
    let c = s.collaboration_execution(id).unwrap();
    Dispatch {
        request_id: "dispatch".into(),
        expected_task_revision: c["task_revision"].as_u64().unwrap(),
        binding_id: "local".into(),
        activation_revision: 1,
        context_sha256: c["context_sha256"].as_str().unwrap().into(),
    }
}
fn dispatched(s: &Store, id: &str) -> Value {
    let receipt = s.dispatch_collaboration_task(id, input(s, id)).unwrap();
    s.work_run(receipt["work_run_id"].as_str().unwrap())
        .unwrap()
        .unwrap()
}
#[test]
fn approved_snapshot_dispatch_uses_real_run_and_does_not_copy_dm() {
    let (_r, s) = fixture();
    configure(&s);
    let task = task(&s);
    let id = task["id"].as_str().unwrap();
    let preview = s.collaboration_execution(id).unwrap();
    assert!(!preview.to_string().contains("Never publish"));
    assert_eq!(preview["automatic_coordinator_dispatch"], false);
    let run = dispatched(&s, id);
    assert_eq!(run["state"], "waiting_resource");
    assert_eq!(run["completion_authorized"], false);
    assert_eq!(run["dispatch_state"], "not_dispatched");
    assert!(run["coordinator"].is_null());
    assert_eq!(run["inputs"].as_object().unwrap().len(), 1);
    let snapshot: Value = serde_json::from_str(run["inputs"]["request"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["summary"], "Fix the session avatar");
    let history = s.team_work_runs("team", crate::messaging::teams::Page { after: String::new(), limit: Some(25) }).unwrap().unwrap();
    assert_eq!(history["items"][0]["request_preview"], "Fix the session avatar");
    assert_eq!(history["items"][0]["id"], run["id"]);
    assert!(!run.to_string().contains("Never publish"));
    assert_eq!(s.collaboration_task(id).unwrap()["work_run_id"], run["id"]);
    assert!(execution::admit_run(&s.db.lock(), &run).is_ok());
    assert_eq!(s.budget("budget").unwrap()["budget"]["reserved"], 0);
}
#[test]
fn execution_retry_survives_restart_and_cannot_spawn_second_run() {
    let (root, s) = fixture();
    configure(&s);
    let task = task(&s);
    let id = task["id"].as_str().unwrap();
    let input = input(&s, id);
    let first = s.dispatch_collaboration_task(id, input.clone()).unwrap();
    drop(s);
    let s = Store::open(&root.path().join("store.sqlite"), "home").unwrap();
    assert_eq!(
        first,
        s.dispatch_collaboration_task(id, input.clone()).unwrap()
    );
    let mut changed = input.clone();
    changed.request_id = "another".into();
    assert!(s.dispatch_collaboration_task(id, changed).is_err());
    let mut changed = input;
    changed.context_sha256 = "0".repeat(64);
    assert!(s.dispatch_collaboration_task(id, changed).is_err());
    assert_eq!(
        s.db.lock()
            .query_row("SELECT count(*) FROM work_runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn concurrent_dispatches_have_one_atomic_identity() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap().to_string();
    let i = input(&s, &id);
    let s = Arc::new(s);
    let handles = (0..4)
        .map(|_| {
            let (s, id, i) = (s.clone(), id.clone(), i.clone());
            std::thread::spawn(move || s.dispatch_collaboration_task(&id, i).unwrap())
        })
        .collect::<Vec<_>>();
    let rows = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert!(rows.iter().all(|r| *r == rows[0]));
    assert_eq!(
        s.db.lock()
            .query_row("SELECT count(*) FROM work_runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn stale_hash_revision_and_activation_fail_before_run_insert() {
    for field in ["hash", "task_revision", "activation", "binding"] {
        let (_r, s) = fixture();
        configure(&s);
        let t = task(&s);
        let id = t["id"].as_str().unwrap();
        let mut i = input(&s, id);
        match field {
            "hash" => i.context_sha256 = "0".repeat(64),
            "task_revision" => i.expected_task_revision = 3,
            "activation" => i.activation_revision = 2,
            _ => i.binding_id = "missing".into(),
        };
        assert!(s.dispatch_collaboration_task(id, i).is_err());
        assert!(s.collaboration_task(id).unwrap()["work_run_id"].is_null());
        assert_eq!(
            s.db.lock()
                .query_row("SELECT count(*) FROM work_runs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn task_dispatch_does_not_bypass_live_activation() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let i = input(&s, id);
    s.change_team_activation(
        "team",
        team_activation::Command::Deactivate {
            request_id: "deactivate".into(),
            expected_revision: 1,
        },
    )
    .unwrap();
    assert!(s.dispatch_collaboration_task(id, i).is_err());
    assert_eq!(
        s.db.lock()
            .query_row("SELECT count(*) FROM work_runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn question_keeps_approved_execution_context_and_remains_not_delivered() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let run = dispatched(&s, id);
    let preview = s.collaboration_execution(id).unwrap();
    let result = s.command_collaboration_task(id, command()).unwrap();
    assert_eq!(result["command"]["delivery_state"], "stored_only");
    assert_eq!(
        result["command"]["payload"]["execution_delivery"]["state"],
        "not_delivered"
    );
    assert_eq!(result["task"]["revision"], 2);
    assert_eq!(result["task"]["execution_revision"], 1);
    assert!(execution::admit_run(&s.db.lock(), &run).is_ok());
    let after = s.collaboration_execution(id).unwrap();
    assert_eq!(after["context_sha256"], preview["context_sha256"]);
    assert_eq!(after["work_run"]["task_context_current"], true);
    assert_eq!(after["context"]["published_commands"], json!([]));
    let assignment = s
        .prepare_work_assignment(
            run["id"].as_str().unwrap(),
            "implement",
            crate::messaging::work_assignments::Prepare {
                request_id: "after-question".into(),
                expected_revision: 1,
                target_id: "engine".into(),
                worker_id: Some("implementation".into()),
            },
            &["home".into()],
        )
        .unwrap();
    assert!(s
        .reserve_assignment_resources(
            assignment["assignment"]["id"].as_str().unwrap(),
            crate::messaging::assignment_resources::Reserve {
                request_id: "reserve".into(),
                expected_revision: 1
            }
        )
        .is_ok());
}
#[test]
fn active_amendment_and_pause_are_rejected_before_any_write() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let run = dispatched(&s, id);
    let before = s.collaboration_task(id).unwrap();
    let events = s.collaboration_task_events(id, Page::default()).unwrap();
    for action in [Action::Supplement, Action::Pause] {
        let mut input = command();
        input.action = action;
        assert!(s
            .command_collaboration_task(id, input)
            .unwrap_err()
            .to_string()
            .contains("not supported"));
        assert_eq!(s.collaboration_task(id).unwrap(), before);
        assert_eq!(
            s.collaboration_task_events(id, Page::default()).unwrap(),
            events
        );
    }
    assert!(execution::admit_run(&s.db.lock(), &run).is_ok());
    assert_eq!(
        s.db.lock()
            .query_row(
                "SELECT count(*) FROM collaboration_receipts WHERE namespace=?1",
                [format!("task-command:{id}")],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
        0
    );
}
#[test]
fn previously_accepted_supplement_receipt_stays_idempotent_after_dispatch() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let mut c = command();
    c.action = Action::Supplement;
    let accepted = s.command_collaboration_task(id, c.clone()).unwrap();
    assert_eq!(accepted["task"]["execution_revision"], 2);
    let run = dispatched(&s, id);
    assert_eq!(s.command_collaboration_task(id, c).unwrap(), accepted);
    assert!(execution::admit_run(&s.db.lock(), &run).is_ok());
}
#[test]
fn removed_audience_blocks_dispatch_and_new_stage_but_keeps_owner_cancel_available() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let i = input(&s, id);
    let run = dispatched(&s, id);
    let mut c = change(Kind::Channel);
    c.expected_revision = 1;
    c.request_id = "disable".into();
    c.enabled = false;
    s.change_collaboration_surface("channel", c).unwrap();
    assert!(s.collaboration_execution(id).is_err());
    assert!(s.dispatch_collaboration_task(id, i).is_err());
    assert!(execution::admit_run(&s.db.lock(), &run).is_err());
    let cancel = s
        .cancel_collaboration_execution(
            id,
            Cancel {
                request_id: "cancel".into(),
                expected_run_revision: 1,
                reason: "Owner stopped task".into(),
            },
        )
        .unwrap();
    assert_eq!(cancel["state"], "cancelling");
    assert_eq!(cancel["stop_confirmed"], false);
    let finalized = s
        .command_work_run(
            run["id"].as_str().unwrap(),
            work_runs::Command::FinalizeCancel {
                request_id: "cancel-final".into(),
                expected_revision: 2,
            },
        )
        .unwrap();
    assert_eq!(finalized["state"], "cancelled");
    assert_eq!(finalized["completion_authorized"], false);
}
#[test]
fn project_expansion_and_external_delivery_are_rejected() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let i = input(&s, id);
    let mut run = dispatched(&s, id);
    // Pure validation below also verifies no caller can construct a wider snapshot than the frozen task.
    let db = s.db.lock();
    let row = super::super::tasks::task(&db, id).unwrap();
    run["context"]["binding"]["project"]["config"]["spec"]["repositories"]["code"]["workspace"]
        ["root_ref"] = json!("/fixture/other");
    assert!(execution::frozen_authority(&db, "home", &row, &i, &run).is_err());
    run["context"]["binding"]["project"]["config"]["spec"]["repositories"]["code"]["workspace"]
        ["root_ref"] = json!("/fixture/project");
    run["context"]["binding"]["delivery_policy"]["config"]["spec"]["targets"][0]["kind"] =
        json!("change_request");
    assert!(execution::frozen_authority(&db, "home", &row, &i, &run).is_err());
}
#[test]
fn task_cancel_fences_linked_run_atomically_and_retries_exactly() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let run = dispatched(&s, id);
    let mut c = command();
    c.action = Action::Cancel;
    c.content = None;
    let first = s.command_collaboration_task(id, c.clone()).unwrap();
    assert_eq!(
        first["command"]["delivery_state"],
        "work_run_cancel_requested"
    );
    assert_eq!(
        first["command"]["payload"]["execution"]["state"],
        "cancelling"
    );
    assert_eq!(
        first["command"]["payload"]["execution"]["stop_confirmed"],
        false
    );
    assert_eq!(
        s.work_run(run["id"].as_str().unwrap()).unwrap().unwrap()["state"],
        "cancelling"
    );
    assert_eq!(first, s.command_collaboration_task(id, c).unwrap());
}
#[tokio::test]
async fn execution_http_is_owner_only_and_uses_real_run_receipt() {
    let root = tempfile::tempdir().unwrap();
    let ctx = crate::build_test_ctx(kode_core::config::Config::default(), "owner-fixture".into());
    let hub = Hub::open_with_agent_home(
        Config {
            node_id: "home".into(),
            database: root.path().join("http.sqlite"),
            peers: vec![],
        },
        &ctx,
        root.path().join("agent-home"),
    )
    .unwrap();
    setup(&hub.store);
    configure(&hub.store);
    let t = task(&hub.store);
    let id = t["id"].as_str().unwrap();
    let registration = hub
        .store
        .register(crate::messaging::model::RegisterRequest {
            session_id: "fixture-session".into(),
            title: "Fixture".into(),
            runtime: "fixture".into(),
            owner_token: None,
        })
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = hub.router();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::new();
    let endpoint = format!("{url}/api/v1/messaging/collaboration/tasks/{id}/execution");
    let input = input(&hub.store, id);
    for (token, status) in [(None, 401), (Some(registration.owner_token.as_str()), 403)] {
        for (path, method, body) in [
            (endpoint.clone(), reqwest::Method::GET, json!({})),
            (
                endpoint.clone(),
                reqwest::Method::POST,
                serde_json::to_value(&input).unwrap(),
            ),
            (
                format!("{endpoint}/cancel"),
                reqwest::Method::POST,
                json!({"request_id":"cancel","expected_run_revision":1,"reason":"Stop"}),
            ),
        ] {
            let mut request = client.request(method, &path).json(&body);
            if let Some(token) = token {
                request = request.bearer_auth(token)
            }
            assert_eq!(request.send().await.unwrap().status().as_u16(), status);
        }
    }
    let preview: Value = client
        .get(&endpoint)
        .bearer_auth("owner-fixture")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!preview.to_string().contains("Never publish"));
    let result: Value = client
        .post(&endpoint)
        .bearer_auth("owner-fixture")
        .json(&input)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(result["state"], "waiting_resource");
    assert_eq!(result["completion_authorized"], false);
    let retry: Value = client
        .post(&endpoint)
        .bearer_auth("owner-fixture")
        .json(&input)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(retry, result);
    let stop: Value = client
        .post(format!("{endpoint}/cancel"))
        .bearer_auth("owner-fixture")
        .json(&json!({"request_id":"cancel","expected_run_revision":1,"reason":"Owner cancelled"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stop["state"], "cancelling");
    assert_eq!(stop["stop_confirmed"], false);
    server.abort();
    hub.shutdown();
}
#[test]
fn linked_task_prepares_real_assignment_budget_and_cancel_without_cli_call() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let run = dispatched(&s, id);
    let run_id = run["id"].as_str().unwrap();
    let plan = s.work_run_stage_plan(run_id, "implement").unwrap();
    assert_eq!(plan["candidates"][0]["recommendation"]["recommended"], true);
    let assignment = s
        .prepare_work_assignment(
            run_id,
            "implement",
            crate::messaging::work_assignments::Prepare {
                request_id: "prepare".into(),
                expected_revision: 1,
                target_id: "engine".into(),
                worker_id: Some("implementation".into()),
            },
            &["home".into()],
        )
        .unwrap();
    assert_eq!(assignment["assignment"]["dispatch"]["state"], "blocked");
    assert_eq!(s.budget("budget").unwrap()["budget"]["reserved"], 10);
    assert!(!assignment.to_string().contains("Never publish"));
    let mut c = command();
    c.action = Action::Cancel;
    c.content = None;
    s.command_collaboration_task(id, c).unwrap();
    let current = s.work_run(run_id).unwrap().unwrap();
    assert_eq!(current["state"], "cancelling");
    let completed = s
        .command_work_run(
            run_id,
            work_runs::Command::FinalizeCancel {
                request_id: "settle-cancel".into(),
                expected_revision: current["revision"].as_u64().unwrap(),
            },
        )
        .unwrap();
    assert_eq!(completed["state"], "cancelled");
    assert_eq!(s.budget("budget").unwrap()["budget"]["reserved"], 0);
    assert_eq!(s.budget("budget").unwrap()["budget"]["spent"], 0);
    assert_eq!(
        s.db.lock()
            .query_row("SELECT count(*) FROM official_calls", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn audience_revocation_rejects_prepared_assignment_resources() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let run = dispatched(&s, id);
    let result = s
        .prepare_work_assignment(
            run["id"].as_str().unwrap(),
            "implement",
            crate::messaging::work_assignments::Prepare {
                request_id: "prepare".into(),
                expected_revision: 1,
                target_id: "engine".into(),
                worker_id: Some("implementation".into()),
            },
            &["home".into()],
        )
        .unwrap();
    let mut c = change(Kind::Channel);
    c.expected_revision = 1;
    c.request_id = "disable".into();
    c.enabled = false;
    s.change_collaboration_surface("channel", c).unwrap();
    let assignment = result["assignment"]["id"].as_str().unwrap();
    assert!(s
        .reserve_assignment_resources(
            assignment,
            crate::messaging::assignment_resources::Reserve {
                request_id: "reserve".into(),
                expected_revision: 1
            }
        )
        .is_err());
    assert!(s.assignment_capacity("account").unwrap().unwrap()["held"] == 0);
}
#[test]
fn task_assignment_cannot_bypass_budget_exhaustion() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let run = dispatched(&s, id);
    s.reserve_budget(
        crate::messaging::budgets::Reserve {
            id: "other-work".into(),
            budget_ids: vec!["budget".into()],
            amount: 100,
            unit: "credits".into(),
            operation_id: "other-operation".into(),
        },
        now(),
    )
    .unwrap();
    assert!(s
        .prepare_work_assignment(
            run["id"].as_str().unwrap(),
            "implement",
            crate::messaging::work_assignments::Prepare {
                request_id: "prepare".into(),
                expected_revision: 1,
                target_id: "engine".into(),
                worker_id: Some("implementation".into())
            },
            &["home".into()]
        )
        .is_err());
    assert_eq!(
        s.db.lock()
            .query_row("SELECT count(*) FROM work_assignments", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(s.budget("budget").unwrap()["budget"]["reserved"], 100);
}

#[test]
fn v1_execution_remains_valid_after_question_but_not_historical_amendment() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let mut run = dispatched(&s, id);
    let mut context: Value =
        serde_json::from_str(run["inputs"]["request"].as_str().unwrap()).unwrap();
    context["format"] = json!("kode.collaboration.task-context.v1");
    context
        .as_object_mut()
        .unwrap()
        .remove("execution_revision");
    context["task_revision"] = json!(1);
    run["inputs"]["request"] = json!(serde_json::to_string(&context).unwrap());
    run["collaboration"]["format"] = json!("kode.collaboration.work-source.v1");
    run["collaboration"]
        .as_object_mut()
        .unwrap()
        .remove("execution_revision");
    run["collaboration"]["context_sha256"] = json!(digest(&context.to_string()));
    {
        let db = s.db.lock();
        db.execute(
            "UPDATE work_runs SET body=?1 WHERE id=?2",
            rusqlite::params![run.to_string(), run["id"].as_str()],
        )
        .unwrap();
        db.execute("UPDATE collaboration_tasks SET body=json_remove(body,'$.execution_revision') WHERE id=?1",[id]).unwrap();
    }
    s.command_collaboration_task(id, command()).unwrap();
    assert!(execution::admit_run(&s.db.lock(), &run).is_ok());
    assert_eq!(
        s.collaboration_execution(id).unwrap()["context_sha256"],
        run["collaboration"]["context_sha256"]
    );
    {
        let db = s.db.lock();
        let row = super::super::tasks::task(&db, id).unwrap();
        super::super::tasks::event(
            &db,
            &row,
            "owner_command",
            json!({"action":"supplement","content":"Previously accepted unauthorized amendment"}),
        )
        .unwrap();
    }
    assert!(execution::admit_run(&s.db.lock(), &run).is_err());
}
#[test]
fn unsupported_execution_capabilities_fail_before_budget_use() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let i = input(&s, id);
    let run = dispatched(&s, id);
    let db = s.db.lock();
    let row = super::super::tasks::task(&db, id).unwrap();
    for cap in [
        "commit",
        "delegate",
        "builder_draft_write",
        "push",
        "merge",
        "deploy",
        "external_message",
    ] {
        let mut changed = run.clone();
        changed["context"]["binding"]["workflow"]["pack"]["stages"][0]["execution"]
            ["capabilities"] = json!([cap]);
        assert!(execution::frozen_authority(&db, "home", &row, &i, &changed).is_err());
    }
    let mut changed = run;
    changed["context"]["binding"]["workflow"]["pack"]["stages"][0]["execution"] = Value::Null;
    assert!(execution::frozen_authority(&db, "home", &row, &i, &changed).is_err());
}
#[test]
fn concurrent_question_and_dispatch_do_not_duplicate_or_change_approved_input() {
    for _ in 0..5 {
        let (_r, s) = fixture();
        configure(&s);
        let t = task(&s);
        let id = t["id"].as_str().unwrap().to_string();
        let request = input(&s, &id);
        let s = Arc::new(s);
        let question = {
            let s = s.clone();
            let id = id.clone();
            std::thread::spawn(move || s.command_collaboration_task(&id, command()).unwrap())
        };
        let dispatch = {
            let s = s.clone();
            let id = id.clone();
            let request = request.clone();
            std::thread::spawn(move || s.dispatch_collaboration_task(&id, request))
        };
        question.join().unwrap();
        let result = match dispatch.join().unwrap() {
            Ok(result) => result,
            Err(error) => {
                assert!(error.to_string().contains("revision"));
                let mut retry = input(&s, &id);
                retry.request_id = "reviewed-after-question".into();
                s.dispatch_collaboration_task(&id, retry).unwrap()
            }
        };
        let run = s
            .work_run(result["work_run_id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert!(execution::admit_run(&s.db.lock(), &run).is_ok());
        assert!(!run["inputs"].to_string().contains("Any progress?"));
        assert_eq!(
            s.db.lock()
                .query_row("SELECT count(*) FROM work_runs", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            1
        );
    }
}
#[test]
fn unsupported_static_evidence_is_rejected_before_execution() {
    let (_r, s) = fixture();
    configure(&s);
    let t = task(&s);
    let id = t["id"].as_str().unwrap();
    let i = input(&s, id);
    let run = dispatched(&s, id);
    let db = s.db.lock();
    let row = super::super::tasks::task(&db, id).unwrap();
    let mut changed = run.clone();
    changed["context"]["binding"]["workflow"]["pack"]["evidence_rules"]["artifact"] =
        json!({"kind":"report","schema_id":"report","schema_hash":"a".repeat(64)});
    assert!(execution::frozen_authority(&db, "home", &row, &i, &changed)
        .unwrap_err()
        .to_string()
        .contains("evidence shapes"));
    let mut changed = run.clone();
    changed["context"]["binding"]["workflow"]["pack"]["stages"][0]["independent_from"] =
        json!(["ancestor"]);
    assert!(execution::frozen_authority(&db, "home", &row, &i, &changed)
        .unwrap_err()
        .to_string()
        .contains("evidence shapes"));
    let mut changed = run;
    changed["context"]["binding"]["workflow"]["pack"]["stages"][0]["execution"]["capabilities"] =
        json!(["read", "workspace_write"]);
    changed["context"]["binding"]["workflow"]["pack"]["evidence_rules"]["artifact"] =
        json!({"kind":"review","artifact_output":"earlier"});
    assert!(execution::frozen_authority(&db, "home", &row, &i, &changed)
        .unwrap_err()
        .to_string()
        .contains("evidence shapes"));
}

#[path = "discussion_dispatch_tests.rs"]
mod discussion_dispatch_tests;
