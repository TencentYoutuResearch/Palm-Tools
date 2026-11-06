//! Home-Hub policy selection and Assignment preparation share one serialized transaction.
use super::{
    model::{now, valid_id},
    stage_plan,
    store::Store,
    work_assignments,
    workflows::Pack,
};
use anyhow::{bail, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    pub request_id: String,
    pub expected_revision: u64,
}
impl Store {
    pub fn schedule_work_run(&self, id: &str, input: Schedule, hosts: &[String]) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
        {
            bail!("invalid work run schedule command")
        }
        let request = json!({"action":"schedule","input":input});
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(result) = work_assignments::retry(&tx, id, &input.request_id, &request)? {
            return Ok(result);
        }
        let run = work_assignments::read_run(&tx, id)?;
        if run["revision"] != input.expected_revision {
            bail!("work run revision conflict")
        }
        let pack: Pack =
            serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        // Workflow order is the deterministic tie-break for independent ready stages.
        // Candidate preferences and scores remain the activated policy's inputs.
        for stage in &pack.stages {
            let plan = stage_plan::plan_in(&tx, id, &stage.id, at)?;
            let mut candidates: Vec<&Value> = plan["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| {
                    c["recommendation"]["recommended"] == true
                        && c["resource"]["host"]
                            .as_str()
                            .is_some_and(|h| hosts.iter().any(|known| known == h))
                })
                .collect();
            candidates.sort_by(|a, b| {
                b["preferred"]
                    .as_bool()
                    .cmp(&a["preferred"].as_bool())
                    .then_with(|| {
                        b["recommendation"]["assessment"]["score"]
                            .as_f64()
                            .unwrap()
                            .total_cmp(
                                &a["recommendation"]["assessment"]["score"].as_f64().unwrap(),
                            )
                    })
                    .then_with(|| a["target_id"].as_str().cmp(&b["target_id"].as_str()))
                    .then_with(|| a["worker_id"].as_str().cmp(&b["worker_id"].as_str()))
            });
            let Some(candidate) = candidates.first() else {
                continue;
            };
            let result = work_assignments::prepare_in(
                &tx,
                id,
                &stage.id,
                work_assignments::Prepare {
                    request_id: input.request_id.clone(),
                    expected_revision: input.expected_revision,
                    target_id: candidate["target_id"].as_str().unwrap().to_owned(),
                    worker_id: candidate["worker_id"].as_str().map(str::to_owned),
                },
                hosts,
                &request,
                at,
            );
            let result = match result {
                Ok(result) => result,
                Err(error) if error.downcast_ref::<super::budgets::InsufficientBudget>().is_some() => {
                    // Roll back all partial Assignment preparation before recording the wait.
                    // Keep the database mutex: no other command can change this run between
                    // the failed reservation and its durable, deduplicated explanation.
                    tx.rollback()?;
                    let tx = db.transaction()?;
                    let mut waiting = run.clone();
                    if waiting["state"] != "waiting_resource"
                        || waiting["waiting_reason"] != "team_budget_exhausted"
                    {
                        waiting["state"] = json!("waiting_resource");
                        waiting["waiting_reason"] = json!("team_budget_exhausted");
                        waiting["revision"] = json!(input.expected_revision + 1);
                        waiting["updated_at"] = json!(at);
                        tx.execute("UPDATE work_runs SET state='waiting_resource',revision=?2,body=?3 WHERE id=?1",
                            params![id, input.expected_revision + 1, waiting.to_string()])?;
                        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",
                            params![id, json!({"kind":"work_run_budget_wait","revision":waiting["revision"],
                                "stage_id":stage.id,"reason":"team_budget_exhausted","at":at,
                                "actor":{"kind":"system","id":"home_scheduler"}}).to_string()])?;
                    }
                    tx.commit()?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            tx.commit()?;
            return Ok(result);
        }
        bail!("no schedulable stage with a recommended known execution target")
    }
}
