//! Owner close intent fences new input while previously accepted messages drain.
use super::{
    builder_authority, coordinator_control,
    model::{now, valid_id},
    operations::State,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Close {
    pub request_id: String,
    pub attempt: u64,
    pub epoch: u64,
    pub price_id: String,
    pub settlement: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub idle_only: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}
fn key(id: &str, attempt: u64) -> String {
    format!("coordinator-close:{}", json!([id, attempt]))
}
fn read(db: &Connection, id: &str, attempt: u64) -> Result<Option<Value>> {
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(id, attempt)],
            |r| r.get(0),
        )
        .optional()?;
    value.map(|v| Ok(serde_json::from_str(&v)?)).transpose()
}
pub(super) fn ensure_open(db: &Connection, id: &str, attempt: u64) -> Result<()> {
    if read(db, id, attempt)?.is_some() {
        bail!("Coordinator is closing; new input is not accepted")
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingQuery {
    pub after: Option<String>,
}
impl Store {
    pub fn pending_coordinator_closes(&self, input: PendingQuery) -> Result<Value> {
        let after = input.after.unwrap_or_default();
        if after.len() > 512 || (!after.is_empty() && !after.starts_with("coordinator-close:")) {
            bail!("invalid close cursor")
        }
        let db = self.db.lock();
        let mut query = db.prepare("SELECT w.key,w.value FROM workbench_documents w WHERE w.key LIKE 'coordinator-close:%' AND w.key>?1 AND NOT EXISTS(SELECT 1 FROM workbench_documents a WHERE a.key='coordinator-accounting:'||json_array(json_extract(w.value,'$.operation_id'),json_extract(w.value,'$.request.attempt'))) ORDER BY w.key LIMIT 32")?;
        let rows = query
            .query_map([after], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let next = if rows.len() == 32 {
            rows.last().map(|r| r.0.clone())
        } else {
            None
        };
        let mut items = Vec::new();
        for (_, body) in rows {
            let intent: Value = serde_json::from_str(&body)?;
            items.push(json!({"operation_id":intent["operation_id"],"command":intent["request"]}));
        }
        Ok(json!({"home_hub":self.node_id,"items":items,"next_cursor":next}))
    }

    pub fn coordinator_close_state(&self, id: &str) -> Result<Value> {
        if !valid_id(id) {
            bail!("invalid Coordinator close identity")
        }
        let db = self.db.lock();
        let op = builder_authority::operation(&db, id)?;
        let intent = read(&db, id, op.attempt)?;
        let (pending, runs) = pending_in(&db, id, op.attempt)?;
        Ok(
            json!({"intent":intent,"operation":op,"pending_inputs":pending,"pending_runs":runs,"idle_close_ready":idle_ready(&db,id,op.attempt)?}),
        )
    }
    pub fn begin_coordinator_close(&self, id: &str, input: Close) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.price_id)
            || input.attempt == 0
            || input.epoch == 0
            || input.settlement != "internal_price"
        {
            bail!("invalid Coordinator close confirmation")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(prior) = read(&tx, id, input.attempt)? {
            if prior["request"] != request {
                bail!("Coordinator close identity conflict")
            }
            return Ok(prior);
        }
        let op = builder_authority::operation(&tx, id)?;
        let scope = coordinator_control::operation_binding(&tx, id)?
            .ok_or_else(|| anyhow::anyhow!("Coordinator scope missing"))?;
        if op.worker.node_id != self.node_id
            || op.attempt != input.attempt
            || op.epoch != input.epoch
            || scope["request"]["epoch"] != input.epoch
            || scope["request"]["attempt"] != input.attempt
            || scope["request"]["operation_id"] != id
            || !matches!(op.state, State::Active | State::Reported)
        {
            bail!("Coordinator close requires current local execution")
        }
        let price:String=tx.query_row("SELECT p.price_id FROM operation_budget_bindings b JOIN reservation_prices p ON p.reservation_id=b.reservation_id WHERE b.operation_id=?1 AND b.attempt=?2",params![id,input.attempt],|r|r.get(0))?;
        if price != input.price_id {
            bail!("Coordinator close price mismatch")
        }
        if input.idle_only && !idle_ready(&tx, id, input.attempt)? {
            bail!("Coordinator is not ready for idle close")
        }
        let intent = json!({"request":request,"operation_id":id,"team_id":scope["team_id"],"state":"closing","at":now()});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(id, input.attempt), serde_json::to_string(&intent)?],
        )?;
        tx.execute(
            "INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",
            params![
                id,
                serde_json::to_string(
                    &json!({"kind":"coordinator_close_requested","actor":"owner","intent":intent})
                )?
            ],
        )?;
        tx.commit()?;
        Ok(intent)
    }
}

pub(super) fn pending_in(db: &Connection, id: &str, attempt: u64) -> Result<(u64, u64)> {
    let inputs: u64 = db.query_row("SELECT COUNT(*) FROM workbench_documents w LEFT JOIN runtime_deliveries d ON d.message_id=json_extract(w.value,'$.receipt.message_id') WHERE (w.key LIKE 'coordinator-input:%' OR w.key LIKE 'coordinator-update:%') AND json_extract(w.value,'$.receipt.operation_id')=?1 AND COALESCE(json_extract(w.value,'$.receipt.attempt'),json_extract(w.value,'$.request.attempt'))=?2 AND COALESCE(d.phase,-1)!=2", params![id,attempt], |r| r.get(0))?;
    let runs: u64 = db.query_row("SELECT COUNT(*) FROM work_runs r WHERE json_extract(r.body,'$.coordinator.operation_id')=?1 AND json_extract(r.body,'$.coordinator.attempt')=?2 AND (r.state NOT IN ('completed','failed','cancelled') OR NOT EXISTS(SELECT 1 FROM workbench_documents w JOIN runtime_deliveries d ON d.message_id=json_extract(w.value,'$.receipt.message_id') WHERE w.key='coordinator-update:'||json_array(r.id,r.revision) AND d.phase=2))", params![id,attempt], |r| r.get(0))?;
    Ok((inputs, runs))
}

/// Readiness is only a hint on GET; idle close checks it again while inserting its fence.
fn idle_ready(db: &Connection, id: &str, attempt: u64) -> Result<bool> {
    let Some(scope) = coordinator_control::operation_binding(db, id)? else {
        return Ok(false);
    };
    let team = scope["team_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid Coordinator team"))?;
    if coordinator_control::current_in(db, team)?
        .as_ref()
        .is_none_or(|current| current["revision"] != scope["revision"])
        || pending_in(db, id, attempt)? != (0, 0)
    {
        return Ok(false);
    }
    let conversation = scope["conversation_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid Coordinator conversation"))?;
    let unbound: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM conversation_messages m WHERE m.conversation_id=?1 AND m.actor='human:local_owner' AND NOT EXISTS(SELECT 1 FROM workbench_documents w WHERE w.key='coordinator-input:'||json_quote(m.id)))",[conversation],|r|r.get(0))?;
    if unbound {
        return Ok(false);
    }
    let (inputs, unanswered): (u64,u64) = db.query_row("SELECT COUNT(*),COALESCE(SUM(NOT EXISTS(SELECT 1 FROM conversation_messages m WHERE m.actor='superagent' AND json_extract(m.body,'$.operation_id')=?1 AND json_extract(m.body,'$.in_reply_to')=json_extract(w.value,'$.receipt.source_message_id'))),0) FROM workbench_documents w WHERE w.key LIKE 'coordinator-input:%' AND json_extract(w.value,'$.request.operation_id')=?1 AND json_extract(w.value,'$.request.attempt')=?2",params![id,attempt],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if inputs == 0 || unanswered > 0 {
        return Ok(false);
    }
    let unfinished_reply: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM work_runs r JOIN workbench_documents w ON w.key='coordinator-update:'||json_array(r.id,r.revision) WHERE json_extract(r.body,'$.coordinator.operation_id')=?1 AND json_extract(r.body,'$.coordinator.attempt')=?2 AND NOT EXISTS(SELECT 1 FROM conversation_messages m WHERE m.actor='superagent' AND json_extract(m.body,'$.operation_id')=?1 AND json_extract(m.body,'$.source_delivery_id')=json_extract(w.value,'$.receipt.message_id')))",params![id,attempt],|r|r.get(0))?;
    let unresolved_calls: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM official_calls WHERE operation_id=?1 AND attempt=?2 AND (state!='finished' OR COALESCE(json_extract(body,'$.accounting_status'),'')!='estimated_pending_reconciliation'))",params![id,attempt],|r|r.get(0))?;
    Ok(!unfinished_reply && !unresolved_calls)
}
