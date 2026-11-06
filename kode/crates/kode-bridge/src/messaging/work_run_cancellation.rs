//! Atomic home cancellation intent and execution fencing; never attest remote drain.
use super::{
    model::now,
    operations::{self, Operation, State},
};
use anyhow::{bail, Result};
use rusqlite::{params, Transaction};
use serde_json::{json, Value};

pub(super) fn request(
    tx: &Transaction,
    id: &str,
    run: &mut Value,
    request_id: &str,
    reason: &str,
    command: &str,
) -> Result<()> {
    request_stop(tx, id, run, request_id, reason, command, super::work_run_intervention::Purpose::Cancel)
}

pub(super) fn request_stop(
    tx: &Transaction,
    id: &str,
    run: &mut Value,
    request_id: &str,
    reason: &str,
    command: &str,
    purpose: super::work_run_intervention::Purpose,
) -> Result<()> {
    if !matches!(
        run["state"].as_str(),
        Some("waiting_user" | "waiting_resource" | "queued" | "running" | "paused")
    ) || run["completion_authorized"] == true
        || !run["cancellation"].is_null()
        || (purpose == super::work_run_intervention::Purpose::Takeover && run["state"] == "paused")
    {
        bail!("work run cannot request cancellation in this state")
    }
    let mut query = tx.prepare("SELECT id,body FROM work_assignments WHERE run_id=?1 AND state NOT IN ('abandoned','completed','interrupted') ORDER BY id")?;
    let rows = query
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let at = now();
    let mut assignments = Vec::new();
    for (assignment_id, body) in rows {
        let assignment: Value = serde_json::from_str(&body)?;
        let operation_id = assignment["bundle"]["operation"]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("cancellation operation identity missing"))?;
        let body: String = tx.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [operation_id],
            |r| r.get(0),
        )?;
        let mut operation: Operation = serde_json::from_str(&body)?;
        if assignment["bundle"]["operation"]["attempt"] != operation.attempt
            || assignment["worker"] != serde_json::to_value(&operation.worker)?
        {
            bail!("cancellation Assignment operation changed")
        }
        if matches!(
            operation.state,
            State::Prepared | State::Active | State::Uncertain
        ) {
            operation.state = if operation.state == State::Prepared {
                State::Stopped
            } else {
                State::Cancelling
            };
            operation.epoch += 1;
            operation.revision += 1;
            operation.lease_until = None;
            operations::save(
                tx,
                &operation,
                json!({"kind":purpose.request_event(), "run_id":id,
                "assignment_id":assignment_id,"request_id":request_id,"actor":{"kind":"human","id":"local_owner"},"at":at,"operation":operation}),
            )?;
        }
        assignments.push(assignment_id);
    }
    run["revision"] = json!(run["revision"].as_u64().unwrap() + 1);
    run["updated_at"] = json!(at);
    run[purpose.field()] = json!({"request_id":request_id,"reason":reason,"requested_at":at,"actor":{"kind":"human","id":"local_owner"},
        "previous_state":run["state"],"assignment_ids":assignments,"stop_confirmed":false,
        "resources_released":false,"accounting":"pending"});
    run["state"] = json!(purpose.stopping_state());
    run["waiting_reason"] = json!("execution_stop_confirmation_required");
    let result = serde_json::to_string(run)?;
    tx.execute(
        "UPDATE work_runs SET revision=?2,state=?4,body=?3 WHERE id=?1",
        params![id, run["revision"].as_u64(), result, purpose.stopping_state()],
    )?;
    tx.execute(
        "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
        params![id, request_id, command, result],
    )?;
    tx.execute(
        "INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",
        params![
            id,
            serde_json::to_string(&json!({
        "kind":purpose.request_event(),"request_id":request_id,"revision":run["revision"],
        "actor":{"kind":"human","id":"local_owner"},"at":at,(purpose.field()):run[purpose.field()]}))?
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{model::Address, store::Store, work_runs::Command};

    #[test]
    fn cancellation_fences_all_branches_atomically_without_claiming_drain() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        let run = json!({"id":"run","owner":{"kind":"superagent","id":"coordinator"},"revision":1,"state":"running","completion_authorized":false});
        store
            .db
            .lock()
            .execute(
                "INSERT INTO work_runs VALUES ('run','team','new','{}',1,'running',?1,?1)",
                [run.to_string()],
            )
            .unwrap();
        let states = [
            State::Active,
            State::Uncertain,
            State::Prepared,
            State::Reported,
        ];
        let mut operations = Vec::new();
        for (i, state) in states.into_iter().enumerate() {
            let key = format!("branch{i}");
            let mut op = store
                .prepare_operation(
                    "owner",
                    &key,
                    Address {
                        node_id: "remote".into(),
                        session_id: key.clone(),
                    },
                )
                .unwrap();
            op.state = state;
            op.lease_until = Some(now() + 60000);
            let assignment = json!({"worker":op.worker,"bundle":{"operation":{"id":op.id,"attempt": if i == 3 { 999 } else { op.attempt }}}});
            let mut db = store.db.lock();
            let tx = db.transaction().unwrap();
            operations::save(&tx, &op, json!({"kind":"fixture"})).unwrap();
            tx.execute(
                "INSERT INTO work_assignments VALUES (?1,'run',?1,1,'team',?2,'prepared',?3)",
                params![key, op.id, assignment.to_string()],
            )
            .unwrap();
            tx.commit().unwrap();
            operations.push(op);
        }
        let command = || Command::RequestCancel {
            request_id: "stop".into(),
            expected_revision: 1,
            reason: "User request".into(),
        };
        assert!(store
            .command_work_run("run", command())
            .unwrap_err()
            .to_string()
            .contains("operation changed"));
        assert_eq!(store.work_run("run").unwrap().unwrap(), run);
        for op in &operations {
            let saved = store.operation(&op.id).unwrap().unwrap();
            assert_eq!(saved.epoch, op.epoch);
            assert_eq!(saved.state, op.state);
        }
        store.db.lock().execute("UPDATE work_assignments SET body=json_set(body,'$.bundle.operation.attempt',1) WHERE id='branch3'", []).unwrap();
        let cancelled = store.command_work_run("run", command()).unwrap();
        assert_eq!(cancelled["state"], "cancelling");
        assert_eq!(cancelled["owner"], run["owner"]);
        let human = json!({"kind":"human","id":"local_owner"});
        assert_eq!(cancelled["cancellation"]["actor"], human);
        assert_eq!(store.work_run_events("run", 0).unwrap()["events"][0]["data"]["actor"], human);
        assert_eq!(cancelled["cancellation"]["stop_confirmed"], false);
        assert_eq!(cancelled["cancellation"]["resources_released"], false);
        for (i, original) in operations.iter().enumerate() {
            let op = store.operation(&original.id).unwrap().unwrap();
            assert_eq!(
                op.state,
                if i < 2 {
                    State::Cancelling
                } else if i == 2 {
                    State::Stopped
                } else {
                    State::Reported
                }
            );
            assert_eq!(op.epoch, original.epoch + u64::from(i < 3));
            if i < 3 {
                assert_eq!(store.operation_events(&original.id, 0).unwrap().last().unwrap()["data"]["actor"], human);
                assert_eq!(op.lease_until, None);
            }
        }
        assert_eq!(store.command_work_run("run", command()).unwrap(), cancelled);
        assert_eq!(
            store.work_run_events("run", 0).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
