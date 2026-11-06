//! Atomic stage preparation. Outbox entries stay blocked until trusted executor/resource admission exists.
use super::{
    model::{now, valid_id, Address},
    operation_bundle, stage_plan,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepare {
    pub request_id: String,
    pub expected_revision: u64,
    pub target_id: String,
    pub worker_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Abandon {
    pub request_id: String,
    pub expected_revision: u64,
}
pub(super) fn read_run(db: &Connection, id: &str) -> Result<Value> {
    let body: String =
        db.query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))?;
    Ok(serde_json::from_str(&body)?)
}
pub(super) fn retry(
    db: &Connection,
    run: &str,
    request_id: &str,
    request: &Value,
) -> Result<Option<Value>> {
    let old: Option<(String, String)> = db
        .query_row(
            "SELECT request,result FROM work_run_commands WHERE run_id=?1 AND request_id=?2",
            params![run, request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((saved, result)) = old {
        if serde_json::from_str::<Value>(&saved)? != *request {
            bail!("work run command identity conflict")
        }
        return Ok(Some(serde_json::from_str(&result)?));
    }
    Ok(None)
}
fn record(
    db: &Connection,
    run: &Value,
    request_id: &str,
    request: &Value,
    result: &Value,
    kind: &str,
    at: u64,
) -> Result<()> {
    db.execute(
        "UPDATE work_runs SET revision=?2,state=?3,body=?4 WHERE id=?1",
        params![
            run["id"].as_str(),
            run["revision"].as_u64(),
            run["state"].as_str(),
            serde_json::to_string(run)?
        ],
    )?;
    db.execute(
        "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
        params![
            run["id"].as_str(),
            request_id,
            serde_json::to_string(request)?,
            serde_json::to_string(result)?
        ],
    )?;
    db.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![run["id"].as_str(),serde_json::to_string(&json!({"kind":kind,"request_id":request_id,"revision":run["revision"],"at":at,"actor":if request["action"]=="schedule" { json!({"kind":"scheduler","id":run["home_hub"]}) } else { json!({"kind":"human","id":"local_owner"}) },"result":result}))?])?;
    Ok(())
}
pub(super) fn attached(db: &Connection, operation: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM work_assignments WHERE operation_id=?1)",
        [operation],
        |r| r.get(0),
    )?)
}
impl Store {
    pub fn work_assignment(&self, id: &str) -> Result<Option<Value>> {
        if !valid_id(id) {
            bail!("invalid assignment identity")
        }
        let db = self.db.lock();
        let body: Option<String> = db.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| r.get(0)).optional()?;
        body.map(|body| {
            let mut assignment: Value = serde_json::from_str(&body)?;
            // Preserve reads of archived records without an embedded Run identity.
            if assignment["run_id"].is_string() {
                if let Some(ready) = super::assignment_answer_progress::progress(&db, &assignment, &self.node_id)? {
                    assignment["clarification_progress"] = json!({"ready_to_report":ready});
                }
            }
            Ok(assignment)
        }).transpose()
    }
    pub fn prepare_work_assignment(
        &self,
        id: &str,
        stage: &str,
        input: Prepare,
        hosts: &[String],
    ) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(stage)
            || !valid_id(&input.request_id)
            || !valid_id(&input.target_id)
            || input.worker_id.as_ref().is_some_and(|w| !valid_id(w))
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
        {
            bail!("invalid assignment preparation")
        }
        let request = json!({"action":"prepare_assignment","stage_id":stage,"input":input});
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = prepare_in(&tx, id, stage, input, hosts, &request, at)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn abandon_work_assignment(&self, id: &str, input: Abandon) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
        {
            bail!("invalid assignment abandonment")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let at = now();
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        let run_id = assignment["run_id"].as_str().unwrap().to_owned();
        let request = json!({"action":"abandon_assignment","assignment_id":id,"input":input});
        if let Some(result) = retry(&tx, &run_id, &input.request_id, &request)? {
            return Ok(result);
        }
        let mut run = read_run(&tx, &run_id)?;
        if run["revision"] != input.expected_revision {
            bail!("work run revision conflict")
        }
        if assignment["state"] != "prepared"
            || !matches!(
                assignment["dispatch"]["state"].as_str(),
                Some("blocked" | "ready")
            )
        {
            bail!("assignment already dispatched or abandoned")
        }
        let op = &assignment["bundle"]["operation"];
        let settled = operation_bundle::abandon_in(
            &tx,
            op["id"].as_str().unwrap(),
            operation_bundle::Abandon {
                request_id: input.request_id.clone(),
                expected_revision: op["revision"].as_u64().unwrap(),
            },
            at,
        )?;
        assignment["state"] = json!("abandoned");
        assignment["revision"] = json!(assignment["revision"].as_u64().unwrap() + 1);
        tx.execute(
            "UPDATE assignment_resource_holds SET state='released' WHERE assignment_id=?1",
            [id],
        )?;
        if !assignment["resources"].is_null() {
            assignment["resources"]["state"] = json!("released");
        }
        assignment["dispatch"]["state"] = json!("cancelled");
        assignment["abandonment"] = settled;
        tx.execute(
            "UPDATE work_assignments SET state='abandoned',body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute(
            "UPDATE work_dispatch_outbox SET state='cancelled' WHERE assignment_id=?1",
            [id],
        )?;
        let state = run["stages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["assignment_id"] == id)
            .ok_or_else(|| anyhow::anyhow!("assignment stage binding changed"))?;
        state["assignment_id"] = Value::Null;
        state["state"] = json!("pending");
        let remaining: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM work_assignments WHERE run_id=?1 AND state!='abandoned')",
            [&run_id],
            |r| r.get(0),
        )?;
        run["revision"] = json!(input.expected_revision + 1);
        run["updated_at"] = json!(at);
        if !remaining {
            run["dispatch_state"] = json!("not_dispatched");
            run["waiting_reason"] = json!("execution_adapters_not_ready");
        }
        let result = json!({"assignment":assignment,"run_revision":run["revision"]});
        record(
            &tx,
            &run,
            &input.request_id,
            &request,
            &result,
            "work_assignment_abandoned",
            at,
        )?;
        tx.commit()?;
        Ok(result)
    }
}

/// Shared transaction for explicit and policy-selected preparation.
pub(super) fn prepare_in(
    db: &rusqlite::Transaction,
    id: &str,
    stage: &str,
    input: Prepare,
    hosts: &[String],
    request: &Value,
    at: u64,
) -> Result<Value> {
    if let Some(result) = retry(db, id, &input.request_id, request)? {
        return Ok(result);
    }
    let plan = stage_plan::plan_in(db, id, stage, at)?;
    if plan["run_revision"] != input.expected_revision {
        bail!("work run revision conflict")
    }
    let candidate = plan["candidates"]
        .as_array()
        .and_then(|rows| {
            rows.iter().find(|c| {
                c["target_id"] == input.target_id && c["worker_id"] == json!(input.worker_id)
            })
        })
        .ok_or_else(|| anyhow::anyhow!("stage candidate unavailable"))?
        .clone();
    if candidate["recommendation"]["recommended"] != true {
        bail!("stage candidate is not recommended")
    }
    let host = candidate["resource"]["host"].as_str().unwrap();
    if !hosts.iter().any(|h| h == host) {
        bail!("unknown assignment execution host")
    }
    let mut run = read_run(db, id)?;
    let team = run["team_id"].as_str().unwrap().to_owned();
    let count: u64 = db.query_row(
            "SELECT COUNT(*) FROM work_assignments WHERE team_id=?1 AND state NOT IN ('abandoned','completed','cancelled','interrupted')",
            [&team],
            |r| r.get(0),
        )?;
    if count
        >= candidate["team_limits"]["max_active_assignments"]
            .as_u64()
            .unwrap()
    {
        bail!("team assignment capacity exhausted")
    }
    let inputs = super::assignment_inputs::freeze(db, &run, stage, at)?;
    let assignment_id = uuid::Uuid::new_v4().to_string();
    let worker = Address {
        node_id: host.to_owned(),
        session_id: uuid::Uuid::new_v4().to_string(),
    };
    let bundle = operation_bundle::prepare_in(
        db,
        operation_bundle::Request {
            owner_session: run["context"]["team"]["superagent_id"]
                .as_str()
                .unwrap()
                .to_owned(),
            request_key: assignment_id.clone(),
            worker: worker.clone(),
            selection_policy: serde_json::from_value(candidate["selection_policy"].clone())?,
            funding: serde_json::from_value(candidate["funding"].clone())?,
            resource: serde_json::from_value(candidate["resource"].clone())?,
            grant_id: candidate["grant_id"].as_str().unwrap().to_owned(),
            grant_scope: serde_json::from_value(candidate["grant_scope"].clone())?,
        },
        at,
    )?;
    let pricing = if let Some(price_id) = candidate["internal_price"]["id"].as_str() {
        Some(super::pricing::bind_price_in(
            db,
            bundle["reservation"]["request"]["id"].as_str().unwrap(),
            price_id,
        )?)
    } else {
        None
    };
    let attempt = run["stages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["stage_id"] == stage)
        .unwrap()["attempt"]
        .as_u64()
        .unwrap()
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("stage attempt exhausted"))?;
    let mut command = json!({"command_id":assignment_id,"session_id":worker.session_id,"operation":{"id":bundle["operation"]["id"],"attempt":bundle["operation"]["attempt"],"epoch":bundle["operation"]["epoch"]},
            "profile_revision":candidate["selection_policy"]["profile_revision"],"provider":candidate["provider_id"],"model":candidate["selection_policy"]["model"],"effort":candidate["selection_policy"]["effort"],
            "cwd":candidate["grant_scope"]["target"]["root"],"tools":candidate["grant_scope"]["tools"]});
    if worker.node_id != run["home_hub"].as_str().unwrap() {
        command["operation"]["home_node"] = run["home_hub"].clone();
    }
    let mut assignment = json!({"id":assignment_id,"run_id":id,"stage_id":stage,"stage_attempt":attempt,"team_id":team,"revision":1,"state":"prepared","created_at":at,
            "worker":worker,"context_hash":run["context_hash"],"authorization_hash":run["authorization"]["snapshot_hash"],"candidate":candidate,"bundle":bundle,"inputs":inputs,
            "dispatch":{"state":"blocked","command":command,"pending_checks":["trusted_executor_and_tool_admission","resource_locks_and_account_slots","runtime_independence","durable_delivery"]}});
    if let Some(pricing) = pricing {
        assignment["pricing"] = pricing;
    }
    if super::assignment_task_workspace::requires(&assignment) {
        assignment["task_workspace_input"] = super::assignment_task_input::freeze(db, &run, &assignment)?;
    }
    if request["action"] == "schedule" {
        assignment["scheduling"] = json!({"source":"home_policy","strategy":"workflow_order_then_preference_score_identity",
            "request_id":input.request_id,"evaluated_at":at,"recommendation":candidate["recommendation"]});
    }
    db.execute("INSERT INTO work_assignments(id,run_id,stage_id,stage_attempt,team_id,operation_id,state,body) VALUES (?1,?2,?3,?4,?5,?6,'prepared',?7)",params![assignment_id,id,stage,attempt,team,bundle["operation"]["id"].as_str(),serde_json::to_string(&assignment)?])?;
    db.execute(
        "INSERT INTO work_dispatch_outbox(assignment_id,state,body) VALUES (?1,'blocked',?2)",
        params![assignment_id, serde_json::to_string(&command)?],
    )?;
    let state = run["stages"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|s| s["stage_id"] == stage)
        .unwrap();
    state["assignment_id"] = json!(assignment_id);
    state["attempt"] = json!(attempt);
    state["state"] = json!("ready");
    run["revision"] = json!(input.expected_revision + 1);
    run["updated_at"] = json!(at);
    run["dispatch_state"] = json!("prepared");
    run["state"] = json!("waiting_resource");
    run["waiting_reason"] = json!("assignment_executor_admission_required");
    let result = json!({"assignment":assignment,"run_revision":run["revision"]});
    record(
        db,
        &run,
        &input.request_id,
        request,
        &result,
        "work_assignment_prepared",
        at,
    )?;
    Ok(result)
}
