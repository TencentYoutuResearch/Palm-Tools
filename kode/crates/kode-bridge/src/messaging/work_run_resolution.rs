//! Owner disposition may close settled work, but cannot stand in for stopping execution.
use super::{
    budgets::Reservation,
    operations::{Operation, State},
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde_json::Value;
pub(super) fn settled_assignments(db: &Connection, run_id: &str) -> Result<Vec<String>> {
    let mut query =
        db.prepare("SELECT id,state,body FROM work_assignments WHERE run_id=?1 ORDER BY id")?;
    let rows = query.query_map([run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut ids = Vec::new();
    for row in rows {
        let (id, status, body) = row?;
        let assignment: Value = serde_json::from_str(&body)?;
        if status != "completed"
            || assignment["state"] != "completed"
            || assignment["resources"]["state"] != "released"
            || assignment["stop"]["receipt"]["state"] != "execution_drained"
        {
            bail!("settled cancellation requires completed drained Assignments")
        }
        let operation_id = assignment["bundle"]["operation"]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("settled operation identity missing"))?;
        let body: String = db.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [operation_id],
            |row| row.get(0),
        )?;
        let operation: Operation = serde_json::from_str(&body)?;
        let stop = &assignment["stop"]["receipt"]["operation"];
        if !matches!(operation.state, State::Reported | State::Stopped)
            || stop["attempt"] != operation.attempt
            || stop["epoch"] != operation.epoch
        {
            bail!("settled cancellation operation no longer drained")
        }
        let body: String = db.query_row("SELECT r.body FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id WHERE b.operation_id=?1 AND b.attempt=?2", params![operation_id,operation.attempt], |row| row.get(0))?;
        let reservation: Reservation = serde_json::from_str(&body)?;
        if !reservation.finalized
            || reservation.held != 0
            || assignment["accounting"]["receipt"]["reservation"]
                != serde_json::to_value(&reservation)?
        {
            bail!("settled cancellation requires exact finalized accounting")
        }
        let unfinished: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM official_calls WHERE operation_id=?1 AND state!='finished')",[operation_id],|row|row.get(0))?;
        if unfinished {
            bail!("settled cancellation has unresolved model calls")
        }
        ids.push(id);
    }
    if ids.is_empty() {
        bail!("settled cancellation requires prior Assignments")
    }
    let held: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM assignment_resource_holds h JOIN work_assignments a ON a.id=h.assignment_id WHERE a.run_id=?1 AND h.state='held')",[run_id],|row|row.get(0))?;
    if held {
        bail!("settled cancellation has active resource holds")
    }
    Ok(ids)
}
