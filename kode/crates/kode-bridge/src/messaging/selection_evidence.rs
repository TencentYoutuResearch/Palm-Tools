//! Immutable Host observations. Configuration acknowledgement is not inference attestation.
use super::{model::valid_id, operations::Operation, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Reported,
    Mismatch,
    Unverifiable,
    Pending,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub requested: Option<String>,
    pub observed: Option<String>,
    pub status: Status,
    pub source: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    ExecutorConfiguration,
    Inference,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub record_id: String,
    pub operation_id: String,
    pub worker_session: String,
    pub attempt: u64,
    pub epoch: u64,
    pub profile_revision: String,
    pub thread_id: String,
    pub turn_id: String,
    pub input_ids: Vec<String>,
    pub scope: Scope,
    pub observed_at: u64,
    pub model: Observation,
    pub effort: Observation,
    pub rejected: bool,
}
fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
impl Evidence {
    fn validate(&self) -> Result<()> {
        for id in [&self.record_id, &self.operation_id, &self.worker_session] {
            if !valid_id(id) {
                bail!("invalid selection evidence identity")
            }
        }
        if self.attempt == 0
            || self.epoch == 0
            || self.attempt > i64::MAX as u64
            || self.epoch > i64::MAX as u64
            || self.observed_at > i64::MAX as u64
            || !bounded(&self.profile_revision, 256)
            || !bounded(&self.thread_id, 256)
            || !bounded(&self.turn_id, 256)
            || self.input_ids.is_empty()
            || self.input_ids.len() > 64
            || self.input_ids.iter().any(|id| !valid_id(id))
        {
            bail!("invalid selection evidence bounds")
        }
        for (field, max) in [(&self.model, 256), (&self.effort, 64)] {
            if field.requested.as_ref().is_some_and(|s| !bounded(s, max))
                || field.observed.as_ref().is_some_and(|s| !bounded(s, max))
                || field.source.as_ref().is_some_and(|s| !bounded(s, 128))
            {
                bail!("invalid selection observation bounds")
            }
            if field.status == Status::Reported
                && (field.observed.is_none() || field.source.is_none())
            {
                bail!("reported selection requires observation and source")
            }
            if field.status == Status::Mismatch
                && (field.requested.is_none()
                    || field.observed.is_none()
                    || field.requested == field.observed)
            {
                bail!("selection mismatch requires different known values")
            }
        }
        Ok(())
    }
    fn rejected(&self) -> bool {
        self.rejected
            || [&self.model, &self.effort].iter().any(|field| {
                field.status == Status::Mismatch
                    || matches!((&field.requested, &field.observed), (Some(a), Some(b)) if a != b)
            })
    }
}
/// A later positive observation cannot erase a rejection for the same attempt/epoch.
pub(super) fn admit(db: &Connection, op: &Operation) -> Result<()> {
    let rejected: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='selection_evidence' AND json_extract(body,'$.evidence.attempt')=?2 AND json_extract(body,'$.evidence.epoch')=?3 AND json_extract(body,'$.rejected')=1)", params![op.id, op.attempt, op.epoch], |r| r.get(0))?;
    if rejected {
        bail!("selection evidence rejected this attempt")
    }
    Ok(())
}
/// Immutable per-operation requirements; no policy preserves legacy reporting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub profile_revision: String,
    pub model: String,
    pub effort: Option<String>,
    pub scope: Scope,
}
impl Policy {
    pub(super) fn validate(&self) -> Result<()> {
        if !bounded(&self.profile_revision, 256)
            || !bounded(&self.model, 256)
            || self.effort.as_ref().is_some_and(|v| !bounded(v, 64))
        {
            bail!("invalid selection policy")
        }
        Ok(())
    }
}
pub(super) fn complete(db: &Connection, op: &Operation) -> Result<()> {
    admit(db, op)?;
    let Some(policy) = &op.selection_policy else {
        return Ok(());
    };
    let scope = serde_json::to_value(&policy.scope)?;
    let matched: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='selection_evidence' AND json_extract(body,'$.evidence.attempt')=?2 AND json_extract(body,'$.evidence.epoch')=?3 AND json_extract(body,'$.rejected')=0 AND json_extract(body,'$.evidence.profile_revision')=?4 AND json_extract(body,'$.evidence.scope')=?5 AND json_extract(body,'$.evidence.model.status')='reported' AND json_extract(body,'$.evidence.model.requested')=?6 AND json_extract(body,'$.evidence.model.observed')=?6 AND (?7 IS NULL OR (json_extract(body,'$.evidence.effort.status')='reported' AND json_extract(body,'$.evidence.effort.requested')=?7 AND json_extract(body,'$.evidence.effort.observed')=?7)))", params![op.id,op.attempt,op.epoch,policy.profile_revision,scope.as_str(),policy.model,policy.effort], |r| r.get(0))?;
    if !matched {
        bail!("selection policy requires matching reported evidence")
    }
    Ok(())
}
impl Store {
    pub fn record_selection_evidence(&self, input: Evidence) -> Result<Value> {
        input.validate()?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let old: Option<(u64, String)> = tx.query_row("SELECT seq,body FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='selection_evidence' AND json_extract(body,'$.evidence.record_id')=?2 LIMIT 1", params![input.operation_id,input.record_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((seq, body)) = old {
            let event: Value = serde_json::from_str(&body)?;
            let prior: Evidence = serde_json::from_value(event["evidence"].clone())?;
            if prior != input {
                bail!("selection evidence identity conflict")
            }
            return Ok(
                json!({"sequence":seq,"evidence":prior,"rejected":event["rejected"],"duplicate":true}),
            );
        }
        let body: String = tx.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [&input.operation_id],
            |r| r.get(0),
        )?;
        let op: Operation = serde_json::from_str(&body)?;
        if input.worker_session != op.worker.session_id
            || input.attempt > op.attempt
            || input.epoch > op.epoch
        {
            bail!("foreign selection evidence")
        }
        let admitted: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.operation.attempt')=?2 AND json_extract(body,'$.operation.epoch')=?3 AND json_extract(body,'$.operation.state')='active')", params![input.operation_id,input.attempt,input.epoch], |r| r.get(0))?;
        if !admitted {
            bail!("selection evidence lacks an admitted attempt")
        }
        let rejected = input.rejected();
        tx.execute(
            "INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",
            params![
                input.operation_id,
                serde_json::to_string(
                    &json!({"kind":"selection_evidence","evidence":input,"rejected":rejected})
                )?
            ],
        )?;
        let seq = tx.last_insert_rowid();
        tx.commit()?;
        Ok(json!({"sequence":seq,"evidence":input,"rejected":rejected,"duplicate":false}))
    }
}
