//! Execution Host declarations are immutable candidates; only home selects and completes stages.
use super::{
    assignment_resources,
    model::{now, valid_id},
    stage_evidence,
    store::Store,
    workflows::Pack,
};
use anyhow::{bail, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Declare {
    pub request_id: String,
    pub command: Value,
    pub outputs: BTreeMap<String, u64>,
}
impl Store {
    pub(super) fn declare_assignment_outputs(
        &self,
        executor: &str,
        id: &str,
        input: Declare,
    ) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.outputs.is_empty()
            || input.outputs.len() > 128
            || input
                .outputs
                .values()
                .any(|s| *s == 0 || *s > i64::MAX as u64)
            || serde_json::to_vec(&input)?.len() > 65536
        {
            bail!("invalid Assignment output declaration")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if assignment["worker"]["node_id"] != executor
            || assignment["dispatch"]["command"] != input.command
        {
            bail!("Assignment declaration execution identity mismatch")
        }
        if !assignment["output_declaration"].is_null() {
            if assignment["output_declaration"]["request"] != request {
                bail!("Assignment output declaration identity conflict")
            }
            return Ok(assignment["output_declaration"]["receipt"].clone());
        }
        if assignment["state"] != "prepared" || assignment["creation"]["state"] != "created" {
            bail!("Assignment output creation unavailable")
        }
        let at = now();
        let (run, _) = assignment_resources::authorized_context(&tx, id, &assignment, at)?;
        assignment_resources::assert_held(&tx, &assignment)?;
        if !super::assignment_mandate::consumed(&tx, &assignment, &self.node_id)? {
            bail!("Assignment output consumption unproven")
        }
        let pack: Pack =
            serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        let stage_id = assignment["stage_id"].as_str().unwrap();
        let stage = pack
            .stages
            .iter()
            .find(|s| s.id == stage_id)
            .ok_or_else(|| anyhow::anyhow!("unknown output stage"))?;
        if stage.produces.len() != input.outputs.len()
            || stage
                .produces
                .iter()
                .any(|name| !input.outputs.contains_key(name))
        {
            bail!("Assignment output declaration must be exact")
        }
        for (name, sequence) in &input.outputs {
            if run["context"]["binding"]["workflow"]["pack"]["evidence_rules"][name]["kind"]
                == "artifact"
            {
                let complete: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM artifact_archives WHERE sequence=?1 AND complete=1)", [sequence], |r|r.get(0))?;
                if !complete {
                    bail!("Assignment declared artifact archive incomplete")
                }
            }
        }
        let checked = stage_evidence::check_frozen(&tx, &run, &pack, stage_id, &input.outputs, at)?;
        if checked["evidence_matches"] != true
            && !(stage.on_reject.is_some()
                && stage_evidence::check_frozen_outcome(
                    &tx,
                    &run,
                    &pack,
                    stage_id,
                    &input.outputs,
                    at,
                    true,
                )?["rejection_matches"]
                    == true)
        {
            bail!("Assignment output evidence does not match frozen bindings")
        }
        let receipt = json!({"assignment_id":id,"worker":assignment["worker"],"operation":input.command["operation"],"stage_attempt":assignment["stage_attempt"],"context_hash":assignment["context_hash"],"authorization_hash":assignment["authorization_hash"],"outputs":input.outputs,"state":"outputs_declared","completion_authorized":false,"at":at});
        assignment["output_declaration"] = json!({"request":request,"receipt":receipt});
        assignment["revision"] = json!(assignment["revision"].as_u64().unwrap() + 1);
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)", params![assignment["run_id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_outputs_declared","at":at,"actor":{"kind":"host","id":executor},"receipt":receipt}))?])?;
        tx.commit()?;
        Ok(receipt)
    }
}
