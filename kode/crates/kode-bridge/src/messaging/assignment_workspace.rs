//! Home receipt of trusted Host materialization. Receipt alone never grants a derived execution scope.
use super::{
    assignment_resources,
    model::{now, valid_id},
    operations::State,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: String,
    pub expected_revision: u64,
    pub input_hash: String,
    pub source_stage: String,
    pub output: String,
    pub sequence: u64,
    pub snapshot_hash: String,
    pub archive_hash: String,
    pub root: String,
}
impl Store {
    pub fn assignment_workspace_receipt(&self, id: &str, input: Receipt) -> Result<Value> {
        self.assignment_workspace_receipt_from(&self.node_id, id, input)
    }
    pub(super) fn assignment_workspace_receipt_from(
        &self,
        executor: &str,
        id: &str,
        input: Receipt,
    ) -> Result<Value> {
        if !valid_id(executor) {
            bail!("invalid materialization executor")
        }
        let root = std::path::Path::new(&input.root);
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.source_stage)
            || !valid_id(&input.output)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
            || input.sequence == 0
            || input.sequence > i64::MAX as u64
            || [&input.input_hash, &input.snapshot_hash, &input.archive_hash]
                .iter()
                .any(|h| !super::artifact_archive_format::valid_hash(h))
            || !root.is_absolute()
            || input.root.len() > 4096
            || input.root.contains('\0')
            || input
                .root
                .split('/')
                .skip(1)
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            bail!("invalid Assignment workspace receipt")
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
        if assignment["worker"]["node_id"] != executor {
            bail!("foreign materialization executor")
        }
        if !assignment["input_workspace"].is_null() {
            if assignment["input_workspace"]["request"] != request {
                bail!("Assignment workspace receipt identity conflict")
            }
            return Ok(assignment["input_workspace"]["receipt"].clone());
        }
        if assignment["revision"] != input.expected_revision
            || assignment["state"] != "prepared"
            || assignment["dispatch"]["state"] != "blocked"
            || !assignment["creation"].is_null()
            || !assignment["admission"].is_null()
        {
            bail!("Assignment workspace receipt state conflict")
        }
        let (_, operation) = assignment_resources::authorized_context(&tx, id, &assignment, at)?;
        if operation.state != State::Prepared {
            bail!("Assignment workspace operation already started")
        }
        let inputs = &assignment["inputs"];
        let binding = &inputs["binding"];
        if inputs["hash"] != input.input_hash
            || inputs["execution_authorized"] != false
            || binding["run_id"] != assignment["run_id"]
            || binding["stage_id"] != assignment["stage_id"]
            || binding["context_hash"] != assignment["context_hash"]
            || binding["authorization_hash"] != assignment["authorization_hash"]
        {
            bail!("Assignment workspace input binding mismatch")
        }
        let source = &binding["sources"][&input.source_stage];
        let output = &source["outputs"][&input.output];
        let artifact = &output["artifact"];
        if output["sequence"] != input.sequence
            || artifact["snapshot_hash"] != input.snapshot_hash
            || artifact["archive_hash"] != input.archive_hash
        {
            bail!("Assignment workspace source mismatch")
        }
        let (hash, bytes, complete): (String, u64, bool) = tx.query_row(
            "SELECT hash,bytes,complete FROM artifact_archives WHERE sequence=?1",
            [input.sequence],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if !complete || hash != input.archive_hash || artifact["bytes"] != bytes {
            bail!("Assignment workspace archive unavailable")
        }
        let original = std::path::Path::new(
            assignment["candidate"]["grant_scope"]["target"]["root"]
                .as_str()
                .unwrap(),
        );
        if root.starts_with(original) || original.starts_with(root) {
            bail!("Assignment snapshot must be separate from original workspace")
        }
        let result = json!({"assignment_id":id,"assignment_revision":input.expected_revision+1,"input_hash":input.input_hash,
            "source_stage":input.source_stage,"output":input.output,"source_assignment_id":source["assignment_id"],
            "sequence":input.sequence,"snapshot_hash":input.snapshot_hash,"archive_hash":input.archive_hash,
            "host":executor,"root":input.root,"kind":if executor == self.node_id { "official_local_materialized" } else { "official_remote_materialized" },"execution_authorized":false,"at":at});
        assignment["revision"] = json!(input.expected_revision + 1);
        assignment["input_workspace"] = json!({"request":request,"receipt":result});
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute(
            "INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",
            params![
                assignment["run_id"].as_str(),
                serde_json::to_string(
                    &json!({"kind":"assignment_input_materialized","at":at,"actor":{"kind":"host","id":executor},"receipt":result})
                )?
            ],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
