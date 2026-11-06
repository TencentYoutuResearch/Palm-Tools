//! Select immutable stage output observations under frozen WorkRun bindings, without declaring completion.
use super::{
    assignment_resources,
    model::{now, valid_id},
    store::Store,
    workflow_evidence,
    workflows::Pack,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Select {
    pub request_id: String,
    pub expected_revision: u64,
    pub assignment_id: String,
    pub outputs: BTreeMap<String, u64>,
}
impl Store {
    /// Read only the observation selected by this exact current stage attempt.
    pub fn selected_stage_output(&self, id: &str, stage_id: &str, output: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(stage_id) || !valid_id(output) {
            bail!("invalid selected output identity")
        }
        let db = self.db.lock();
        let body: Option<String> = db.query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0)).optional()?;
        let Some(body) = body else { return Ok(None); };
        let run: Value = serde_json::from_str(&body)?;
        let stage = run["stages"].as_array().and_then(|rows| rows.iter().find(|row| row["stage_id"] == stage_id));
        let Some(stage) = stage else { return Ok(None); };
        let selected = &stage["evidence"];
        let Some(sequence) = selected["outputs"][output].as_u64() else { return Ok(None); };
        if selected["assignment_id"] != stage["assignment_id"] || selected["stage_attempt"] != stage["attempt"] || selected["context_hash"] != run["context_hash"] {
            bail!("selected output context mismatch")
        }
        let assignment_id = stage["assignment_id"].as_str().ok_or_else(|| anyhow::anyhow!("missing selected assignment"))?;
        let assignment: String = db.query_row("SELECT body FROM work_assignments WHERE id=?1", [assignment_id], |r| r.get(0))?;
        let assignment: Value = serde_json::from_str(&assignment)?;
        let operation = &assignment["bundle"]["operation"];
        let event: String = db.query_row("SELECT body FROM operation_events WHERE seq=?1 AND json_extract(body,'$.kind')='artifact_evidence'", [sequence], |r| r.get(0))?;
        let event: Value = serde_json::from_str(&event)?;
        let evidence = &event["evidence"];
        if evidence["operation_id"] != operation["id"] || evidence["attempt"] != operation["attempt"] || evidence["epoch"] != operation["epoch"] {
            bail!("selected output operation mismatch")
        }
        let evidence: super::artifact_evidence::Evidence = serde_json::from_value(evidence.clone())?;
        Ok(Some(json!({"home_hub":self.node_id,"team_id":run["team_id"],"run_id":id,"run_revision":run["revision"],
            "stage_id":stage_id,"stage_attempt":stage["attempt"],"assignment_id":assignment_id,"output":output,
            "sequence":sequence,"evidence":evidence,"completion_authorized":false})))
    }
    pub fn select_stage_evidence(&self, id: &str, stage_id: &str, input: Select) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(stage_id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.assignment_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
            || input.outputs.len() > 128
            || input
                .outputs
                .values()
                .any(|s| *s == 0 || *s > i64::MAX as u64)
        {
            bail!("invalid stage evidence selection")
        }
        let request = json!({"action":"select_evidence","stage_id":stage_id,"input":input});
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
        if let Some((saved, result)) = previous {
            if serde_json::from_str::<Value>(&saved)? != request {
                bail!("work run command identity conflict")
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let body: String = tx.query_row(
            "SELECT body FROM work_assignments WHERE id=?1",
            [&input.assignment_id],
            |r| r.get(0),
        )?;
        let assignment: Value = serde_json::from_str(&body)?;
        if assignment["run_id"] != id
            || assignment["stage_id"] != stage_id
            || assignment["state"] != "prepared"
            || assignment["creation"]["state"] != "created"
        {
            bail!("stage assignment unavailable")
        }
        let (mut run, _) =
            assignment_resources::authorized_context(&tx, &input.assignment_id, &assignment, at)?;
        assignment_resources::assert_held(&tx, &assignment)?;
        if run["revision"] != input.expected_revision {
            bail!("work run revision conflict")
        }
        let pack: Pack =
            serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        let stage = pack
            .stages
            .iter()
            .find(|s| s.id == stage_id)
            .ok_or_else(|| anyhow::anyhow!("unknown stage"))?;
        if input.outputs.len() != stage.produces.len()
            || stage
                .produces
                .iter()
                .any(|s| !input.outputs.contains_key(s))
        {
            bail!("stage output selection must be exact")
        }
        let consumed = super::assignment_mandate::consumed(&tx, &assignment, &self.node_id)?;
        if !consumed {
            bail!("stage mandate consumption unproven")
        }
        for dependency in &stage.requires {
            if !pack.inputs.contains(dependency)
                && !super::stage_waiver::dependency_satisfied(&tx, &run, &pack, dependency, at)?
            {
                bail!("stage dependency evidence unavailable")
            }
        }
        if run["stages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["stage_id"] == stage_id && !s["evidence"].is_null())
        {
            bail!("stage evidence already selected; a new attempt is required")
        }
        let checked = check_frozen(&tx, &run, &pack, stage_id, &input.outputs, at)?;
        let rejected = checked["evidence_matches"] != true
            && stage.on_reject.is_some()
            && check_frozen_outcome(&tx, &run, &pack, stage_id, &input.outputs, at, true)?
                ["rejection_matches"]
                == true;
        if checked["evidence_matches"] != true && !rejected {
            bail!(
                "stage evidence does not match frozen bindings: {}",
                checked["issues"]
            )
        }
        let mut selection = json!({"assignment_id":input.assignment_id,"stage_attempt":assignment["stage_attempt"],"outputs":input.outputs,"context_hash":run["context_hash"],"authorization_hash":run["authorization"]["snapshot_hash"],"selected_at":at});
        if rejected {
            selection["outcome"] = json!("rejected");
        }
        run["stages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|s| s["stage_id"] == stage_id)
            .unwrap()["evidence"] = selection.clone();
        run["revision"] = json!(input.expected_revision + 1);
        run["updated_at"] = json!(at);
        let result = json!({"run_id":id,"run_revision":run["revision"],"stage_id":stage_id,"selection":selection,"binding_context":"frozen_workrun","completion_authorized":false,"pending_checks":["reported_operation","execution_stopped","usage_settlement","stage_finalization","trusted_verification_execution","independent_context","delivery_policy"]});
        tx.execute(
            "UPDATE work_runs SET revision=?2,body=?3 WHERE id=?1",
            params![id, run["revision"].as_u64(), serde_json::to_string(&run)?],
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
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![id,serde_json::to_string(&json!({"kind":"stage_evidence_selected","at":at,"actor":{"kind":"host","id":self.node_id},"result":result}))?])?;
        tx.commit()?;
        Ok(result)
    }
}

pub(super) fn check_frozen(
    tx: &rusqlite::Connection,
    run: &Value,
    pack: &Pack,
    stage_id: &str,
    selected: &BTreeMap<String, u64>,
    at: u64,
) -> Result<Value> {
    check_frozen_outcome(tx, run, pack, stage_id, selected, at, false)
}
pub(super) fn check_frozen_outcome(
    tx: &rusqlite::Connection,
    run: &Value,
    pack: &Pack,
    stage_id: &str,
    selected: &BTreeMap<String, u64>,
    at: u64,
    rejected: bool,
) -> Result<Value> {
    let mut assignments = serde_json::Map::new();
    let mut outputs = serde_json::Map::new();
    for state in run["stages"].as_array().unwrap() {
        if let Some(assigned) = state["assignment_id"].as_str() {
            let body: String = tx.query_row(
                "SELECT body FROM work_assignments WHERE id=?1",
                [assigned],
                |r| r.get(0),
            )?;
            let row: Value = serde_json::from_str(&body)?;
            let op = &row["bundle"]["operation"];
            assignments.insert(
                state["stage_id"].as_str().unwrap().into(),
                json!({"operation_id":op["id"],"attempt":op["attempt"],"epoch":op["epoch"]}),
            );
        }
        if let Some(selected) = state["evidence"]["outputs"].as_object() {
            outputs.extend(selected.clone());
        }
    }
    outputs.extend(
        selected
            .iter()
            .map(|(key, value)| (key.clone(), json!(value))),
    );
    let project = &run["context"]["binding"]["project"]["config"]["spec"];
    let repositories: BTreeMap<_, _> = project["repositories"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v["repository_id"].clone()))
        .collect();
    let commands: BTreeMap<_, _> = project["commands"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), json!({"id":v["id"],"revision":v["revision"]})))
        .collect();
    let environments: BTreeMap<_, _> = project["environments"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v["configuration_hash"].clone()))
        .collect();
    let workflow = &run["context"]["binding"]["workflow"];
    let check = serde_json::from_value(
        json!({"workflow":{"id":pack.id,"version":pack.version,"hash":workflow["hash"]},"stage_id":stage_id,"assignments":assignments,"outputs":outputs,"repositories":repositories,"commands":commands,"environments":environments}),
    )?;
    return workflow_evidence::check_outcome(tx, pack, &check, at, rejected);
}

#[cfg(test)]
mod selected_output_tests {
    use super::*;
    #[test]
    fn selected_output_is_scoped_to_current_assignment_and_attempt() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        let run = json!({"id":"run","team_id":"team","revision":2,"context_hash":"context","stages":[{
            "stage_id":"review","assignment_id":"assignment","attempt":1,"evidence":{
                "assignment_id":"assignment","stage_attempt":1,"context_hash":"context","outputs":{"report":1}}}]});
        let assignment = json!({"bundle":{"operation":{"id":"operation","attempt":2,"epoch":3}}});
        let event = json!({"kind":"artifact_evidence","evidence":{"id":"evidence","operation_id":"operation","attempt":2,"epoch":3,
            "payload":{"kind":"review","artifact_sequence":9,"snapshot_hash":"hash","verdict":"passed","findings":[]}}});
        {
            let db = store.db.lock();
            db.execute("INSERT INTO work_runs VALUES ('run','team','request','{}',2,'running',?1,?1)", [run.to_string()]).unwrap();
            db.execute("INSERT INTO work_assignments VALUES ('assignment','run','review',1,'team','operation','prepared',?1)", [assignment.to_string()]).unwrap();
            db.execute("INSERT INTO operation_events(seq,operation_id,body) VALUES (1,'operation',?1)", [event.to_string()]).unwrap();
        }
        let output = store.selected_stage_output("run", "review", "report").unwrap().unwrap();
        assert_eq!(output["evidence"]["payload"]["verdict"], "passed");
        assert_eq!(output["completion_authorized"], false);
        assert!(store.selected_stage_output("run", "review", "other").unwrap().is_none());
        assert!(store.selected_stage_output("other", "review", "report").unwrap().is_none());
        let mut changed = run;
        changed["stages"][0]["attempt"] = json!(2);
        store.db.lock().execute("UPDATE work_runs SET body=?1 WHERE id='run'", [changed.to_string()]).unwrap();
        assert!(store.selected_stage_output("run", "review", "report").is_err());
        changed["stages"][0]["attempt"] = json!(1);
        store.db.lock().execute("UPDATE work_runs SET body=?1 WHERE id='run'", [changed.to_string()]).unwrap();
        let mut event = event; event["evidence"]["epoch"] = json!(4);
        store.db.lock().execute("UPDATE operation_events SET body=?1 WHERE seq=1", [event.to_string()]).unwrap();
        assert!(store.selected_stage_output("run", "review", "report").is_err());
    }
}
