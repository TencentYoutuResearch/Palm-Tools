//! Official calls share an attempt's frozen internal price; evidence and debit commit together.
use super::{
    budgets::{settle_in, Reservation, Settle},
    official_calls::{Begin, Call, Counters, Evidence},
    operations::Operation,
    pricing::{Attribution, ModelPolicy, Price, Usage},
};
use anyhow::{bail, Result};
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Binding {
    pub reservation_id: String,
    pub price_id: String,
}
pub(super) fn prepare(
    tx: &Transaction,
    op: &Operation,
    request: &Begin,
) -> Result<Option<Binding>> {
    if !op.budget_required {
        return Ok(None);
    }
    let (reservation_id,body):(String,String)=tx.query_row("SELECT b.reservation_id,p.body FROM operation_budget_bindings b JOIN reservation_prices r ON r.reservation_id=b.reservation_id JOIN price_versions p ON p.id=r.price_id WHERE b.operation_id=?1 AND b.attempt=?2",params![op.id,op.attempt],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let price: Price = serde_json::from_str(&body)?;
    let reserved: String = tx.query_row(
        "SELECT body FROM budget_reservations WHERE id=?1",
        [&reservation_id],
        |r| r.get(0),
    )?;
    let reserved: Reservation = serde_json::from_str(&reserved)?;
    if reserved
        .charge_basis
        .as_deref()
        .is_some_and(|basis| basis != "estimated")
    {
        bail!("official call reservation was manually settled")
    }

    if price.model_policy != ModelPolicy::RequestedModel || price.model != request.model {
        bail!("official call requires matching requested-model price")
    }
    let native: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM metered_usage WHERE reservation_id=?1)",
        [&reservation_id],
        |r| r.get(0),
    )?;
    let unresolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM official_calls WHERE operation_id=?1 AND attempt=?2 AND (state!='finished' OR COALESCE(json_extract(body,'$.accounting_status'),'')!='estimated_pending_reconciliation'))",params![op.id,op.attempt],|r|r.get(0))?;
    if unresolved {
        bail!("previous official call requires reconciliation")
    }
    if native {
        bail!("reservation already has native usage accounting")
    }
    Ok(Some(Binding {
        reservation_id,
        price_id: price.id,
    }))
}
pub(super) fn apply(tx: &Transaction, call: &mut Call, event: &Evidence, at: u64) -> Result<()> {
    let Some(binding) = call.accounting.clone() else {
        return Ok(());
    };
    let Some(usage) = &event.usage else {
        call.accounting_status = "usage_unresolved".into();
        return Ok(());
    };
    if usage.cache_write_input_tokens != 0 {
        call.accounting_status = "cache_write_pricing_unresolved".into();
        return Ok(());
    }
    if call.metered.as_ref().is_some_and(|old| {
        usage.input_tokens < old.input_tokens
            || usage.cached_input_tokens < old.cached_input_tokens
            || usage.output_tokens < old.output_tokens
    }) {
        call.accounting_status = "counter_regression".into();
        return Ok(());
    }
    if call.accounting_status == "counter_regression" {
        return Ok(());
    }
    call.metered = Some(usage.clone());
    let mut total = usage.clone();
    let mut query = tx.prepare(
        "SELECT body FROM official_calls WHERE operation_id=?1 AND attempt=?2 AND id!=?3",
    )?;
    for body in query.query_map(
        params![
            call.request.operation_id,
            call.request.attempt,
            call.request.call_id
        ],
        |r| r.get::<_, String>(0),
    )? {
        let other: Call = serde_json::from_str(&body?)?;
        if other.accounting.as_ref().is_some_and(|b| {
            b.reservation_id == binding.reservation_id && b.price_id == binding.price_id
        }) {
            if let Some(u) = other.metered {
                add(&mut total, &u)?;
            }
        }
    }
    let body: String = tx.query_row(
        "SELECT body FROM price_versions WHERE id=?1",
        [&binding.price_id],
        |r| r.get(0),
    )?;
    let price: Price = serde_json::from_str(&body)?;
    let body: String = tx.query_row(
        "SELECT body FROM budget_reservations WHERE id=?1",
        [&binding.reservation_id],
        |r| r.get(0),
    )?;
    let reservation: Reservation = serde_json::from_str(&body)?;
    if reservation
        .charge_basis
        .as_deref()
        .is_some_and(|basis| basis != "estimated")
    {
        bail!("official usage cannot overwrite manual settlement")
    }
    let input = Usage {
        event_id: "official-aggregate".into(),
        reservation_id: binding.reservation_id.clone(),
        expected_revision: reservation.revision,
        model: price.model.clone(),
        input_tokens: total.input_tokens,
        cached_input_tokens: total.cached_input_tokens,
        output_tokens: total.output_tokens,
        attribution: Attribution::RequestedModel {
            rerouted: false,
            cache_write_input_tokens: 0,
        },
    };
    let charge = super::pricing::estimate(&price, &input)?;
    let result = settle_in(
        tx,
        &binding.reservation_id,
        Settle {
            event_id: format!("official-{}", uuid::Uuid::new_v4()),
            expected_revision: reservation.revision,
            total_charge: charge,
            finalized: false,
            basis: "estimated".into(),
        },
        at,
    )?;
    tx.execute("INSERT INTO budget_events(body) VALUES (?1)",[serde_json::to_string(&serde_json::json!({"kind":"official_usage_estimated","call_id":call.request.call_id,"call_sequence":event.sequence,"price_id":binding.price_id,"aggregate":input,"reservation":result}))?])?;
    call.accounting_status = "estimated_pending_reconciliation".into();
    Ok(())
}
pub(super) fn add(total: &mut Counters, other: &Counters) -> Result<()> {
    total.input_tokens = total
        .input_tokens
        .checked_add(other.input_tokens)
        .ok_or_else(|| anyhow::anyhow!("usage overflow"))?;
    total.cached_input_tokens = total
        .cached_input_tokens
        .checked_add(other.cached_input_tokens)
        .ok_or_else(|| anyhow::anyhow!("usage overflow"))?;
    total.output_tokens = total
        .output_tokens
        .checked_add(other.output_tokens)
        .ok_or_else(|| anyhow::anyhow!("usage overflow"))?;
    Ok(())
}
