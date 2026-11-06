//! Internal team accounting in integer units. Never a provider balance or proof of task completion.
use super::{model::valid_id, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
#[derive(Debug)]
pub struct InsufficientBudget;
impl std::fmt::Display for InsufficientBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("insufficient team budget") }
}
impl std::error::Error for InsufficientBudget {}
// Keep both aggregate counters and their signed difference exact in JSON/JavaScript.
const MAX_AMOUNT: u64 = 4_000_000_000_000_000;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Team,
    Shared,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configure {
    pub id: String,
    pub scope: Scope,
    pub scope_id: String,
    pub unit: String,
    pub limit: u64,
    pub starts_at: u64,
    pub ends_at: u64,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Budget {
    pub id: String,
    pub scope: Scope,
    pub scope_id: String,
    pub unit: String,
    pub limit: u64,
    pub starts_at: u64,
    pub ends_at: u64,
    pub revision: u64,
    pub spent: u64,
    pub reserved: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reserve {
    pub id: String,
    pub budget_ids: Vec<String>,
    pub amount: u64,
    pub unit: String,
    pub operation_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Reservation {
    pub request: Reserve,
    pub revision: u64,
    pub charged: u64,
    pub charge_basis: Option<String>,
    pub held: u64,
    pub finalized: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settle {
    pub event_id: String,
    pub expected_revision: u64,
    pub total_charge: u64,
    pub finalized: bool,
    pub basis: String,
}
fn budget(tx: &rusqlite::Connection, id: &str) -> Result<Budget> {
    let body: String = tx.query_row("SELECT body FROM budgets WHERE id=?1", [id], |r| r.get(0))?;
    Ok(serde_json::from_str(&body)?)
}
fn save(tx: &Transaction, row: &Budget) -> Result<()> {
    tx.execute("INSERT INTO budgets(id,body) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![row.id,serde_json::to_string(row)?])?;
    Ok(())
}
fn audit(tx: &Transaction, value: serde_json::Value) -> Result<()> {
    tx.execute(
        "INSERT INTO budget_events(body) VALUES (?1)",
        [serde_json::to_string(&value)?],
    )?;
    Ok(())
}
pub(super) fn configure_in(tx: &Transaction, input: Configure, at: u64) -> Result<Budget> {
    if !valid_id(&input.id)
        || !valid_id(&input.scope_id)
        || !valid_id(&input.unit)
        || input.limit > MAX_AMOUNT
        || input.starts_at >= input.ends_at
        || input.ends_at > MAX_AMOUNT
    {
        bail!("invalid budget configuration")
    }
    let old: Option<String> = tx
        .query_row("SELECT body FROM budgets WHERE id=?1", [&input.id], |r| {
            r.get(0)
        })
        .optional()?;
    let mut row = if let Some(body) = old {
        serde_json::from_str::<Budget>(&body)?
    } else {
        Budget {
            id: input.id.clone(),
            scope: input.scope.clone(),
            scope_id: input.scope_id.clone(),
            unit: input.unit.clone(),
            limit: 0,
            starts_at: input.starts_at,
            ends_at: input.ends_at,
            revision: 0,
            spent: 0,
            reserved: 0,
        }
    };
    if row.revision != input.expected_revision {
        bail!("budget revision conflict")
    }
    if row.scope != input.scope
        || row.scope_id != input.scope_id
        || row.unit != input.unit
        || row.starts_at != input.starts_at
        || row.ends_at != input.ends_at
    {
        bail!("budget identity/unit/period is immutable; create an explicitly funded new period")
    }
    if input.limit < row.spent + row.reserved {
        bail!("budget limit cannot discard committed accounting")
    }
    row.limit = input.limit;
    row.revision += 1;
    save(tx, &row)?;
    audit(
        tx,
        serde_json::json!({"kind":"budget_configured","at":at,"budget":row}),
    )?;
    Ok(row)
}
impl Store {
    pub fn budget(&self, id: &str) -> Result<serde_json::Value> {
        let db = self.db.lock();
        let row = budget(&db, id)?;
        let estimated:u64=db.query_row("SELECT COALESCE(SUM(json_extract(r.body,'$.charged')),0) FROM budget_reservation_index i JOIN budget_reservations r ON r.id=i.reservation_id WHERE i.budget_id=?1 AND json_extract(r.body,'$.charge_basis')='estimated'",[id],|r|r.get(0))?;
        let internal:u64=db.query_row("SELECT COALESCE(SUM(json_extract(r.body,'$.charged')),0) FROM budget_reservation_index i JOIN budget_reservations r ON r.id=i.reservation_id WHERE i.budget_id=?1 AND json_extract(r.body,'$.charge_basis')='internal_price'",[id],|r|r.get(0))?;
        Ok(
            serde_json::json!({"label":"团队预算","internal_price_charged":internal,"estimated_charged":estimated,"available":row.limit as i64-row.spent as i64-row.reserved as i64,"budget":row}),
        )
    }
    pub fn configure_budget(&self, input: Configure, at: u64) -> Result<Budget> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let row = configure_in(&tx, input, at)?;
        tx.commit()?;
        Ok(row)
    }
    pub fn reserve_budget(&self, input: Reserve, at: u64) -> Result<Reservation> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = reserve_in(&tx, input, at)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn settle_budget(&self, id: &str, input: Settle, at: u64) -> Result<Reservation> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = settle_in(&tx, id, input, at)?;
        tx.commit()?;
        Ok(result)
    }
}

pub(super) fn settle_in(tx: &Transaction, id: &str, input: Settle, at: u64) -> Result<Reservation> {
    settle_with_basis(tx, id, input, at, false)
}
pub(super) fn settle_internal_price_in(
    tx: &Transaction,
    id: &str,
    input: Settle,
    at: u64,
) -> Result<Reservation> {
    if input.basis != "internal_price" || !input.finalized {
        bail!("internal price finalization required")
    }
    settle_with_basis(tx, id, input, at, true)
}
fn settle_with_basis(
    tx: &Transaction,
    id: &str,
    input: Settle,
    at: u64,
    internal: bool,
) -> Result<Reservation> {
    if !valid_id(&input.event_id)
        || input.total_charge > MAX_AMOUNT
        || !(matches!(input.basis.as_str(), "estimated" | "reported" | "manual")
            || internal && input.basis == "internal_price")
        || input.finalized && input.basis == "estimated"
    {
        bail!("invalid settlement evidence")
    }
    let wire = serde_json::to_string(&input)?;
    let prior: Option<(String, String)> = tx
        .query_row(
            "SELECT command,result FROM budget_settlements WHERE reservation_id=?1 AND event_id=?2",
            params![id, input.event_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((command, result)) = prior {
        if command != wire {
            bail!("settlement event conflict")
        }
        return Ok(serde_json::from_str(&result)?);
    }
    let body: String = tx.query_row(
        "SELECT body FROM budget_reservations WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    let mut row: Reservation = serde_json::from_str(&body)?;
    if row.revision != input.expected_revision || row.finalized {
        bail!("reservation revision/terminal conflict")
    }
    let held = if input.finalized {
        0
    } else {
        row.request.amount.saturating_sub(input.total_charge)
    };
    for budget_id in &row.request.budget_ids {
        let mut b = budget(&tx, budget_id)?;
        b.spent = b
            .spent
            .checked_sub(row.charged)
            .and_then(|v| v.checked_add(input.total_charge))
            .filter(|v| *v <= MAX_AMOUNT)
            .ok_or_else(|| anyhow::anyhow!("budget accounting overflow"))?;
        b.reserved = b
            .reserved
            .checked_sub(row.held)
            .and_then(|v| v.checked_add(held))
            .filter(|v| *v <= MAX_AMOUNT)
            .ok_or_else(|| anyhow::anyhow!("reservation accounting overflow"))?;
        save(&tx, &b)?;
    }
    row.charged = input.total_charge;
    row.charge_basis = Some(input.basis.clone());
    row.held = held;
    row.finalized = input.finalized;
    row.revision += 1;
    let result = serde_json::to_string(&row)?;
    tx.execute(
        "UPDATE budget_reservations SET body=?2 WHERE id=?1",
        params![id, result],
    )?;
    tx.execute("INSERT INTO budget_settlements(reservation_id,event_id,command,result) VALUES (?1,?2,?3,?4)",params![id,input.event_id,wire,result])?;
    audit(
        &tx,
        serde_json::json!({"kind":"budget_settled","at":at,"command":input,"reservation":row}),
    )?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn configure(id: &str, scope: Scope, limit: u64) -> Configure {
        Configure {
            id: id.into(),
            scope,
            scope_id: id.into(),
            unit: "usd_micros".into(),
            limit,
            starts_at: 1000,
            ends_at: 2000,
            expected_revision: 0,
        }
    }
    fn reserve(id: &str, budgets: &[&str], amount: u64) -> Reserve {
        Reserve {
            id: id.into(),
            budget_ids: budgets.iter().map(|s| s.to_string()).collect(),
            amount,
            unit: "usd_micros".into(),
            operation_id: id.into(),
        }
    }
    #[test]
    fn shared_budget_atomicity_estimation_and_reconciliation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.sqlite");
        let store = Store::open(&path, "home").unwrap();
        for (id, scope, limit) in [
            ("a", Scope::Team, 100),
            ("b", Scope::Team, 100),
            ("zshared", Scope::Shared, 100),
        ] {
            store
                .configure_budget(configure(id, scope, limit), 1000)
                .unwrap();
        }
        let request = reserve("first", &["a", "zshared"], 60);
        store.reserve_budget(request.clone(), 1000).unwrap();
        store.reserve_budget(request, 1100).unwrap();
        assert!(store
            .reserve_budget(reserve("second", &["b", "zshared"], 60), 1100)
            .is_err());
        assert_eq!(
            store.budget("b").unwrap()["budget"]["reserved"],
            0,
            "failed shared admission rolls back team reservation"
        );
        let estimated = Settle {
            event_id: "estimate".into(),
            expected_revision: 1,
            total_charge: 20,
            finalized: false,
            basis: "estimated".into(),
        };
        let row = store
            .settle_budget("first", estimated.clone(), 1200)
            .unwrap();
        assert_eq!(row.held, 40);
        store.settle_budget("first", estimated, 1201).unwrap();
        assert_eq!(store.budget("a").unwrap()["estimated_charged"], 20);
        assert_eq!(store.budget("a").unwrap()["available"], 40);
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        let final_event = Settle {
            event_id: "bill".into(),
            expected_revision: 2,
            total_charge: 30,
            finalized: true,
            basis: "reported".into(),
        };
        store
            .settle_budget("first", final_event.clone(), 2500)
            .unwrap();
        store.settle_budget("first", final_event, 2501).unwrap();
        assert_eq!(store.budget("a").unwrap()["available"], 70);
        assert_eq!(store.budget("a").unwrap()["estimated_charged"], 0);
        assert!(store
            .reserve_budget(reserve("expired", &["a"], 1), 2000)
            .is_err());
        assert!(store
            .reserve_budget(reserve("early", &["a"], 1), 999)
            .is_err());
        assert!(store
            .settle_budget(
                "first",
                Settle {
                    event_id: "different".into(),
                    expected_revision: 3,
                    total_charge: 0,
                    finalized: true,
                    basis: "manual".into()
                },
                2502
            )
            .is_err());
        assert_eq!(
            store
                .db
                .lock()
                .query_row("SELECT count(*) FROM budget_events", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            6
        );
    }
    #[test]
    fn concurrent_reservations_cannot_overspend_and_actual_overrun_is_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            std::sync::Arc::new(Store::open(&dir.path().join("budget.sqlite"), "home").unwrap());
        store
            .configure_budget(configure("team", Scope::Team, 100), 1000)
            .unwrap();
        let handles = (0..2)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store.reserve_budget(reserve(&format!("r{i}"), &["team"], 60), 1000)
                })
            })
            .collect::<Vec<_>>();
        let winners = handles
            .into_iter()
            .filter_map(|h| h.join().unwrap().ok())
            .collect::<Vec<_>>();
        assert_eq!(winners.len(), 1);
        let id = &winners[0].request.id;
        assert!(store
            .settle_budget(
                id,
                Settle {
                    event_id: "bad".into(),
                    expected_revision: 1,
                    total_charge: 20,
                    finalized: true,
                    basis: "estimated".into()
                },
                1001
            )
            .is_err());
        store
            .settle_budget(
                id,
                Settle {
                    event_id: "actual".into(),
                    expected_revision: 1,
                    total_charge: 120,
                    finalized: true,
                    basis: "reported".into(),
                },
                1002,
            )
            .unwrap();
        assert_eq!(store.budget("team").unwrap()["available"], -20);
        assert!(store
            .reserve_budget(reserve("next", &["team"], 1), 1003)
            .is_err());
        assert!(store
            .configure_budget(
                Configure {
                    expected_revision: 1,
                    ..configure("team", Scope::Team, 100)
                },
                1004
            )
            .is_err());
        store
            .configure_budget(
                Configure {
                    expected_revision: 1,
                    ..configure("team", Scope::Team, 150)
                },
                1005,
            )
            .unwrap();
        assert_eq!(store.budget("team").unwrap()["available"], 30);
    }
}

pub(super) fn reserve_in(tx: &Transaction, mut input: Reserve, at: u64) -> Result<Reservation> {
    if !valid_id(&input.id)
        || !valid_id(&input.operation_id)
        || !valid_id(&input.unit)
        || input.amount == 0
        || input.amount > MAX_AMOUNT
        || input.budget_ids.is_empty()
        || input.budget_ids.len() > 8
    {
        bail!("invalid budget reservation")
    }
    if input.budget_ids.iter().any(|id| !valid_id(id)) {
        bail!("invalid budget ID")
    }
    input.budget_ids.sort();
    if input.budget_ids.windows(2).any(|w| w[0] == w[1]) {
        bail!("duplicate budget constraint")
    }
    let wire = serde_json::to_string(&input)?;
    let prior: Option<(String, String)> = tx
        .query_row(
            "SELECT request,body FROM budget_reservations WHERE id=?1",
            [&input.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((request, body)) = prior {
        if request != wire {
            bail!("reservation identity conflict")
        }
        return Ok(serde_json::from_str(&body)?);
    }
    for id in &input.budget_ids {
        let mut row = budget(tx, id)?;
        if row.unit != input.unit || at < row.starts_at || at >= row.ends_at {
            bail!("budget unit or active period mismatch")
        }
        if row.spent + row.reserved + input.amount > row.limit {
            return Err(InsufficientBudget.into());
        }
        row.reserved += input.amount;
        save(tx, &row)?;
    }
    let row = Reservation {
        held: input.amount,
        request: input,
        revision: 1,
        charged: 0,
        charge_basis: None,
        finalized: false,
    };
    tx.execute(
        "INSERT INTO budget_reservations(id,request,body) VALUES (?1,?2,?3)",
        params![row.request.id, wire, serde_json::to_string(&row)?],
    )?;
    audit(
        tx,
        serde_json::json!({"kind":"budget_reserved","at":at,"reservation":row}),
    )?;
    Ok(row)
}
