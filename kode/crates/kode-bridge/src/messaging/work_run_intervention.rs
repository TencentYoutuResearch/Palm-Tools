//! Owner intervention shares drain proof with cancellation and retains a resumable run.
use super::{model::now, work_runs::Command};
use anyhow::{bail, Result};
use rusqlite::{params, Transaction};
use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Purpose {
    Cancel,
    Takeover,
}
impl Purpose {
    pub(super) fn field(self) -> &'static str {
        match self {
            Self::Cancel => "cancellation",
            Self::Takeover => "intervention",
        }
    }
    pub(super) fn stopping_state(self) -> &'static str {
        match self {
            Self::Cancel => "cancelling",
            Self::Takeover => "taking_over",
        }
    }
    pub(super) fn stopped_state(self) -> &'static str {
        match self {
            Self::Cancel => "cancelled",
            Self::Takeover => "paused",
        }
    }
    pub(super) fn assignment_state(self) -> &'static str {
        match self {
            Self::Cancel => "cancelled",
            Self::Takeover => "interrupted",
        }
    }
    pub(super) fn request_event(self) -> &'static str {
        match self {
            Self::Cancel => "work_run_cancel_requested",
            Self::Takeover => "work_run_takeover_requested",
        }
    }
    pub(super) fn stopped_event(self) -> &'static str {
        match self {
            Self::Cancel => "work_run_cancelled",
            Self::Takeover => "work_run_paused",
        }
    }
    pub(super) fn reconciler(self) -> &'static str {
        match self {
            Self::Cancel => "cancellation_reconciler",
            Self::Takeover => "intervention_reconciler",
        }
    }
}

pub(super) fn command(
    tx: &Transaction,
    id: &str,
    run: &mut Value,
    input: &Command,
    serialized: &str,
    home: &str,
) -> Result<()> {
    if run["home_hub"] != home {
        bail!("intervention requires the run Home")
    }
    match input {
        Command::Takeover {
            request_id, reason, ..
        } => super::work_run_cancellation::request_stop(
            tx,
            id,
            run,
            request_id,
            reason,
            serialized,
            Purpose::Takeover,
        ),
        Command::FinalizeTakeover { request_id, .. } => {
            super::work_run_cancel_final::finalize_stop(
                tx,
                id,
                run,
                request_id,
                serialized,
                Purpose::Takeover,
            )
        }
        Command::Resume {
            request_id, reason, ..
        } => resume(tx, id, run, request_id, reason, serialized),
        _ => bail!("unsupported intervention command"),
    }
}

fn resume(
    tx: &Transaction,
    id: &str,
    run: &mut Value,
    request_id: &str,
    reason: &str,
    serialized: &str,
) -> Result<()> {
    if run["state"] != "paused"
        || run["completion_authorized"] != false
        || !run["cancellation"].is_null()
        || run["intervention"]["stop_confirmed"] != true
        || run["intervention"]["resources_released"] != true
        || run["intervention"]["accounting"] != "finalized"
    {
        bail!("resume requires confirmed paused execution and finalized accounting")
    }
    let at = now();
    let team = run["team_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("run team missing"))?;
    let revision = run["team_revision"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("team revision missing"))?;
    let live = super::team_activation::authorized(tx, team, revision, at)?;
    if live.is_none_or(|activation| {
        activation["snapshot_hash"] != run["authorization"]["snapshot_hash"]
    }) || run["authorization"]["snapshot_hash"].as_str().is_none()
    {
        bail!("resume requires unchanged current team authority")
    }
    let unsettled: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM work_assignments WHERE run_id=?1 AND state NOT IN ('completed','abandoned','interrupted')) OR EXISTS(SELECT 1 FROM assignment_resource_holds h JOIN work_assignments a ON a.id=h.assignment_id WHERE a.run_id=?1 AND h.state='held')",
        [id], |row| row.get(0),
    )?;
    if unsettled {
        bail!("resume requires all Assignments and resource holds to remain settled")
    }
    let superseded = run["stages"].clone();
    let mut task_attempts = serde_json::Map::new();
    if let Some(stages) = run["context"]["binding"]["workflow"]["pack"]["stages"].as_array() {
        for stage in stages {
            let repository = stage["execution"]["repository_binding"].as_str().unwrap_or_default();
            let workspace = &run["task_workspaces"][repository];
            if workspace.is_null() || !stage["execution"]["capabilities"].as_array().is_some_and(|caps| caps.iter().any(|c| c == "workspace_write")) { continue }
            if let Some(previous) = superseded.as_array().unwrap().iter().find(|row| row["stage_id"] == stage["id"]) {
                let next = previous["attempt"].as_u64().unwrap().checked_add(1).ok_or_else(|| anyhow::anyhow!("resumed stage attempt exhausted"))?;
                task_attempts.insert(stage["id"].as_str().unwrap().to_string(), json!({"stage_attempt":next,"task_workspace_key":workspace["key"],"context_hash":run["context_hash"]}));
            }
        }
    }
    for stage in run["stages"]
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("run stages missing"))?
    {
        *stage = json!({"stage_id":stage["stage_id"],"attempt":stage["attempt"],"state":"pending","assignment_id":null});
    }
    run["revision"] = json!(run["revision"].as_u64().unwrap() + 1);
    run["updated_at"] = json!(at);
    run["state"] = json!("waiting_resource");
    run["waiting_reason"] = json!("intervention_revalidation_required");
    run["dispatch_state"] = json!("not_dispatched");
    run["delivery"] = Value::Null;
    run["human_acceptance"] = Value::Null;
    run["intervention"]["resume"] = json!({"request_id":request_id,"reason":reason,"at":at,
        "actor":{"kind":"human","id":"local_owner"},"evidence_policy":"all_stages_revalidate",
        "execution_authorized":false});
    if !task_attempts.is_empty() { run["intervention"]["resume"]["task_workspace_attempts"] = json!(task_attempts); }
    let questions = super::assignment_clarification::clear_pending(run, None);
    if let Some(first) = questions.first() {
        run["intervention"]["resume"]["superseded_clarification"] = first.clone();
        run["intervention"]["resume"]["superseded_clarifications"] = json!(questions);
    }
    let result = run.to_string();
    tx.execute(
        "UPDATE work_runs SET revision=?2,state='waiting_resource',body=?3 WHERE id=?1",
        params![id, run["revision"].as_u64(), result],
    )?;
    tx.execute(
        "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
        params![id, request_id, serialized, result],
    )?;
    tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![id,
        json!({"kind":"work_run_resumed","request_id":request_id,"revision":run["revision"],"at":at,
            "actor":{"kind":"human","id":"local_owner"},"resume":run["intervention"]["resume"],"superseded":superseded}).to_string()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{
        model::Address,
        operations::{self, State},
        store::Store,
    };

    fn seed(store: &Store) -> Value {
        let run = json!({"id":"run","team_id":"team","team_revision":1,"home_hub":"home","revision":1,
            "state":"running","completion_authorized":false,"authorization":{"snapshot_hash":"fixed"},
            "stages":[{"stage_id":"implement","state":"passed","attempt":2,"assignment_id":"old","evidence":{"outputs":{"artifact":7}}}],
            "context_hash":"context","cancellation":null});
        store
            .db
            .lock()
            .execute(
                "INSERT INTO work_runs VALUES ('run','team','create','{}',1,'running',?1,?1)",
                [run.to_string()],
            )
            .unwrap();
        run
    }
    fn takeover(revision: u64) -> Command {
        Command::Takeover {
            request_id: "takeover".into(),
            expected_revision: revision,
            reason: "Inspect the workspace".into(),
        }
    }
    fn finalize(revision: u64) -> Command {
        Command::FinalizeTakeover {
            request_id: "pause".into(),
            expected_revision: revision,
        }
    }
    fn resume_command(revision: u64) -> Command {
        Command::Resume {
            request_id: "resume".into(),
            expected_revision: revision,
            reason: "Manual changes are ready for revalidation".into(),
        }
    }
    #[test]
    fn takeover_is_durable_cas_and_pause_does_not_cancel_or_reuse_evidence() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let original = seed(&store);
        assert!(store.command_work_run("run", resume_command(1)).is_err());
        let intent = store.command_work_run("run", takeover(1)).unwrap();
        assert_eq!(intent["state"], "taking_over");
        assert_eq!(intent["intervention"]["stop_confirmed"], false);
        assert_eq!(store.command_work_run("run", takeover(1)).unwrap(), intent);
        assert!(store.command_work_run("run", takeover(2)).is_err());
        let paused = store.command_work_run("run", finalize(2)).unwrap();
        assert_eq!(paused["state"], "paused");
        assert_eq!(paused["stages"], original["stages"]);
        assert!(paused["cancellation"].is_null());
        assert_eq!(paused["completion_authorized"], false);
        assert!(store
            .active_work_runs(super::super::work_runs::ActiveQuery { after: None })
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(store.command_work_run("run", finalize(2)).unwrap(), paused);
        assert!(store.command_work_run("run", resume_command(3)).is_err());
        assert_eq!(store.work_run("run").unwrap().unwrap(), paused);
    }
    #[test]
    fn takeover_fences_actual_operation_and_refuses_unconfirmed_drain_atomically() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        seed(&store);
        let mut op = store
            .prepare_operation(
                "owner",
                "work",
                Address {
                    node_id: "remote".into(),
                    session_id: "worker".into(),
                },
            )
            .unwrap();
        op.state = State::Active;
        op.lease_until = Some(now() + 60000);
        let original = op.clone();
        let assignment = json!({"id":"a","worker":op.worker,"bundle":{"operation":op},"state":"prepared","revision":1});
        {
            let mut db = store.db.lock();
            let tx = db.transaction().unwrap();
            operations::save(&tx, &op, json!({"kind":"fixture"})).unwrap();
            tx.execute("INSERT INTO work_assignments VALUES ('a','run','implement',2,'team',?1,'prepared',?2)",params![op.id,assignment.to_string()]).unwrap();
            tx.commit().unwrap();
        }
        let intent = store.command_work_run("run", takeover(1)).unwrap();
        let fenced = store.operation(&op.id).unwrap().unwrap();
        assert_eq!(fenced.state, State::Cancelling);
        assert_eq!(fenced.epoch, original.epoch + 1);
        assert!(fenced.lease_until.is_none());
        assert!(store.command_work_run("run", finalize(2)).is_err());
        assert_eq!(store.work_run("run").unwrap().unwrap(), intent);
        assert!(store.command_work_run("run", resume_command(2)).is_err());
        assert!(store
            .work_run_command_receipt("run", "pause")
            .unwrap()
            .unwrap()["receipt"]
            .is_null());
    }

    #[test]
    fn resume_rechecks_authority_invalidates_all_stages_and_preserves_history() {
        use crate::messaging::team_grants::{Capability, Policy, Target, Write};
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        let original = seed(&store);
        let question = json!({"assignment_id":"old","stage_id":"implement","request":{"request_id":"scope","questions":[{"id":"scope","question":"Which scope?"}]}});
        let mut pending = original.clone(); pending["pending_clarification"] = question.clone();
        store.db.lock().execute("UPDATE work_runs SET body=?1 WHERE id='run'", [pending.to_string()]).unwrap();
        let policy = Policy {
            id: "grant".into(),
            team_id: "team".into(),
            enabled: true,
            expires_at: now() + 60000,
            targets: vec![Target {
                host: "home".into(),
                workspace: "project".into(),
                root: "/fixture".into(),
            }],
            capabilities: vec![Capability::Read],
            tools: vec![],
            network: false,
            budget_ids: vec![],
        };
        let grant = store
            .write_team_grant(
                Write {
                    expected_revision: 0,
                    policy: policy.clone(),
                },
                now(),
            )
            .unwrap()["grant"]
            .clone();
        let key = format!(
            "team-activation:{}",
            serde_json::to_string(&("team", "current")).unwrap()
        );
        let activation = json!({"active":true,"team_revision":1,"snapshot_hash":"fixed","snapshot":{"grant":grant}});
        store
            .db
            .lock()
            .execute(
                "INSERT INTO workbench_documents VALUES (?1,1,?2)",
                params![key, activation.to_string()],
            )
            .unwrap();
        store.command_work_run("run", takeover(1)).unwrap();
        let paused = store.command_work_run("run", finalize(2)).unwrap();
        let resumed = store.command_work_run("run", resume_command(3)).unwrap();
        assert_eq!(resumed["state"], "waiting_resource");
        assert!(resumed["pending_clarification"].is_null());
        assert_eq!(resumed["intervention"]["resume"]["superseded_clarification"], question);
        assert_eq!(
            resumed["stages"],
            json!([{"stage_id":"implement","state":"pending","attempt":2,"assignment_id":null}])
        );
        assert_eq!(resumed["context_hash"], original["context_hash"]);
        assert_eq!(resumed["authorization"], original["authorization"]);
        assert_eq!(
            resumed["intervention"]["resume"]["execution_authorized"],
            false
        );
        assert_eq!(store.command_work_run("run", finalize(2)).unwrap(), paused);
        assert_eq!(
            store.command_work_run("run", resume_command(3)).unwrap(),
            resumed
        );
        let history = store.work_run_events("run", 0).unwrap();
        let events = history["events"].as_array().unwrap();
        let event = events
            .iter()
            .find(|event| event["data"]["kind"] == "work_run_resumed")
            .unwrap();
        assert_eq!(event["data"]["superseded"], original["stages"]);
        store
            .command_work_run(
                "run",
                Command::Takeover {
                    request_id: "again".into(),
                    expected_revision: 4,
                    reason: "Check again".into(),
                },
            )
            .unwrap();
        store
            .command_work_run(
                "run",
                Command::FinalizeTakeover {
                    request_id: "pause-again".into(),
                    expected_revision: 5,
                },
            )
            .unwrap();
        let mut revoked = policy;
        revoked.enabled = false;
        store
            .write_team_grant(
                Write {
                    expected_revision: 1,
                    policy: revoked,
                },
                now(),
            )
            .unwrap();
        assert!(store
            .command_work_run(
                "run",
                Command::Resume {
                    request_id: "resume-again".into(),
                    expected_revision: 6,
                    reason: "Try revoked grant".into()
                }
            )
            .is_err());
        assert_eq!(store.work_run("run").unwrap().unwrap()["state"], "paused");
    }
}
