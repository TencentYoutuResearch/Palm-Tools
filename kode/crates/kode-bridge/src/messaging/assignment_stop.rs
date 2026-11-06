//! Trusted execution Host drain receipts; no budget release or workflow completion.
use super::{
    model::{now, valid_id},
    operations::{self, Operation, State},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinalArtifact {
    pub assignment_id: String,
    pub selection: Value,
    pub snapshot_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: String,
    pub command: Value,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_artifact: Option<FinalArtifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_input: Option<super::assignment_final_input::Proof>,
}
impl Store {
    pub fn assignment_stop_receipt(&self, id: &str, input: Receipt) -> Result<Value> {
        self.assignment_stop_receipt_from(&self.node_id, id, input)
    }
    pub(super) fn assignment_stop_receipt_from(
        &self,
        executor: &str,
        id: &str,
        input: Receipt,
    ) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.kind
                != if executor == self.node_id {
                    "official_local_drained"
                } else {
                    "official_remote_drained"
                }
            || serde_json::to_vec(&input)?.len() > 65536
        {
            bail!("invalid Assignment stop receipt")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if assignment["worker"]["node_id"] != executor {
            bail!("Assignment stop execution Host mismatch")
        }
        if !assignment["stop"].is_null() {
            if assignment["stop"]["request"] != request {
                bail!("Assignment stop receipt identity conflict")
            }
            return Ok(assignment["stop"]["receipt"].clone());
        }
        if assignment["dispatch"]["command"] != input.command
            || assignment["state"] != "prepared"
            || assignment["creation"]["state"] != "created"
            || assignment["admission"].is_null()
        {
            bail!("Assignment stop identity or creation mismatch")
        }
        let operation_id = assignment["bundle"]["operation"]["id"].as_str().unwrap();
        let body: String = tx.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [operation_id],
            |r| r.get(0),
        )?;
        let mut operation: Operation = serde_json::from_str(&body)?;
        if input.command["operation"]["attempt"] != operation.attempt
            || input.command["operation"]["epoch"]
                .as_u64()
                .is_none_or(|epoch| epoch > operation.epoch)
            || operation.state == State::Prepared
        {
            bail!("Assignment stop operation changed")
        }
        let claimed:Option<u64>=tx.query_row("SELECT seq FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='command' AND json_extract(body,'$.command.action.kind') IN ('claim','claim_resource') AND json_extract(body,'$.command.attempt')=?2 AND json_extract(body,'$.command.epoch')=?3 ORDER BY seq LIMIT 1", params![operation_id,operation.attempt,input.command["operation"]["epoch"].as_u64()], |r|r.get(0)).optional()?;
        if claimed.is_none() {
            bail!("Assignment stop has no claimed operation")
        }
        if let Some(proof) = &input.final_input {
            super::assignment_final_input::validate(&tx, &assignment, &operation, proof)?;
        }
        if let Some(proof) = &input.final_artifact {
            if proof.assignment_id != id
                || !super::artifact_archive_format::valid_hash(&proof.snapshot_hash)
                || operation.state != State::Reported
                || input.command["operation"]["epoch"] != operation.epoch
            {
                bail!("final artifact report identity mismatch")
            }
            let body: String = tx.query_row(
                "SELECT body FROM work_runs WHERE id=?1",
                [assignment["run_id"].as_str()],
                |r| r.get(0),
            )?;
            let run: Value = serde_json::from_str(&body)?;
            let stage = run["stages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["stage_id"] == assignment["stage_id"])
                .ok_or_else(|| anyhow::anyhow!("final artifact stage missing"))?;
            if stage["assignment_id"] != id
                || stage["attempt"] != assignment["stage_attempt"]
                || stage["evidence"] != proof.selection
                || proof.selection["context_hash"] != assignment["context_hash"]
                || proof.selection["authorization_hash"] != assignment["authorization_hash"]
            {
                bail!("final artifact selection mismatch")
            }
            let outputs = proof.selection["outputs"]
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("final artifact outputs missing"))?;
            if outputs.is_empty() {
                bail!("final artifact outputs missing")
            }
            let mut artifact_count = 0;
            for (output, value) in outputs {
                if run["context"]["binding"]["workflow"]["pack"]["evidence_rules"][output]["kind"]
                    != "artifact"
                {
                    continue;
                }
                artifact_count += 1;
                let sequence = value
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("invalid final artifact sequence"))?;
                let body: String = tx.query_row(
                    "SELECT body FROM operation_events WHERE seq=?1",
                    [sequence],
                    |r| r.get(0),
                )?;
                let event: Value = serde_json::from_str(&body)?;
                let archived:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM artifact_archives WHERE sequence=?1 AND complete=1)",[sequence],|r|r.get(0))?;
                if !archived
                    || event["kind"] != "artifact_evidence"
                    || event["evidence"]["payload"]["kind"] != "artifact"
                    || event["evidence"]["operation_id"] != operation.id
                    || event["evidence"]["attempt"] != operation.attempt
                    || event["evidence"]["epoch"] != operation.epoch
                    || event["snapshot_hash"] != proof.snapshot_hash
                {
                    bail!("final artifact snapshot or archive mismatch")
                }
            }
            if artifact_count == 0 {
                bail!("final artifact outputs missing")
            }
        }
        let at = now();
        // Reported already prohibits execution and retains evidence identity.
        // An interrupted active/uncertain attempt is fenced and cannot pass a stage.
        if !matches!(operation.state, State::Reported | State::Stopped) {
            operation.state = State::Stopped;
            operation.epoch += 1;
            operation.revision += 1;
            operation.lease_until = None;
        }
        let receipt = json!({"assignment_id":id,"session_id":input.command["session_id"],"kind":input.kind,
            "state":"execution_drained","operation":operation,"at":at,"completion_authorized":false,
            "resources_released":false,"accounting":"pending","external_effects":"not_attested","final_artifact":input.final_artifact,"final_input":input.final_input});
        operations::save(
            &tx,
            &operation,
            json!({"kind":"assignment_execution_drained","assignment_id":id,"at":at,"receipt":receipt}),
        )?;
        assignment["stop"] = json!({"request":request,"receipt":receipt});
        assignment["revision"] = json!(assignment["revision"].as_u64().unwrap() + 1);
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute(
            "UPDATE work_dispatch_outbox SET state='stopped' WHERE assignment_id=?1",
            [id],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![assignment["run_id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_execution_drained","actor":{"kind":"host","id":executor},"at":at,"receipt":receipt}))?])?;
        tx.commit()?;
        Ok(receipt)
    }
}
