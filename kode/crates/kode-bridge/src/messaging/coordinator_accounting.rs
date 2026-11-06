//! Explicit owner finalization of reported Coordinator internal pricing; never a provider invoice.
use super::{
    budgets::{self, Reservation, Settle},
    builder_authority, coordinator_control,
    model::{now, valid_id},
    official_calls::{Call, Counters},
    operations::State,
    pricing::{self, Attribution, Price, Usage},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finalize {
    pub request_id: String,
    pub attempt: u64,
    pub epoch: u64,
    pub expected_revision: u64,
    pub price_id: String,
    pub settlement: String,
}
impl Store {
    pub fn finalize_coordinator_accounting(&self, id: &str, input: Finalize) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.price_id)
            || input.attempt == 0
            || input.epoch == 0
            || input.expected_revision == 0
            || input.settlement != "internal_price"
        {
            bail!("invalid Coordinator accounting confirmation")
        }
        let request = serde_json::to_value(&input)?;
        let key = format!("coordinator-accounting:{}", json!([id, input.attempt]));
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            let prior: Value = serde_json::from_str(&prior)?;
            if prior["request"] != request {
                bail!("Coordinator accounting identity conflict")
            }
            return Ok(prior["receipt"].clone());
        }
        let operation = builder_authority::operation(&tx, id)?;
        let scope = coordinator_control::operation_binding(&tx, id)?
            .ok_or_else(|| anyhow::anyhow!("Coordinator scope missing"))?;
        if operation.worker.node_id != self.node_id
            || operation.state != State::Reported
            || operation.attempt != input.attempt
            || operation.epoch != input.epoch
            || operation.revision != input.expected_revision
            || scope["request"]["epoch"] != input.epoch
            || scope["request"]["attempt"] != input.attempt
            || scope["request"]["operation_id"] != id
        {
            bail!("Coordinator accounting requires exact reported operation")
        }
        if super::coordinator_close::pending_in(&tx, id, input.attempt)? != (0, 0) {
            bail!("Coordinator inputs or workflow updates remain unresolved")
        }
        let operation_id = id;
        let (body,price_body):(String,String)=tx.query_row("SELECT r.body,p.body FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id JOIN reservation_prices rp ON rp.reservation_id=r.id JOIN price_versions p ON p.id=rp.price_id WHERE b.operation_id=?1 AND b.attempt=?2",params![id,input.attempt],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let reservation: Reservation = serde_json::from_str(&body)?;
        let price: Price = serde_json::from_str(&price_body)?;
        if price.id != input.price_id
            || reservation.request.operation_id != id
            || reservation.finalized
            || reservation
                .charge_basis
                .as_deref()
                .is_some_and(|b| b != "estimated")
        {
            bail!("Coordinator reservation or confirmed price changed")
        }
        let native: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM metered_usage WHERE reservation_id=?1)",
            [&reservation.request.id],
            |r| r.get(0),
        )?;
        if native {
            bail!("mixed usage accounting requires reconciliation")
        }
        let mut total = Counters {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            cache_write_input_tokens: 0,
        };
        let mut query = tx.prepare(
            "SELECT body FROM official_calls WHERE operation_id=?1 AND attempt=?2 ORDER BY id",
        )?;
        let mut calls = Vec::new();
        for body in query.query_map(params![operation_id, operation.attempt], |r| {
            r.get::<_, String>(0)
        })? {
            let call: Call = serde_json::from_str(&body?)?;
            if call.state != "finished"
                || call.accounting_status != "estimated_pending_reconciliation"
                || call.metered.is_none()
                || call.accounting.as_ref().is_none_or(|b| {
                    b.reservation_id != reservation.request.id || b.price_id != price.id
                })
                || call.request.epoch != operation.epoch
            {
                bail!("official usage remains unresolved")
            }
            super::official_accounting::add(&mut total, call.metered.as_ref().unwrap())?;
            calls.push(json!({"call_id":call.request.call_id,"sequence":call.sequence}));
        }
        let usage = Usage {
            event_id: "coordinator-final".into(),
            reservation_id: reservation.request.id.clone(),
            expected_revision: reservation.revision,
            model: price.model.clone(),
            input_tokens: total.input_tokens,
            cached_input_tokens: total.cached_input_tokens,
            output_tokens: total.output_tokens,
            attribution: Attribution::RequestedModel {
                rerouted: false,
                cache_write_input_tokens: total.cache_write_input_tokens,
            },
        };
        let charge = pricing::estimate(&price, &usage)?;
        if charge != reservation.charged {
            bail!("Coordinator usage charge needs reconciliation")
        }

        let at = now();
        let settled = budgets::settle_internal_price_in(
            &tx,
            &reservation.request.id,
            Settle {
                event_id: format!("coordinator-{}", input.request_id),
                expected_revision: reservation.revision,
                total_charge: charge,
                finalized: true,
                basis: "internal_price".into(),
            },
            at,
        )?;
        let receipt = json!({"operation_id":id,"attempt":input.attempt,"team_id":scope["team_id"],"control_revision":scope["revision"],
            "label":"团队预算","basis":"configured_internal_price","price_id":price.id,
            "reservation":settled,"calls":calls,"provider_cost_status":"unconfirmed","completion_authorized":false,"at":at});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key,
                serde_json::to_string(&json!({"request":request,"receipt":receipt}))?
            ],
        )?;
        tx.execute("INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",params![id,serde_json::to_string(&json!({"kind":"coordinator_team_budget_finalized","actor":"owner","request":request,"receipt":receipt}))?])?;
        drop(query);
        tx.commit()?;
        Ok(receipt)
    }
}
