//! Frozen per-attempt scope. Every lease admission checks the current grant revision.
use super::{
    operations::{Operation, State},
    store::Store,
    team_grants::{self, Check},
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub grant_id: String,
    pub attempt: u64,
    pub epoch: u64,
    pub scope: Check,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attach {
    pub expected_revision: u64,
    pub binding: Binding,
}
fn key(id: &str) -> String {
    format!("operation-grant:{}", serde_json::to_string(id).unwrap())
}
pub(super) fn read(db: &Connection, id: &str) -> Result<Option<Binding>> {
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(id)],
            |r| r.get(0),
        )
        .optional()?;
    value.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn check_budget_scope(
    db: &Connection,
    op: &Operation,
    scope: &Check,
    required: bool,
) -> Result<()> {
    let body:Option<String>=db.query_row("SELECT r.body FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id WHERE b.operation_id=?1 AND b.attempt=?2",params![op.id,op.attempt],|r|r.get(0)).optional()?;
    let Some(body) = body else {
        if required && op.budget_required {
            bail!("grant requires the actual budget reservation")
        }
        return Ok(());
    };
    let reservation: super::budgets::Reservation = serde_json::from_str(&body)?;
    for id in &reservation.request.budget_ids {
        if !scope.budget_ids.contains(id) {
            bail!("actual reservation exceeds operation grant budget scope")
        }
        let body: String =
            db.query_row("SELECT body FROM budgets WHERE id=?1", [id], |r| r.get(0))?;
        let budget: super::budgets::Budget = serde_json::from_str(&body)?;
        if matches!(budget.scope, super::budgets::Scope::Team) && budget.scope_id != scope.team_id {
            bail!("actual reservation belongs to another team")
        }
    }
    Ok(())
}
pub(super) fn check_budget_attachment(db: &Connection, op: &Operation, at: u64) -> Result<()> {
    if op.grant_required && read(db, &op.id)?.is_some() {
        admit(db, op, at)?;
    }
    Ok(())
}
pub(super) fn admit(db: &Connection, op: &Operation, at: u64) -> Result<u64> {
    if !op.grant_required {
        return Ok(u64::MAX);
    }
    let binding = read(db, &op.id)?.ok_or_else(|| anyhow::anyhow!("operation grant missing"))?;
    if binding.attempt != op.attempt
        || binding.epoch != op.epoch
        || binding.scope.target.host != op.worker.node_id
    {
        bail!("operation grant attempt changed")
    }
    let decision = team_grants::evaluate(db, &binding.grant_id, &binding.scope, at)?;
    if decision["allowed"] != true {
        bail!("operation grant denied: {}", decision["reason"])
    }
    check_budget_scope(db, op, &binding.scope, true)?;
    super::coordinator_control::lease_gate(db, op, at)?;
    decision["expires_at"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("grant expiry missing"))
}
impl Store {
    pub fn attach_operation_grant(&self, id: &str, input: Attach, at: u64) -> Result<Operation> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = attach_in(&tx, id, input, at)?;
        tx.commit()?;
        Ok(result)
    }
}

impl Store {
    pub fn operation_grant_context(&self, id: &str, at: u64) -> Result<serde_json::Value> {
        let db = self.db.lock();
        let body: String = db.query_row("SELECT body FROM operations WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
        let op: Operation = serde_json::from_str(&body)?;
        let binding = read(&db, id)?;
        Ok(
            serde_json::json!({"operation_id":op.id,"attempt":op.attempt,"epoch":op.epoch,"worker":op.worker,"grant_required":op.grant_required,"binding":binding,"execution_workspace":super::assignment_scope::for_operation(&db,id)?,"available":admit(&db,&op,at).is_ok()}),
        )
    }
}

pub(super) fn attach_in(
    tx: &rusqlite::Transaction,
    id: &str,
    input: Attach,
    at: u64,
) -> Result<Operation> {
    let body: String = tx.query_row("SELECT body FROM operations WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    let mut op: Operation = serde_json::from_str(&body)?;
    if !op.grant_required
        || op.state != State::Prepared
        || op.attempt != input.binding.attempt
        || op.epoch != input.binding.epoch
        || op.worker.node_id != input.binding.scope.target.host
    {
        bail!("operation not eligible for grant binding")
    }
    if let Some(old) = read(tx, id)? {
        if old.attempt == op.attempt {
            if old != input.binding {
                bail!("operation grant binding immutable")
            }
            return Ok(op);
        }
    }
    if op.revision != input.expected_revision {
        bail!("operation grant revision conflict")
    }
    let decision = team_grants::evaluate(tx, &input.binding.grant_id, &input.binding.scope, at)?;
    if decision["allowed"] != true {
        bail!("operation grant denied: {}", decision["reason"])
    }
    check_budget_scope(tx, &op, &input.binding.scope, false)?;
    tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value",params![key(id),op.attempt,serde_json::to_string(&input.binding)?])?;
    op.grant_required = true;
    op.grant_available = Some(true);
    op.revision += 1;
    super::operations::save(
        tx,
        &op,
        serde_json::json!({"kind":"grant_attached","binding":input.binding,"operation":op}),
    )?;
    Ok(op)
}
