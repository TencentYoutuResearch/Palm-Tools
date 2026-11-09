//! Finalize the frozen delivery policy, independently of individual stage verdicts.
use super::{
    assignment_resources,
    model::{now, valid_id},
    project_configs::{Spec, Target},
    stage_evidence,
    store::Store,
    workflows::{EvidenceRule, Pack},
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finalize {
    pub request_id: String,
    pub expected_revision: u64,
}
impl Store {
    pub fn finalize_work_delivery(&self, id: &str, input: Finalize) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
        {
            bail!("invalid delivery command")
        }
        let request = json!({"action":"finalize_delivery","input":input});
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT request,result FROM work_run_commands WHERE run_id=?1 AND request_id=?2",
                params![id, input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((prior, result)) = prior {
            if serde_json::from_str::<Value>(&prior)? != request {
                bail!("work run command identity conflict")
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let body: String =
            tx.query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))?;
        let mut run: Value = serde_json::from_str(&body)?;
        if run["revision"] != input.expected_revision {
            bail!("work run revision conflict")
        }
        if !matches!(
            run["state"].as_str(),
            Some("waiting_resource" | "queued" | "running")
        ) || run["completion_authorized"] != false
        {
            bail!("work run delivery unavailable")
        }
        let authority = super::team_activation::authorized(
            &tx,
            run["team_id"].as_str().unwrap(),
            run["team_revision"].as_u64().unwrap(),
            at,
        )?;
        if authority.is_none_or(|a| a["snapshot_hash"] != run["authorization"]["snapshot_hash"]) {
            bail!("delivery authority unavailable")
        }
        let pack: Pack =
            serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        let policy = run["context"]["binding"]["delivery_policy"].clone();
        let Spec::DeliveryPolicy {
            targets,
            required_outputs,
            human_acceptance,
            ..
        } = serde_json::from_value(policy["config"]["spec"].clone())?
        else {
            bail!("delivery policy unavailable")
        };
        // External endpoints need their own adapter receipts, never a local substitute.
        if targets.iter().any(|t| !matches!(t, Target::Local { .. })) {
            bail!("delivery target adapter evidence unavailable")
        }
        let states = run["stages"].as_array().unwrap();
        let mut waivers = BTreeMap::new();
        let mut waived_outputs = BTreeMap::new();
        for state in states.iter().filter(|state| state["state"] == "waived") {
            let stage_id = state["stage_id"].as_str().unwrap();
            let decision = super::stage_waiver::require_current(&tx, &run, &pack, stage_id, at)?;
            for output in &pack.stages.iter().find(|s| s.id == stage_id).unwrap().produces {
                waived_outputs.insert(output.clone(), stage_id.to_string());
            }
            waivers.insert(stage_id.to_string(), decision);
        }
        if pack.completion_stages.iter().any(|id| {
            !states
                .iter()
                .any(|s| s["stage_id"] == *id && (s["state"] == "passed" || waivers.contains_key(id)))
        }) {
            bail!("delivery completion stages have not passed")
        }
        let outstanding: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM work_assignments WHERE run_id=?1 AND state NOT IN ('completed','abandoned','interrupted'))",[id],|r|r.get(0))?;
        if outstanding {
            bail!("delivery assignments remain active")
        }
        let held: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM assignment_resource_holds h JOIN work_assignments a ON a.id=h.assignment_id WHERE a.run_id=?1 AND h.state!='released')",[id],|r|r.get(0))?;
        if held {
            bail!("delivery resources remain held")
        }
        let mut outputs = BTreeMap::new();
        let mut artifacts = BTreeMap::new();
        for state in states.iter().filter(|s| s["state"] == "passed") {
            let stage_id = state["stage_id"].as_str().unwrap();
            let stage = pack.stages.iter().find(|s| s.id == stage_id).unwrap();
            let assignment_id = state["assignment_id"].as_str().unwrap();
            let body: String = tx.query_row(
                "SELECT body FROM work_assignments WHERE id=?1",
                [assignment_id],
                |r| r.get(0),
            )?;
            let assignment: Value = serde_json::from_str(&body)?;
            let (_, operation) =
                assignment_resources::authorized_context(&tx, assignment_id, &assignment, at)?;
            if assignment["state"] != "completed"
                || assignment["completion"] != state["completion"]
                || state["completion"]["stage_passed"] != true
                || assignment["resources"]["state"] != "released"
                || state["evidence"]["assignment_id"] != assignment_id
                || state["evidence"]["stage_attempt"] != state["attempt"]
                || operation.state != super::operations::State::Reported
            {
                bail!("delivery completed Assignment evidence mismatch")
            }
            let selected: BTreeMap<String, u64> =
                serde_json::from_value(state["evidence"]["outputs"].clone())?;
            if selected.len() != stage.produces.len()
                || stage.produces.iter().any(|o| !selected.contains_key(o))
                || stage_evidence::check_frozen(&tx, &run, &pack, stage_id, &selected, at)?
                    ["evidence_matches"]
                    != true
            {
                bail!("delivery frozen evidence mismatch")
            }
            for dependency in &stage.requires {
                if !pack.inputs.contains(dependency)
                    && !states
                        .iter()
                        .any(|s| s["stage_id"] == *dependency && (s["state"] == "passed" || waivers.contains_key(dependency)))
                {
                    bail!("delivery dependency has not passed")
                }
            }
            let body: String = tx.query_row(
                "SELECT body FROM budget_reservations WHERE id=?1",
                [assignment["bundle"]["reservation"]["request"]["id"].as_str()],
                |r| r.get(0),
            )?;
            let reservation: Value = serde_json::from_str(&body)?;
            if reservation["finalized"] != true
                || reservation["held"] != 0
                || assignment["accounting"]["receipt"]["reservation"] != reservation
            {
                bail!("delivery accounting unresolved")
            }
            for (output, sequence) in &selected {
                match pack.evidence_rules.get(output) {
                    Some(EvidenceRule::Artifact { repository_binding }) => {
                        let (hash, bytes, complete): (String, u64, bool) = tx.query_row(
                            "SELECT hash,bytes,complete FROM artifact_archives WHERE sequence=?1",
                            [sequence],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                        )?;
                        if !complete {
                            bail!("delivery artifact archive incomplete")
                        }
                        artifacts.insert(output.clone(),json!({"repository_binding":repository_binding,"sequence":sequence,"archive_hash":hash,"bytes":bytes}));
                    }
                    Some(EvidenceRule::Verification { .. }) => {
                        super::verification_record::require_complete(&tx, *sequence, &assignment)?
                    }
                    _ => {}
                }
            }
            outputs.extend(selected);
        }
        if required_outputs.iter().any(|o| !outputs.contains_key(o) && !waived_outputs.contains_key(o)) {
            bail!("delivery required outputs unavailable")
        }
        for target in &targets {
            let Target::Local { repository_binding } = target else {
                unreachable!()
            };
            if !artifacts
                .values()
                .any(|a| a["repository_binding"] == *repository_binding)
            {
                bail!("local delivery requires an archived artifact for its repository")
            }
        }
        if human_acceptance {
            let mut evidence = json!({"context_hash":run["context_hash"],"authorization_hash":run["authorization"]["snapshot_hash"],
                "delivery_policy":policy,"targets":targets,"outputs":outputs,"artifacts":artifacts});
            if !waivers.is_empty() { evidence["waivers"] = json!(waivers); }
            if let Some(pending) = super::work_delivery_decision::require_acceptance(&tx, id, &mut run, &input.request_id, &request, &evidence, at)? {
                tx.commit()?;
                return Ok(pending);
            }
        }
        let mut result = json!({"run_id":id,"run_revision":input.expected_revision+1,"context_hash":run["context_hash"],
            "authorization_hash":run["authorization"]["snapshot_hash"],"delivery_policy":policy,"targets":targets,
            "outputs":outputs,"artifacts":artifacts,"completion_authorized":true,"basis":"frozen_policy_and_archived_evidence","at":at});
        if !run["task_workspaces"].is_null() {
            result["task_workspaces"] = run["task_workspaces"].clone();
            result["integration_state"] = json!("unintegrated");
            result["original_workspace_modified"] = json!(false);
            result["delivery_kind"] = json!("verified_archived_task_artifact");
        }
        if !waivers.is_empty() {
            result["waivers"] = json!(waivers);
            result["waived_outputs"] = json!(waived_outputs);
            result["basis"] = json!("frozen_policy_archived_evidence_and_owner_waivers");
        }
        if human_acceptance { result["human_acceptance"] = run["human_acceptance"].clone(); }
        run["state"] = json!("completed");
        run["completion_authorized"] = json!(true);
        run["waiting_reason"] = Value::Null;
        run["revision"] = json!(input.expected_revision + 1);
        run["updated_at"] = json!(at);
        run["delivery"] = result.clone();
        tx.execute(
            "UPDATE work_runs SET revision=?2,state='completed',body=?3 WHERE id=?1",
            params![
                id,
                input.expected_revision + 1,
                serde_json::to_string(&run)?
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
                serde_json::to_string(
                    &json!({"kind":"work_run_delivered","at":at,"result":result})
                )?
            ],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
