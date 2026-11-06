//! Freeze the content basis for a writable task checkout; task identity alone is not input evidence.
use anyhow::{bail, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
pub(super) fn freeze(db: &Connection, run: &Value, assignment: &Value) -> Result<Value> {
    let pack = &run["context"]["binding"]["workflow"]["pack"];
    let stage = pack["stages"].as_array().and_then(|stages| stages.iter().find(|s| s["id"] == assignment["stage_id"]))
        .ok_or_else(|| anyhow::anyhow!("task input stage unavailable"))?;
    let repository = stage["execution"]["repository_binding"].as_str().ok_or_else(|| anyhow::anyhow!("task input repository unavailable"))?;
    let binding = &assignment["inputs"]["binding"];
    let sources = binding["sources"].as_object().ok_or_else(|| anyhow::anyhow!("task frozen input sources unavailable"))?;
    let rework = &binding["rework"];
    if !rework.is_null() {
        let previous = rework["superseded"].as_array().and_then(|rows| rows.iter().find(|s| s["stage_id"] == assignment["stage_id"]))
            .ok_or_else(|| anyhow::anyhow!("task rework previous target unavailable"))?;
        let body: String = db.query_row("SELECT body FROM work_assignments WHERE id=?1", [previous["assignment_id"].as_str()], |r| r.get(0))?;
        let previous_assignment: Value = serde_json::from_str(&body)?;
        if previous_assignment["run_id"] != assignment["run_id"] || previous_assignment["stage_id"] != assignment["stage_id"]
            || previous_assignment["stage_attempt"] != previous["attempt"] || previous_assignment["state"] != "completed"
            || previous_assignment["execution_workspace"]["receipt"]["kind"] != "derived_task_worktree" {
            bail!("task rework previous workspace binding unavailable")
        }
        let mut choices = Vec::new();
        for (output, sequence) in previous["evidence"]["outputs"].as_object().ok_or_else(|| anyhow::anyhow!("task rework output unavailable"))? {
            if pack["evidence_rules"][output]["kind"] != "artifact" { continue }
            if pack["evidence_rules"][output]["repository_binding"] != repository { bail!("task rework repository mapping unsupported") }
            let sequence = sequence.as_u64().ok_or_else(|| anyhow::anyhow!("invalid rework artifact sequence"))?;
            let body: String = db.query_row("SELECT body FROM operation_events WHERE seq=?1", [sequence], |r| r.get(0))?;
            let event: Value = serde_json::from_str(&body)?;
            let complete: bool = db.query_row("SELECT complete FROM artifact_archives WHERE sequence=?1", [sequence], |r| r.get(0))?;
            if !complete || event["evidence"]["payload"]["kind"] != "artifact" { bail!("task rework artifact unavailable") }
            choices.push(json!({"basis":"rework_artifact","source_sequence":sequence,"snapshot_hash":event["snapshot_hash"]}));
        }
        return single(choices)
    }
    // Legacy inputs keep their existing path; only a declared mapping needs typed selection.
    if !stage["execution"]["input_artifact"].is_null() {
        let typed_stage: super::workflows::Stage = serde_json::from_value(stage.clone())?;
        if let Some(output) = super::workflow_input_artifact::selected(&typed_stage, &binding["sources"])? {
            return Ok(json!({"basis":"frozen_artifact","source_sequence":output["sequence"],"snapshot_hash":output["artifact"]["snapshot_hash"]}))
        }
    }
    let mut choices = Vec::new();
    for producer in sources.values() {
        for output in producer["outputs"].as_object().ok_or_else(|| anyhow::anyhow!("task frozen producer outputs unavailable"))?.values() {
            let artifact = &output["artifact"];
            if artifact.is_null() { continue }
            if artifact["repository_binding"] != repository { bail!("writable task requires explicit multi-repository mapping") }
            choices.push(json!({"basis":"frozen_artifact","source_sequence":output["sequence"],"snapshot_hash":artifact["snapshot_hash"]}));
        }
    }
    if choices.is_empty() && sources.is_empty() {
        let resume = &run["intervention"]["resume"];
        // A pause before first provision has no owner-edited checkout. The later
        // Home preparation may pin one, but cannot change this frozen base into
        // an owner-resume input. Only the exact intent recorded at resume can.
        let attempt = &resume["task_workspace_attempts"][assignment["stage_id"].as_str().unwrap()];
        if !attempt.is_null() {
            if run["intervention"]["stop_confirmed"] != true || run["intervention"]["accounting"] != "finalized"
                || resume["actor"]["kind"] != "human" || resume["actor"]["id"] != "local_owner"
                || resume["execution_authorized"] != false || attempt["stage_attempt"] != assignment["stage_attempt"]
                || attempt["context_hash"] != assignment["context_hash"]
                || attempt["task_workspace_key"] != run["task_workspaces"][repository]["key"] {
                bail!("task owner resume intent does not authorize this stage attempt")
            }
            return Ok(json!({"basis":"owner_resumed_task","resume_request_id":resume["request_id"],
                "stage_attempt":assignment["stage_attempt"],"context_hash":assignment["context_hash"],"task_workspace_key":attempt["task_workspace_key"]}))
        }
        return Ok(json!({"basis":"git_base"}))
    }
    single(choices)
}

#[cfg(test)]
mod task_resume_tests {
    use super::*;
    #[test]
    fn task_worktree_resume_basis_is_stable_across_first_provision_and_exactly_one_existing_attempt() {
        let db = Connection::open_in_memory().unwrap();
        let mut run = json!({"context_hash":"context","context":{"binding":{"workflow":{"pack":{"stages":[
            {"id":"implement","execution":{"repository_binding":"source"}}]}}}},
            "task_workspaces":null,"intervention":{"stop_confirmed":true,"accounting":"finalized",
                "resume":{"request_id":"resume","actor":{"kind":"human","id":"local_owner"},"execution_authorized":false}}});
        let mut assignment = json!({"stage_id":"implement","stage_attempt":1,"context_hash":"context","inputs":{"binding":{"sources":{}}}});
        assert_eq!(freeze(&db, &run, &assignment).unwrap(), json!({"basis":"git_base"}));
        // Trusted Home preparation happens after the initial freeze.
        run["task_workspaces"] = json!({"source":{"key":"task-key"}});
        assert_eq!(freeze(&db, &run, &assignment).unwrap(), json!({"basis":"git_base"}));
        assignment["stage_attempt"] = json!(2);
        run["intervention"]["resume"]["task_workspace_attempts"] = json!({"implement":{
            "stage_attempt":2,"task_workspace_key":"task-key","context_hash":"context"}});
        let expected = freeze(&db, &run, &assignment).unwrap();
        assert_eq!(expected["basis"], "owner_resumed_task");
        assert_eq!(expected["resume_request_id"], "resume");
        let mut proof = expected.clone(); proof["snapshot_hash"] = json!("a".repeat(64));
        validate(&expected, &proof).unwrap();
        proof["stage_attempt"] = json!(3); assert!(validate(&expected, &proof).is_err());
        assignment["stage_attempt"] = json!(3); assert!(freeze(&db, &run, &assignment).is_err());
        assignment["stage_attempt"] = json!(2); assignment["context_hash"] = json!("other");
        assert!(freeze(&db, &run, &assignment).is_err());
        assignment["context_hash"] = json!("context"); run["task_workspaces"]["source"]["key"] = json!("other-task");
        assert!(freeze(&db, &run, &assignment).is_err());
        run["task_workspaces"]["source"]["key"] = json!("task-key"); run["intervention"]["stop_confirmed"] = json!(false);
        assert!(freeze(&db, &run, &assignment).is_err());
    }
}
fn single(choices: Vec<Value>) -> Result<Value> {
    let first = choices.first().ok_or_else(|| anyhow::anyhow!("writable task requires a frozen artifact content basis"))?;
    if choices.iter().any(|choice| choice["snapshot_hash"] != first["snapshot_hash"])
        || !first["source_sequence"].as_u64().is_some_and(|s| s > 0)
        || !first["snapshot_hash"].as_str().is_some_and(super::artifact_archive_format::valid_hash) {
        bail!("writable task requires explicit multi-source content mapping")
    }
    Ok(first.clone())
}
pub(super) fn validate(expected: &Value, proof: &Value) -> Result<()> {
    let mut expected = expected.clone();
    if expected["basis"] == "git_base" || expected["basis"] == "owner_resumed_task" {
        if !proof["snapshot_hash"].as_str().is_some_and(super::artifact_archive_format::valid_hash) { bail!("task Git base content proof unavailable") }
        expected["snapshot_hash"] = proof["snapshot_hash"].clone();
    }
    if *proof != expected { bail!("task starting snapshot does not match frozen input") }
    Ok(())
}

#[cfg(test)]
mod explicit_input_tests {
    use super::*;
    #[test]
    fn mapped_task_input_uses_exact_artifact_but_rework_keeps_last_attempt_priority() {
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE work_assignments(id TEXT,body TEXT); CREATE TABLE operation_events(seq INTEGER,body TEXT); CREATE TABLE artifact_archives(sequence INTEGER,complete BOOLEAN);").unwrap();
        let stage=json!({"id":"implement","role":"author","requires":["baseline"],"produces":["fixed"],"independent_from":[],"execution":{
            "repository_binding":"code","capabilities":["read","workspace_write"],"tools":[],"network":false,"input_artifact":{"stage":"baseline","output":"base"}}});
        let run=json!({"context":{"binding":{"workflow":{"pack":{"stages":[stage],"evidence_rules":{"fixed":{"kind":"artifact","repository_binding":"code"}}}}}}});
        let mut assignment=json!({"id":"next","run_id":"run","stage_id":"implement","inputs":{"binding":{"sources":{
            "baseline":{"outputs":{"base":{"sequence":1,"artifact":{"repository_binding":"code","snapshot_hash":"a".repeat(64),"archive_hash":"b".repeat(64),"bytes":1}}}},
            "other":{"outputs":{"other":{"sequence":2,"artifact":{"repository_binding":"code","snapshot_hash":"c".repeat(64),"archive_hash":"d".repeat(64),"bytes":1}}}}}}}});
        assert_eq!(freeze(&db,&run,&assignment).unwrap(),json!({"basis":"frozen_artifact","source_sequence":1,"snapshot_hash":"a".repeat(64)}));
        let previous=json!({"run_id":"run","stage_id":"implement","stage_attempt":1,"state":"completed","execution_workspace":{"receipt":{"kind":"derived_task_worktree"}}});
        db.execute("INSERT INTO work_assignments VALUES ('previous',?1)",[previous.to_string()]).unwrap();
        db.execute("INSERT INTO operation_events VALUES (3,?1)",[json!({"snapshot_hash":"e".repeat(64),"evidence":{"payload":{"kind":"artifact"}}}).to_string()]).unwrap();
        db.execute("INSERT INTO artifact_archives VALUES (3,1)",[]).unwrap();
        assignment["inputs"]["binding"]["rework"]=json!({"superseded":[{"stage_id":"implement","assignment_id":"previous","attempt":1,"evidence":{"outputs":{"fixed":3}}}]});
        assert_eq!(freeze(&db,&run,&assignment).unwrap(),json!({"basis":"rework_artifact","source_sequence":3,"snapshot_hash":"e".repeat(64)}));
    }
}
