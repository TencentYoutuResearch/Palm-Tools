//! Owner close intent fences new input while previously accepted messages drain.
use super::{
    builder_authority,
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
}
fn key(id: &str, attempt: u64) -> String {
    format!("builder-close:{}", json!([id, attempt]))
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
        bail!("Builder is closing; new input is not accepted")
    }
    Ok(())
}
impl Store {
    pub fn builder_close_state(&self, id: &str) -> Result<Value> {
        if !valid_id(id) {
            bail!("invalid Builder close identity")
        }
        let db = self.db.lock();
        let op = builder_authority::operation(&db, id)?;
        let scope = builder_authority::scope(&db, id, op.attempt)?
            .ok_or_else(|| anyhow::anyhow!("Builder scope missing"))?;
        if op.worker.node_id != self.node_id || scope["home_hub"] != self.node_id {
            bail!("Builder close belongs to another Home")
        }
        let intent = read(&db, id, op.attempt)?;
        let pending:u64=db.query_row("SELECT COUNT(*) FROM workbench_documents w LEFT JOIN runtime_deliveries d ON d.message_id=json_extract(w.value,'$.receipt.message_id') WHERE w.key LIKE 'builder-input:%' AND json_extract(w.value,'$.receipt.operation_id')=?1 AND json_extract(w.value,'$.request.attempt')=?2 AND COALESCE(d.phase,-1)!=2",params![id,op.attempt],|r|r.get(0))?;
        let bound: Option<(String, String)> = db.query_row(
            "SELECT b.reservation_id,p.price_id FROM operation_budget_bindings b JOIN reservation_prices p ON p.reservation_id=b.reservation_id WHERE b.operation_id=?1 AND b.attempt=?2",
            params![id, op.attempt], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let reservation_body: Option<String> = db.query_row(
            "SELECT r.body FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id WHERE b.operation_id=?1 AND b.attempt=?2",
            params![id, op.attempt], |r| r.get(0),
        ).optional()?;
        let reservation: super::budgets::Reservation = serde_json::from_str(
            reservation_body
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("Builder reservation missing"))?,
        )?;
        let frozen = !reservation.finalized && reservation.held > 0;
        let budget = json!({
            "reservation_id":reservation.request.id,
            "unit":reservation.request.unit,
            "charged":reservation.charged,
            "held":reservation.held,
            "finalized":reservation.finalized,
            "frozen":frozen
        });
        let mut unresolved_calls = Vec::new();
        let mut saw_nonterminal_call = false;
        let mut saw_usage_missing = false;
        let mut query = db.prepare(
            "SELECT body FROM official_calls WHERE operation_id=?1 AND attempt=?2 ORDER BY id",
        )?;
        for body in query.query_map(params![id, op.attempt], |r| r.get::<_, String>(0))? {
            let call: super::official_calls::Call = serde_json::from_str(&body?)?;
            let metering_binding_matches =
                bound.as_ref().is_some_and(|(reservation_id, price_id)| {
                    call.accounting.as_ref().is_some_and(|binding| {
                        binding.reservation_id == *reservation_id && binding.price_id == *price_id
                    })
                });
            let unresolved = call.state != "finished"
                || call.accounting_status != "estimated_pending_reconciliation"
                || call.metered.is_none()
                || !metering_binding_matches
                || call.request.epoch != op.epoch;
            if unresolved {
                saw_nonterminal_call |= call.state == "started";
                saw_usage_missing |=
                    call.accounting_status == "usage_unresolved" && call.state != "started";
                unresolved_calls.push(json!({"call_id":call.request.call_id,"state":call.state,"accounting_status":call.accounting_status}));
            }
        }
        let accounting = if unresolved_calls.is_empty() {
            // Eligibility is necessary but the owner still must explicitly finalize.
            if reservation.finalized {
                json!({"state":"settled","reason":"reservation_finalized","budget":budget})
            } else {
                json!({"state":"pending","reason":"awaiting_accounting_finalization","budget":budget})
            }
        } else {
            let (state, reason, recovery) = if saw_usage_missing {
                (
                    "waiting_accounting",
                    "needs_reconciliation",
                    "blocked_until_trusted_usage_is_reconciled",
                )
            } else if saw_nonterminal_call {
                (
                    "pending",
                    "official_call_not_terminal",
                    "wait_for_official_call_terminal_evidence",
                )
            } else {
                (
                    "blocked",
                    "accounting_unresolved",
                    "blocked_pending_accounting_review",
                )
            };
            let mut details = json!({
                "state":state,
                "reason":reason,
                "recovery":recovery,
                "unresolved_calls":unresolved_calls,
                "budget":budget
            });
            if saw_usage_missing {
                details["retryable"] = json!(false);
            }
            details
        };
        Ok(json!({"intent":intent,"operation":op,"pending_inputs":pending,"accounting":accounting}))
    }
    pub fn begin_builder_close(&self, id: &str, input: Close) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.price_id)
            || input.attempt == 0
            || input.epoch == 0
            || input.settlement != "internal_price"
        {
            bail!("invalid Builder close confirmation")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(prior) = read(&tx, id, input.attempt)? {
            if prior["request"] != request {
                bail!("Builder close identity conflict")
            }
            return Ok(prior);
        }
        let op = builder_authority::operation(&tx, id)?;
        let scope = builder_authority::scope(&tx, id, input.attempt)?
            .ok_or_else(|| anyhow::anyhow!("Builder scope missing"))?;
        if op.worker.node_id != self.node_id
            || op.attempt != input.attempt
            || op.epoch != input.epoch
            || scope["request"]["epoch"] != input.epoch
            || !matches!(op.state, State::Active | State::Reported)
        {
            bail!("Builder close requires current local execution")
        }
        let price:String=tx.query_row("SELECT p.price_id FROM operation_budget_bindings b JOIN reservation_prices p ON p.reservation_id=b.reservation_id WHERE b.operation_id=?1 AND b.attempt=?2",params![id,input.attempt],|r|r.get(0))?;
        if price != input.price_id {
            bail!("Builder close price mismatch")
        }
        let intent = json!({"request":request,"operation_id":id,"draft_id":scope["request"]["draft_id"],"state":"closing","at":now()});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(id, input.attempt), serde_json::to_string(&intent)?],
        )?;
        tx.execute(
            "INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",
            params![
                id,
                serde_json::to_string(
                    &json!({"kind":"builder_close_requested","actor":"owner","intent":intent})
                )?
            ],
        )?;
        tx.commit()?;
        Ok(intent)
    }
}
