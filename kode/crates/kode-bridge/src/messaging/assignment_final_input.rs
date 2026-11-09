//! Validate final derived-input observation against frozen admission and selection.
use super::operations::{Operation, State};
use anyhow::{bail, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proof {
    pub assignment_id: String,
    pub input_hash: String,
    pub snapshot_hash: String,
    pub source_sequence: u64,
    pub selection: Value,
}
pub(super) fn validate(
    db: &Connection,
    assignment: &Value,
    operation: &Operation,
    proof: &Proof,
) -> Result<()> {
    let scope = &assignment["execution_workspace"]["receipt"];
    let context = &assignment["admission"]["request"]["context"];
    let fresh_context =
        serde_json::from_value::<super::assignment_admission::FreshContext>(context.clone()).ok();
    let source = &assignment["input_workspace"]["receipt"];
    if operation.state != State::Reported
        || operation.epoch != assignment["bundle"]["operation"]["epoch"]
        || assignment["id"] != proof.assignment_id
        || scope["input_hash"] != proof.input_hash
        || scope["snapshot_hash"] != proof.snapshot_hash
        || context["input_hash"] != proof.input_hash
        || context["snapshot_hash"] != proof.snapshot_hash
        || !fresh_context.is_some_and(|context| {
            context.empty_transcript() && context.session_id == assignment["worker"]["session_id"]
        })
        || source["sequence"] != proof.source_sequence
        || source["snapshot_hash"] != proof.snapshot_hash
    {
        bail!("final input identity or context mismatch")
    }
    let (hash, complete): (String, bool) = db.query_row(
        "SELECT hash,complete FROM artifact_archives WHERE sequence=?1",
        [proof.source_sequence],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if !complete || source["archive_hash"] != hash {
        bail!("final input archive unavailable")
    }
    let body: String = db.query_row(
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
        .ok_or_else(|| anyhow::anyhow!("final input stage missing"))?;
    if stage["assignment_id"] != assignment["id"]
        || stage["attempt"] != assignment["stage_attempt"]
        || stage["evidence"] != proof.selection
        || run["context_hash"] != assignment["context_hash"]
        || run["authorization"]["snapshot_hash"] != assignment["authorization_hash"]
    {
        bail!("final input selection mismatch")
    }
    Ok(())
}
