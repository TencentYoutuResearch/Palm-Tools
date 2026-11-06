//! Derived read-only scope preserves its original project grant as the authority source.
use super::{
    assignment_resources,
    model::{now, valid_id},
    operations::State,
    store::Store,
    team_grants::Capability,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authorize {
    pub request_id: String,
    pub expected_revision: u64,
}
pub(super) fn for_operation(db: &Connection, operation: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT body FROM work_assignments WHERE operation_id=?1",
            [operation],
            |r| r.get(0),
        )
        .optional()?;
    Ok(body
        .map(|b| serde_json::from_str::<Value>(&b))
        .transpose()?
        .and_then(|a| {
            if a["execution_workspace"].is_null() {
                None
            } else {
                Some(a["execution_workspace"]["receipt"].clone())
            }
        }))
}
impl Store {
    pub fn authorize_assignment_workspace(&self, id: &str, input: Authorize) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
        {
            bail!("invalid derived workspace authorization")
        }
        let request = serde_json::to_value(&input)?;
        let at = now();
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if !assignment["execution_workspace"].is_null() {
            if assignment["execution_workspace"]["request"] != request {
                bail!("derived workspace authorization identity conflict")
            }
            return Ok(assignment["execution_workspace"]["receipt"].clone());
        }
        if assignment["revision"] != input.expected_revision
            || assignment["state"] != "prepared"
            || assignment["dispatch"]["state"] != "blocked"
            || !assignment["resources"].is_null()
            || !assignment["creation"].is_null()
            || !assignment["admission"].is_null()
        {
            bail!("derived workspace authorization state conflict")
        }
        let (run, operation) = assignment_resources::authorized_context(&tx, id, &assignment, at)?;
        if operation.state != State::Prepared {
            bail!("derived workspace operation started")
        }
        let receipt = &assignment["input_workspace"]["receipt"];
        if receipt.is_null()
            || receipt["assignment_id"] != id
            || receipt["host"] != assignment["worker"]["node_id"]
            || receipt["input_hash"] != assignment["inputs"]["hash"]
            || receipt["execution_authorized"] != false
        {
            bail!("derived workspace materialization receipt required")
        }
        let pack: super::workflows::Pack =
            serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
        let stage = pack
            .stages
            .iter()
            .find(|s| s.id == assignment["stage_id"])
            .unwrap();
        let execution = stage.execution.as_ref().unwrap();
        if execution.network
            || execution
                .capabilities
                .iter()
                .any(|c| *c != Capability::Read)
        {
            bail!("derived snapshot currently requires read-only offline scope")
        }
        let sources = &assignment["inputs"]["binding"]["sources"];
        let source = &sources[receipt["source_stage"].as_str().unwrap()]["outputs"]
            [receipt["output"].as_str().unwrap()];
        if source["artifact"]["repository_binding"] != execution.repository_binding
            || source["sequence"] != receipt["sequence"]
            || source["artifact"]["snapshot_hash"] != receipt["snapshot_hash"]
            || source["artifact"]["archive_hash"] != receipt["archive_hash"]
        {
            bail!("derived workspace repository binding mismatch")
        }
        // Explicit mapping selects cwd only; all ancestors remain in frozen inputs.
        let mapped = super::workflow_input_artifact::selected(stage, sources)?;
        if mapped.is_some() {
            let input = stage.execution.as_ref().unwrap().input_artifact.as_ref().unwrap();
            if receipt["source_stage"] != input.stage || receipt["output"] != input.output {
                bail!("derived workspace differs from explicit input artifact")
            }
        }
        // Legacy packages cannot silently choose one of several distinct snapshots.
        for producer in sources.as_object().unwrap().values().filter(|_| mapped.is_none()) {
            for output in producer["outputs"].as_object().unwrap().values() {
                if !output["artifact"].is_null()
                    && (output["artifact"]["repository_binding"] != execution.repository_binding
                        || output["artifact"]["snapshot_hash"] != receipt["snapshot_hash"])
                {
                    bail!("derived workspace requires explicit multi-source mapping")
                }
            }
        }
        let mut scope = assignment["candidate"]["grant_scope"].clone();
        scope["target"]["root"] = receipt["root"].clone();
        scope["target"]["workspace"] = json!(format!("snapshot-{}", id));
        let result = json!({"assignment_id":id,"assignment_revision":input.expected_revision+1,
            "operation_id":operation.id,"attempt":operation.attempt,"epoch":operation.epoch,"input_hash":receipt["input_hash"],
            "source_stage":receipt["source_stage"],"output":receipt["output"],"snapshot_hash":receipt["snapshot_hash"],
            "scope":scope,"authority_scope":assignment["candidate"]["grant_scope"],"kind":"derived_readonly_snapshot",
            "scope_authorized":true,"execution_authorized":false,"at":at});
        assignment["revision"] = json!(input.expected_revision + 1);
        assignment["execution_workspace"] = json!({"request":request,"receipt":result});
        assignment["dispatch"]["command"]["cwd"] = scope["target"]["root"].clone();
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute(
            "UPDATE work_dispatch_outbox SET body=?2 WHERE assignment_id=?1",
            params![
                id,
                serde_json::to_string(&assignment["dispatch"]["command"])?
            ],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![assignment["run_id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_workspace_scope_authorized","at":at,"receipt":result}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
