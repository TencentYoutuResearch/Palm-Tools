//! Home-owned stage verdict and resource release in one transaction. A stage is not a delivered WorkRun.
use super::{
    assignment_resources,
    budgets::Reservation,
    model::{now, valid_id},
    operations::State,
    stage_evidence,
    store::Store,
    team_grants::Capability,
    workflows::{EvidenceRule, Pack},
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Complete {
    pub request_id: String,
    pub expected_revision: u64,
    pub assignment_id: String,
}
impl Store {
    pub fn complete_work_stage(&self, id: &str, stage_id: &str, input: Complete) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(stage_id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.assignment_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
        {
            bail!("invalid stage completion command")
        }
        let request = json!({"action":"complete_stage","stage_id":stage_id,"input":input});
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT request,result FROM work_run_commands WHERE run_id=?1 AND request_id=?2",
                params![id, input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((prior, result)) = previous {
            if serde_json::from_str::<Value>(&prior)? != request {
                bail!("work run command identity conflict")
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let body: String = tx.query_row(
            "SELECT body FROM work_assignments WHERE id=?1",
            [&input.assignment_id],
            |r| r.get(0),
        )?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if assignment["state"] != "prepared"
            || assignment["run_id"] != id
            || assignment["stage_id"] != stage_id
        {
            bail!("stage completion Assignment unavailable")
        }
        let (mut run, operation) =
            assignment_resources::authorized_context(&tx, &input.assignment_id, &assignment, at)?;
        if run["revision"] != input.expected_revision {
            bail!("work run revision conflict")
        }
        assignment_resources::assert_held(&tx, &assignment)?;
        super::assignment_answer_progress::require_resolved(&tx, &assignment, &self.node_id)?;
        let pack: Pack =
            serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        let stage = pack
            .stages
            .iter()
            .find(|s| s.id == stage_id)
            .ok_or_else(|| anyhow::anyhow!("unknown stage"))?;
        // Unsupported proofs remain explicit gates, never substituted by an Agent's verdict.
        let scope = stage
            .execution
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("stage execution scope missing"))?;
        let artifact_stage = stage.independent_from.is_empty()
            && stage.produces.iter().all(|o| {
                matches!(
                    pack.evidence_rules.get(o),
                    Some(EvidenceRule::Artifact { .. })
                )
            });
        let review_stage = !assignment["execution_workspace"].is_null()
            && scope.capabilities.iter().all(|c| *c == Capability::Read)
            && stage.produces.iter().all(|o| {
                matches!(
                    pack.evidence_rules.get(o),
                    Some(EvidenceRule::Review { .. } | EvidenceRule::Verification { .. })
                )
            });
        if scope.network
            || stage.produces.is_empty()
            || (!artifact_stage && !review_stage)
            || scope
                .capabilities
                .iter()
                .any(|c| !matches!(c, Capability::Read | Capability::WorkspaceWrite))
        {
            bail!("stage requires additional independent or external execution proof")
        }
        let state = run["stages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["stage_id"] == stage_id)
            .unwrap();
        let selection = state["evidence"].clone();
        let rejected = selection["outcome"] == "rejected";
        if state["state"] != "ready" || selection.is_null() {
            bail!("stage selected evidence required")
        }
        for dependency in &stage.requires {
            if !pack.inputs.contains(dependency)
                && !super::stage_waiver::dependency_satisfied(&tx, &run, &pack, dependency, at)?
            {
                bail!("stage dependency not passed")
            }
        }
        let stop = &assignment["stop"]["receipt"];
        if operation.state != State::Reported
            || stop["state"] != "execution_drained"
            || stop["operation"]["attempt"] != operation.attempt
            || stop["operation"]["epoch"] != operation.epoch
        {
            bail!("stage final artifact and reported stop required")
        }
        if artifact_stage {
            if stop["final_artifact"]["assignment_id"] != input.assignment_id
                || stop["final_artifact"]["selection"] != selection
            {
                bail!("stage final artifact selection required")
            }
        } else {
            let proof: super::assignment_final_input::Proof =
                serde_json::from_value(stop["final_input"].clone())?;
            super::assignment_final_input::validate(&tx, &assignment, &operation, &proof)?;
            if proof.selection != selection {
                bail!("review final input selection required")
            }
        }
        let selected: BTreeMap<String, u64> = serde_json::from_value(selection["outputs"].clone())?;
        if selected.len() != stage.produces.len()
            || stage.produces.iter().any(|o| !selected.contains_key(o))
        {
            bail!("stage outputs must be exact")
        }
        if stage_evidence::check_frozen_outcome(
            &tx, &run, &pack, stage_id, &selected, at, rejected,
        )?[if rejected {
            "rejection_matches"
        } else {
            "evidence_matches"
        }] != true
        {
            bail!("stage evidence no longer matches frozen bindings")
        }
        for sequence in selected.values() {
            let body: String = tx.query_row(
                "SELECT body FROM operation_events WHERE seq=?1",
                [sequence],
                |r| r.get(0),
            )?;
            let event: Value = serde_json::from_str(&body)?;
            if artifact_stage {
                let complete: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM artifact_archives WHERE sequence=?1 AND complete=1)",[sequence],|r|r.get(0))?;
                if !complete || event["snapshot_hash"] != stop["final_artifact"]["snapshot_hash"] {
                    bail!("stage archive or final snapshot missing")
                }
            } else {
                let payload = &event["evidence"]["payload"];
                if (payload["kind"] != "review" && payload["kind"] != "verification")
                    || payload["artifact_sequence"] != stop["final_input"]["source_sequence"]
                    || payload["snapshot_hash"] != stop["final_input"]["snapshot_hash"]
                {
                    bail!("review or verification evidence does not match final input")
                }
                if payload["kind"] == "verification" {
                    super::verification_record::require_outcome(
                        &tx,
                        *sequence,
                        &assignment,
                        rejected,
                    )?;
                }
            }
        }
        let mut tools=tx.prepare("SELECT seq FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='tool_evidence' AND json_extract(body,'$.evidence.attempt')=?2 AND json_extract(body,'$.evidence.status')='uncertain'")?;
        for sequence in tools.query_map(params![operation.id, operation.attempt], |r| {
            r.get::<_, u64>(0)
        })? {
            if super::tool_resolution::read(&tx, &operation.id, sequence?)?
                .is_none_or(|r| r["resolution"]["decision"] != "verified_applied")
            {
                bail!("stage tool outcome remains unresolved")
            }
        }
        let reservation_id = assignment["bundle"]["reservation"]["request"]["id"]
            .as_str()
            .unwrap();
        let body: String = tx.query_row(
            "SELECT body FROM budget_reservations WHERE id=?1",
            [reservation_id],
            |r| r.get(0),
        )?;
        let reservation: Reservation = serde_json::from_str(&body)?;
        if !reservation.finalized
            || reservation.held != 0
            || assignment["accounting"]["receipt"]["reservation"]
                != serde_json::to_value(&reservation)?
        {
            bail!("stage finalized Assignment accounting required")
        }
        let unresolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM official_calls WHERE operation_id=?1 AND attempt=?2 AND state!='finished')",params![operation.id,operation.attempt],|r|r.get(0))?;
        if unresolved {
            bail!("stage usage remains unresolved")
        }
        let mut result = json!({"run_id":id,"run_revision":input.expected_revision+1,"stage_id":stage_id,"assignment_id":input.assignment_id,
            "stage_passed":!rejected,"resources_released":true,"completion_authorized":false,"at":at});
        if rejected {
            result["stage_rejected"] = json!(true);
        }
        let state = run["stages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["stage_id"] == stage_id)
            .unwrap();
        state["state"] = json!(if rejected { "rejected" } else { "passed" });
        state["completion"] = result.clone();
        let all = pack.completion_stages.iter().all(|id| {
            run["stages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["stage_id"] == *id && s["state"] == "passed")
        });
        run["revision"] = json!(input.expected_revision + 1);
        run["updated_at"] = json!(at);
        run["waiting_reason"] = json!(if all {
            "delivery_finalization_pending"
        } else {
            "stage_dispatch_pending"
        });
        if rejected {
            result["stage_rejected"] = json!(true);
            result["rework"] = super::stage_rework::apply(
                &tx,
                &mut run,
                &pack,
                stage_id,
                &input.assignment_id,
                at,
            )?;
        }
        if rejected && result["rework"]["scheduled"] == false {
            run["stages"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|state| state["stage_id"] == stage_id)
                .unwrap()["completion"] = result.clone();
        }
        assignment["state"] = json!("completed");
        assignment["revision"] = json!(assignment["revision"].as_u64().unwrap() + 1);
        assignment["resources"]["state"] = json!("released");
        assignment["completion"] = result.clone();
        tx.execute(
            "UPDATE assignment_resource_holds SET state='released' WHERE assignment_id=?1",
            [&input.assignment_id],
        )?;
        tx.execute(
            "UPDATE work_assignments SET state='completed',body=?2 WHERE id=?1",
            params![input.assignment_id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute(
            "UPDATE work_runs SET state=?4,revision=?2,body=?3 WHERE id=?1",
            params![
                id,
                input.expected_revision + 1,
                serde_json::to_string(&run)?,
                run["state"].as_str()
            ],
        )?;
        tx.execute(
            "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
            params![
                id,
                input.request_id,
                serde_json::to_string(&request)?,
                serde_json::to_string(&result)?
            ],
        )?;
        tx.execute(
            "INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",
            params![
                id,
                serde_json::to_string(&json!({"kind":if rejected { "stage_rejected" } else { "stage_passed" },"at":at,"result":result}))?
            ],
        )?;
        drop(tools);
        tx.commit()?;
        Ok(result)
    }
}
