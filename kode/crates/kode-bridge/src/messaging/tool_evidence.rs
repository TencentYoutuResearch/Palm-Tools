//! Immutable terminal Host evidence; receipt replay never authorizes tool replay.
use super::{model::valid_id, operations::Operation, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Returned,
    Uncertain,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub call_id: String,
    pub tool: String,
    pub operation_id: String,
    pub worker_session: String,
    pub attempt: u64,
    pub epoch: u64,
    pub status: Outcome,
    pub started_at: u64,
    pub ended_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub io: Option<Observation>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub schema_version: u64,
    pub input: ContentHash,
    pub output: Option<ContentHash>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentHash {
    pub encoding: String,
    pub sha256: String,
    pub bytes: u64,
}
impl ContentHash {
    fn valid(&self) -> bool {
        matches!(self.encoding.as_str(), "json_utf8" | "js_undefined")
            && self.bytes <= i64::MAX as u64
            && self.sha256.len() == 64
            && self
                .sha256
                .bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
    }
}
impl Store {
    pub fn record_tool_evidence(&self, input: Evidence) -> Result<Value> {
        if input.io.as_ref().is_some_and(|io| {
            io.schema_version != 1
                || !io.input.valid()
                || io.output.as_ref().is_some_and(|v| !v.valid())
        }) {
            bail!("invalid tool content observation")
        }
        for value in [
            &input.call_id,
            &input.tool,
            &input.operation_id,
            &input.worker_session,
        ] {
            if !valid_id(value) {
                bail!("invalid tool evidence identity")
            }
        }
        if input.attempt == 0
            || input.epoch == 0
            || input.started_at > input.ended_at
            || input.ended_at > i64::MAX as u64
        {
            bail!("invalid tool evidence bounds")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let old:Option<(u64,String)>=tx.query_row("SELECT seq,body FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='tool_evidence' AND json_extract(body,'$.evidence.call_id')=?2 AND json_extract(body,'$.evidence.attempt')=?3 LIMIT 1",params![input.operation_id,input.call_id,input.attempt],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((seq, body)) = old {
            let value: Value = serde_json::from_str(&body)?;
            let prior: Evidence = serde_json::from_value(value["evidence"].clone())?;
            if prior != input {
                bail!("tool evidence identity conflict")
            }
            let resolution = super::tool_resolution::read(&tx, &input.operation_id, seq)?;
            return Ok(
                json!({"sequence":seq,"evidence":prior,"duplicate":true,"resolution":resolution}),
            );
        }
        let body: String = tx.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [&input.operation_id],
            |r| r.get(0),
        )?;
        let operation: Operation = serde_json::from_str(&body)?;
        // Late evidence remains admissible, but may never describe a future attempt.
        if input.worker_session != operation.worker.session_id
            || input.attempt > operation.attempt
            || input.epoch > operation.epoch
        {
            bail!("foreign tool evidence")
        }
        let admitted: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.operation.attempt')=?2 AND json_extract(body,'$.operation.epoch')=?3 AND json_extract(body,'$.operation.state')='active')",params![input.operation_id,input.attempt,input.epoch],|r|r.get(0))?;
        if !admitted {
            bail!("tool evidence lacks an admitted attempt")
        }
        let event = json!({"kind":"tool_evidence","evidence":input});
        tx.execute(
            "INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",
            params![input.operation_id, serde_json::to_string(&event)?],
        )?;
        let seq = tx.last_insert_rowid();
        tx.commit()?;
        Ok(json!({"sequence":seq,"evidence":input,"duplicate":false}))
    }
}
