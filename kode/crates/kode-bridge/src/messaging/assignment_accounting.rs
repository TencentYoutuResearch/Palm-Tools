//! Finalize internal team-budget pricing only under an explicitly frozen policy.
use super::{
    budgets::{self, Reservation, Settle},
    model::{now, valid_id},
    official_calls::{Call, Counters},
    operations::Operation,
    pricing::{self, Attribution, Price, Usage},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finalize {
    pub request_id: String,
    pub expected_revision: u64,
}
impl Store {
    pub fn finalize_assignment_accounting(&self, id: &str, input: Finalize) -> Result<Value> {
        if !valid_id(id) || !valid_id(&input.request_id) || input.expected_revision == 0 {
            bail!("invalid Assignment accounting command")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if !assignment["accounting"].is_null() {
            if assignment["accounting"]["request"] != request {
                bail!("Assignment accounting identity conflict")
            }
            return Ok(assignment["accounting"]["receipt"].clone());
        }
        if assignment["revision"] != input.expected_revision
            || assignment["stop"]["receipt"]["state"] != "execution_drained"
        {
            bail!("Assignment accounting requires exact drained revision")
        }
        let body: String = tx.query_row(
            "SELECT body FROM work_runs WHERE id=?1",
            [assignment["run_id"].as_str()],
            |r| r.get(0),
        )?;
        let run: Value = serde_json::from_str(&body)?;
        let policy = &run["authorization"]["snapshot"]["policies"]["budget"];
        if run["context_hash"] != assignment["context_hash"]
            || run["authorization"]["snapshot_hash"] != assignment["authorization_hash"]
            || policy["policy"]["settlement"] != "internal_price"
        {
            bail!("frozen internal-price settlement policy required")
        }
        let operation_id = assignment["bundle"]["operation"]["id"].as_str().unwrap();
        let body: String = tx.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [operation_id],
            |r| r.get(0),
        )?;
        let operation: Operation = serde_json::from_str(&body)?;
        let stopped = &assignment["stop"]["receipt"]["operation"];
        if stopped["attempt"] != operation.attempt
            || stopped["epoch"] != operation.epoch
            || !matches!(
                operation.state,
                super::operations::State::Reported | super::operations::State::Stopped
            )
        {
            bail!("Assignment accounting stop changed")
        }
        let (body,price_body):(String,String)=tx.query_row("SELECT r.body,p.body FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id JOIN reservation_prices rp ON rp.reservation_id=r.id JOIN price_versions p ON p.id=rp.price_id WHERE b.operation_id=?1 AND b.attempt=?2",params![operation_id,operation.attempt],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let reservation: Reservation = serde_json::from_str(&body)?;
        let price: Price = serde_json::from_str(&price_body)?;
        if reservation.request.id != assignment["bundle"]["reservation"]["request"]["id"]
            || reservation.finalized
            || reservation
                .charge_basis
                .as_deref()
                .is_some_and(|b| b != "estimated")
        {
            bail!("Assignment reservation already reconciled or changed")
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
                || call.request.epoch != assignment["bundle"]["operation"]["epoch"]
            {
                bail!("official usage remains unresolved")
            }
            super::official_accounting::add(&mut total, call.metered.as_ref().unwrap())?;
            calls.push(json!({"call_id":call.request.call_id,"sequence":call.sequence}));
        }
        let usage = Usage {
            event_id: "assignment-final".into(),
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
            bail!("Assignment usage charge needs reconciliation")
        }
        let at = now();
        let settled = budgets::settle_internal_price_in(
            &tx,
            &reservation.request.id,
            Settle {
                event_id: format!("assignment-{id}"),
                expected_revision: reservation.revision,
                total_charge: charge,
                finalized: true,
                basis: "internal_price".into(),
            },
            at,
        )?;
        let receipt = json!({"assignment_id":id,"label":"团队预算","basis":"configured_internal_price","policy":policy,"price_id":price.id,
            "reservation":settled,"calls":calls,"provider_cost_status":"unconfirmed","completion_authorized":false,"at":at});
        assignment["accounting"] = json!({"request":request,"receipt":receipt});
        assignment["revision"] = json!(input.expected_revision + 1);
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        tx.execute(
            "INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",
            params![
                assignment["run_id"].as_str(),
                serde_json::to_string(
                    &json!({"kind":"assignment_team_budget_finalized","at":at,"receipt":receipt})
                )?
            ],
        )?;
        drop(query);
        tx.commit()?;
        Ok(receipt)
    }
}
