//! Home administrator adjudication retains original uncertain evidence and never grants replay.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    VerifiedApplied,
    VerifiedNotApplied,
    Abandoned,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resolution {
    pub operation_id: String,
    pub evidence_sequence: u64,
    pub request_id: String,
    pub decision: Decision,
    pub evidence_ref: String,
}
pub(super) fn read(db: &Connection, operation: &str, sequence: u64) -> Result<Option<Value>> {
    let body:Option<String>=db.query_row("SELECT body FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='tool_resolution' AND json_extract(body,'$.resolution.evidence_sequence')=?2 LIMIT 1",params![operation,sequence],|r|r.get(0)).optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
impl Store {
    pub fn resolve_tool_evidence(&self, input: Resolution) -> Result<Value> {
        if !valid_id(&input.operation_id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.evidence_ref)
            || input.evidence_sequence == 0
        {
            bail!("invalid tool resolution")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(old) = read(&tx, &input.operation_id, input.evidence_sequence)? {
            let resolution: Resolution = serde_json::from_value(old["resolution"].clone())?;
            if resolution != input {
                bail!("tool resolution already recorded")
            }
            return Ok(json!({"resolution":old,"duplicate":true}));
        }
        let body: Option<String> = tx
            .query_row(
                "SELECT body FROM operation_events WHERE operation_id=?1 AND seq=?2",
                params![input.operation_id, input.evidence_sequence],
                |r| r.get(0),
            )
            .optional()?;
        let event: Value =
            serde_json::from_str(&body.ok_or_else(|| anyhow::anyhow!("tool evidence missing"))?)?;
        if event["kind"] != "tool_evidence" || event["evidence"]["status"] != "uncertain" {
            bail!("resolution requires uncertain tool evidence")
        }
        let result = json!({"kind":"tool_resolution","resolution":input,"actor":"home_administrator","recorded_at":now(),"replay_authorized":false});
        tx.execute(
            "INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",
            params![input.operation_id, serde_json::to_string(&result)?],
        )?;
        tx.commit()?;
        Ok(json!({"resolution":result,"duplicate":false}))
    }
}
