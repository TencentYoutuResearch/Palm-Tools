//! Budget admission is checked in the operation lease transaction, never by a model promise.
use super::{
    budgets::{Budget, Reservation},
    operations::{Operation, State},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attach {
    pub attempt: u64,
    pub expected_revision: u64,
    pub reservation_id: String,
}
fn reservation(tx: &rusqlite::Connection, id: &str) -> Result<Reservation> {
    let body: String = tx.query_row(
        "SELECT body FROM budget_reservations WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&body)?)
}
/// Return earliest budget period boundary. A spent hold never renews authority.
pub(super) fn admit(tx: &rusqlite::Connection, operation: &Operation, at: u64) -> Result<u64> {
    let id: String = tx.query_row(
        "SELECT reservation_id FROM operation_budget_bindings WHERE operation_id=?1 AND attempt=?2",
        params![operation.id, operation.attempt],
        |r| r.get(0),
    )?;
    let row = reservation(tx, &id)?;
    if row.request.operation_id != operation.id || row.finalized || row.held == 0 {
        bail!("operation budget reservation is exhausted or finalized")
    }
    let mut until = u64::MAX;
    for id in &row.request.budget_ids {
        let body: String =
            tx.query_row("SELECT body FROM budgets WHERE id=?1", [id], |r| r.get(0))?;
        let b: Budget = serde_json::from_str(&body)?;
        if at < b.starts_at || at >= b.ends_at || b.spent + b.reserved > b.limit {
            bail!("operation budget is expired or overdrawn")
        }
        until = until.min(b.ends_at);
    }
    Ok(until)
}
impl Store {
    /// Frozen attempt accounting context; owner-only API, not lease authority.
    pub fn operation_accounting(
        &self,
        id: &str,
        attempt: u64,
    ) -> Result<Option<serde_json::Value>> {
        let db = self.db.lock();
        let row: Option<(String, Option<String>)> = db.query_row(
            "SELECT r.body,p.body FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id LEFT JOIN reservation_prices rp ON rp.reservation_id=r.id LEFT JOIN price_versions p ON p.id=rp.price_id WHERE b.operation_id=?1 AND b.attempt=?2",
            params![id,attempt], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        row.map(|(reservation, price)| {
            Ok(serde_json::json!({"operation_id":id,"attempt":attempt,
            "reservation":serde_json::from_str::<serde_json::Value>(&reservation)?,
            "price":price.map(|p|serde_json::from_str::<serde_json::Value>(&p)).transpose()?}))
        })
        .transpose()
    }

    pub fn attach_operation_budget(&self, id: &str, input: Attach) -> Result<Operation> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = attach_in(&tx, id, input)?;
        tx.commit()?;
        Ok(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{
        budgets::{Configure, Reserve, Scope, Settle},
        model::Address,
        operations::{Action, Command},
    };
    fn command(op: &Operation, action: Action) -> Command {
        Command {
            selection_ack: None,
            attempt: op.attempt,
            epoch: op.epoch,
            expected_revision: op.revision,
            action,
        }
    }
    #[test]
    fn budgeted_operation_requires_hold_and_cannot_renew_after_settlement() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("operations.sqlite"), "home").unwrap();
        let op = store
            .prepare_budgeted_operation(
                "owner",
                "key",
                Address {
                    node_id: "home".into(),
                    session_id: "worker".into(),
                },
                true,
            )
            .unwrap();
        assert!(store
            .prepare_operation("owner", "key", op.worker.clone())
            .is_err());
        assert!(store
            .command_operation(&op.id, command(&op, Action::Claim { lease_ms: 1000 }), 1000)
            .is_err());
        store
            .configure_budget(
                Configure {
                    id: "team".into(),
                    scope: Scope::Team,
                    scope_id: "team".into(),
                    unit: "credits".into(),
                    limit: 100,
                    starts_at: 1000,
                    ends_at: 4000,
                    expected_revision: 0,
                },
                1000,
            )
            .unwrap();
        store
            .reserve_budget(
                Reserve {
                    id: "hold".into(),
                    budget_ids: vec!["team".into()],
                    amount: 60,
                    unit: "credits".into(),
                    operation_id: op.id.clone(),
                },
                1000,
            )
            .unwrap();
        let attached = store
            .attach_operation_budget(
                &op.id,
                Attach {
                    attempt: 1,
                    expected_revision: 1,
                    reservation_id: "hold".into(),
                },
            )
            .unwrap();
        let active = store
            .command_operation(
                &op.id,
                command(&attached, Action::Claim { lease_ms: 60000 }),
                1000,
            )
            .unwrap()
            .operation;
        assert_eq!(active.lease_until, Some(4000));
        store
            .settle_budget(
                "hold",
                Settle {
                    event_id: "bill".into(),
                    expected_revision: 1,
                    total_charge: 20,
                    finalized: true,
                    basis: "reported".into(),
                },
                1100,
            )
            .unwrap();
        assert!(store
            .command_operation(
                &op.id,
                command(&active, Action::Renew { lease_ms: 1000 }),
                1200
            )
            .is_err());
        let cancelling = store
            .command_operation(&op.id, command(&active, Action::Cancel), 1201)
            .unwrap()
            .operation;
        let stopped = store
            .command_operation(
                &op.id,
                command(
                    &cancelling,
                    Action::AttestStopped {
                        reason: "fixture stopped".into(),
                    },
                ),
                1202,
            )
            .unwrap()
            .operation;
        let next = store
            .command_operation(&op.id, command(&stopped, Action::NextAttempt), 1203)
            .unwrap()
            .operation;
        assert!(store
            .command_operation(
                &op.id,
                command(&next, Action::Claim { lease_ms: 1000 }),
                1204
            )
            .is_err());
        assert!(store
            .attach_operation_budget(
                &op.id,
                Attach {
                    attempt: 2,
                    expected_revision: next.revision,
                    reservation_id: "hold".into()
                }
            )
            .is_err());
    }
}

pub(super) fn attach_in(tx: &rusqlite::Transaction, id: &str, input: Attach) -> Result<Operation> {
    let body: String = tx.query_row("SELECT body FROM operations WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    let mut op: Operation = serde_json::from_str(&body)?;
    let old:Option<String>=tx.query_row("SELECT reservation_id FROM operation_budget_bindings WHERE operation_id=?1 AND attempt=?2",params![id,input.attempt],|r|r.get(0)).optional()?;
    if let Some(prior) = old {
        if op.attempt == input.attempt && prior == input.reservation_id {
            return Ok(op);
        }
        bail!("operation budget binding conflict")
    }
    if !op.budget_required
        || op.state != State::Prepared
        || op.attempt != input.attempt
        || op.revision != input.expected_revision
    {
        bail!("budget attachment requires current prepared budgeted operation")
    }
    let held = reservation(tx, &input.reservation_id)?;
    if held.request.operation_id != op.id || held.finalized || held.held == 0 {
        bail!("reservation does not fund this operation")
    }
    tx.execute("INSERT INTO operation_budget_bindings(operation_id,attempt,reservation_id) VALUES (?1,?2,?3)",params![id,op.attempt,input.reservation_id])?;
    super::operation_grant::check_budget_attachment(tx, &op, super::model::now())?;
    op.revision += 1;
    super::operations::save(
        tx,
        &op,
        serde_json::json!({"kind":"budget_attached","reservation_id":input.reservation_id,"operation":op}),
    )?;
    Ok(op)
}
