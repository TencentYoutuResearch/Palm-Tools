//! Read-only blockers for the current run's execution operations, never settlement authority.
use super::{model::valid_id, store::Store};
use anyhow::{bail, Result};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

impl Store {
    pub fn work_run_accounting_status(&self, id: &str) -> Result<Option<Value>> {
        if !valid_id(id) {
            bail!("invalid work run accounting scope")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: Option<String> = tx
            .query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        let Some(body) = body else { return Ok(None) };
        let run: Value = serde_json::from_str(&body)?;
        if run["id"] != id || run["home_hub"] != self.node_id {
            bail!("work run accounting Home changed")
        }
        Ok(Some(observe(&tx, &run, &self.node_id)?))
    }
}

pub(super) fn source(id: &str, run: &str) -> String {
    // Arguments are internal SQL expressions, never request values.
    // Coordinator identity is the run's pinned origin (changed only by explicit
    // run transfer), not a replacement team control that has not adopted this run.
    format!("SELECT c.body,s.assignment_id,s.stage_id,budget.body FROM (
        SELECT operation_id,id AS assignment_id,stage_id FROM work_assignments
          WHERE run_id={id} AND id IN (SELECT json_extract(value,'$.assignment_id') FROM json_each({run},'$.stages'))
        UNION SELECT json_extract({run},'$.coordinator.operation_id'),NULL,NULL
      ) s JOIN operations op ON op.id=s.operation_id
      JOIN official_calls c ON c.operation_id=op.id AND c.attempt=json_extract(op.body,'$.attempt')
      LEFT JOIN operation_budget_bindings b ON b.operation_id=op.id AND b.attempt=c.attempt
      LEFT JOIN budget_reservations budget ON budget.id=b.reservation_id
      WHERE c.state!='started' AND json_extract(c.body,'$.accounting_status')='usage_unresolved'")
}
pub(super) fn observe(db: &rusqlite::Connection, run: &Value, home: &str) -> Result<Value> {
    let id = run["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid accounting run"))?;
    if run["home_hub"] != home {
        bail!("work run accounting Home changed")
    }
    let body = serde_json::to_string(run)?;
    let mut query = db.prepare(&format!("{} ORDER BY c.id LIMIT 65", source("?1", "?2")))?;
    let rows = query
        .query_map(rusqlite::params![id, body], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let truncated = rows.len() > 64;
    let mut calls = Vec::new();
    for (body, assignment, stage, reservation) in rows.into_iter().take(64) {
        let call: super::official_calls::Call = serde_json::from_str(&body)?;
        let budget = reservation.map(|body| -> Result<Value> {
                let r: super::budgets::Reservation = serde_json::from_str(&body)?;
                Ok(json!({"reservation_id":r.request.id,"unit":r.request.unit,"charged":r.charged,"held":r.held,"finalized":r.finalized,"frozen":!r.finalized && r.held>0}))
            }).transpose()?;
        calls.push(json!({"call_id":call.request.call_id,"operation_id":call.request.operation_id,
                "attempt":call.request.attempt,"epoch":call.request.epoch,"assignment_id":assignment,"stage_id":stage,
                "state":call.state,"accounting_status":call.accounting_status,"budget":budget}));
    }
    let blocked = !calls.is_empty();
    Ok(
        json!({"home_hub":home,"run_id":id,"team_id":run["team_id"],"run_revision":run["revision"],
            "authority":"home_accounting_observation","read_only":true,"blocked":blocked,
            "state":if blocked {"waiting_accounting"} else {"no_usage_blocker"},
            "reason":if blocked {Some("usage_reconciliation_required")} else {None},
            "recovery":if blocked {Some("blocked_until_trusted_usage_is_reconciled")} else {None},
            "retry_allowed":false,"unresolved_calls":calls,"truncated":truncated}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};
    #[test]
    fn projection_excludes_started_foreign_replaced_and_old_attempt_calls_without_writing() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE work_assignments(id TEXT,run_id TEXT,operation_id TEXT,stage_id TEXT);
            CREATE TABLE operations(id TEXT,body TEXT); CREATE TABLE official_calls(id TEXT,operation_id TEXT,attempt INTEGER,state TEXT,body TEXT);
            CREATE TABLE operation_budget_bindings(operation_id TEXT,attempt INTEGER,reservation_id TEXT); CREATE TABLE budget_reservations(id TEXT,body TEXT);
            INSERT INTO work_assignments VALUES ('current','run','worker','implement'),('replaced','run','old','implement'),('foreign','other','foreign','review');
            INSERT INTO operations VALUES ('worker','{\"attempt\":2}'),('old','{\"attempt\":1}'),('foreign','{\"attempt\":1}'),('coordinator','{\"attempt\":1}');").unwrap();
        let run = json!({"id":"run","home_hub":"home","team_id":"team","revision":4,"stages":[{"assignment_id":"current"}],"coordinator":{"operation_id":"coordinator"}});
        let insert = |id: &str, op: &str, attempt: u64, state: &str| {
            let call = json!({"request":{"call_id":id,"operation_id":op,"attempt":attempt,"epoch":3,"worker_session":"private-worker","provider":"private-provider","model":"private-model"},
                "sequence":1,"state":state,"started_at":1,"last":null,"accounting":null,"metered":null,"accounting_status":"usage_unresolved"});
            db.execute(
                "INSERT INTO official_calls VALUES (?1,?2,?3,?4,?5)",
                params![id, op, attempt, state, call.to_string()],
            )
            .unwrap();
        };
        insert("started", "worker", 2, "started");
        insert("old-attempt", "worker", 1, "finished");
        insert("replaced", "old", 1, "finished");
        insert("foreign", "foreign", 1, "finished");
        assert_eq!(observe(&db, &run, "home").unwrap()["blocked"], false);
        insert("missing", "worker", 2, "finished");
        insert("shared", "coordinator", 1, "uncertain");
        let reservation = json!({"request":{"id":"reserve","budget_ids":["budget"],"amount":10,"unit":"credits","operation_id":"worker"},"revision":1,"charged":2,"held":8,"charge_basis":null,"finalized":false});
        db.execute(
            "INSERT INTO budget_reservations VALUES ('reserve',?1)",
            [reservation.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO operation_budget_bindings VALUES ('worker',2,'reserve')",
            [],
        )
        .unwrap();
        let total_changes = || db.query_row("SELECT total_changes()", [], |row| row.get::<_,u64>(0)).unwrap();
        let before = total_changes();
        let value = observe(&db, &run, "home").unwrap();
        assert_eq!(total_changes(), before);
        assert_eq!(value["state"], "waiting_accounting");
        assert_eq!(value["unresolved_calls"].as_array().unwrap().len(), 2);
        assert_eq!(value["unresolved_calls"][0]["assignment_id"], "current");
        assert_eq!(value["unresolved_calls"][0]["budget"]["held"], 8);
        assert_eq!(value["unresolved_calls"][1]["assignment_id"], Value::Null);
        assert!(!value.to_string().contains("private-"));
        assert!(observe(&db, &run, "foreign").is_err());
        let source = source("r.id", "r.body");
        db.execute_batch("CREATE TABLE work_runs(id TEXT,body TEXT);")
            .unwrap();
        db.execute("INSERT INTO work_runs VALUES ('run',?1)", [run.to_string()])
            .unwrap();
        let count: u64 = db
            .query_row(
                &format!("SELECT COUNT(*) FROM work_runs r WHERE EXISTS({source})"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "discovery uses the same correlated scope as the projection"
        );
        for i in 0..65 {
            insert(&format!("extra-{i:02}"), "worker", 2, "finished");
        }
        let bounded = observe(&db, &run, "home").unwrap();
        assert_eq!(bounded["truncated"], true);
        assert_eq!(bounded["unresolved_calls"].as_array().unwrap().len(), 64);
    }
}
