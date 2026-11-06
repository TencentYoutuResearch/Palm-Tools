//! Cancellation is terminal only with exact drain/accounting, or proven no admission.
use super::{
    budgets::{self, Reservation, Settle},
    model::now,
    operations::{Operation, State},
};
use anyhow::{bail, Result};
use rusqlite::{params, Transaction};
use serde_json::{json, Value};

pub(super) fn finalize(
    tx: &Transaction,
    id: &str,
    run: &mut Value,
    request_id: &str,
    command: &str,
) -> Result<()> {
    finalize_stop(tx, id, run, request_id, command, super::work_run_intervention::Purpose::Cancel)
}

pub(super) fn finalize_stop(
    tx: &Transaction,
    id: &str,
    run: &mut Value,
    request_id: &str,
    command: &str,
    purpose: super::work_run_intervention::Purpose,
) -> Result<()> {
    let stopping = run["state"] == purpose.stopping_state()
        || (purpose == super::work_run_intervention::Purpose::Cancel && run["state"] == "cancel_unconfirmed");
    if !stopping || run[purpose.field()]["request_id"].as_str().is_none()
        || run["completion_authorized"] == true
    {
        bail!("work run cancellation intent required")
    }
    let mut query =
        tx.prepare("SELECT id,body FROM work_assignments WHERE run_id=?1 ORDER BY id")?;
    let rows = query
        .query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let at = now();
    let mut receipts = Vec::new();
    for (assignment_id, body) in rows {
        let mut assignment: Value = serde_json::from_str(&body)?;
        let operation_id = assignment["bundle"]["operation"]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("cancellation operation missing"))?;
        let body: String = tx.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [operation_id],
            |r| r.get(0),
        )?;
        let operation: Operation = serde_json::from_str(&body)?;
        if assignment["bundle"]["operation"]["attempt"] != operation.attempt
            || assignment["worker"] != serde_json::to_value(&operation.worker)?
        {
            bail!("cancellation operation identity changed")
        }
        let body: String = tx.query_row("SELECT r.body FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id WHERE b.operation_id=?1 AND b.attempt=?2", params![operation.id,operation.attempt], |r| r.get(0))?;
        let mut reservation: Reservation = serde_json::from_str(&body)?;
        if assignment["bundle"]["reservation"]["request"]["id"] != reservation.request.id
            || reservation.request.operation_id != operation.id
        {
            bail!("cancellation reservation identity changed")
        }
        let no_admission = assignment["creation"].is_null() && assignment["admission"].is_null();
        let historical = matches!(assignment["state"].as_str(), Some("abandoned" | "completed" | "interrupted"));
        let basis;
        if no_admission && operation.state == State::Stopped {
            let activity: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='command' AND json_extract(body,'$.command.action.kind') IN ('claim','claim_resource')) OR EXISTS(SELECT 1 FROM official_calls WHERE operation_id=?1) OR EXISTS(SELECT 1 FROM metered_usage WHERE reservation_id=?2)", params![operation.id,reservation.request.id], |r| r.get(0))?;
            if activity {
                bail!("cancellation pending: unadmitted Assignment has execution or accounting activity")
            }
            if !reservation.finalized {
                if reservation.revision != 1
                    || reservation.charged != 0
                    || reservation.charge_basis.is_some()
                {
                    bail!("cancellation pending: never-admitted budget requires reconciliation")
                }
                reservation = budgets::settle_in(
                    tx,
                    &reservation.request.id,
                    Settle {
                        event_id: format!("cancel-{assignment_id}"),
                        expected_revision: reservation.revision,
                        total_charge: 0,
                        finalized: true,
                        basis: "manual".into(),
                    },
                    at,
                )?;
            }
            if reservation.charged != 0 || reservation.held != 0 {
                bail!("cancellation pending: never-admitted budget is not zero and final")
            }
            basis = "never_admitted";
        } else {
            let stop = &assignment["stop"]["receipt"];
            if stop["state"] != "execution_drained"
                || stop["operation"]["attempt"] != operation.attempt
                || stop["operation"]["epoch"] != operation.epoch
                || !matches!(operation.state, State::Stopped | State::Reported)
            {
                bail!("cancellation pending: exact execution drain required")
            }
            if !reservation.finalized
                || reservation.held != 0
                || assignment["accounting"]["receipt"]["reservation"]
                    != serde_json::to_value(&reservation)?
            {
                bail!("cancellation pending: exact finalized accounting required")
            }
            let unfinished: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM official_calls WHERE operation_id=?1 AND state!='finished')", [&operation.id], |r| r.get(0))?;
            if unfinished {
                bail!("cancellation pending: unresolved model calls")
            }
            basis = "execution_drained";
        }
        let receipt = json!({"assignment_id":assignment_id,"stop_basis":basis,"reservation":reservation,"completion_authorized":false});
        if !historical {
            assignment["state"] = json!(purpose.assignment_state());
            assignment["revision"] = json!(assignment["revision"].as_u64().unwrap() + 1);
            assignment[purpose.field()] = receipt.clone();
            assignment["dispatch"]["state"] = json!("cancelled");
            if !assignment["resources"].is_null() {
                assignment["resources"]["state"] = json!("released");
            }
            tx.execute(
                "UPDATE work_assignments SET state=?3,body=?2 WHERE id=?1",
                params![assignment_id, assignment.to_string(), purpose.assignment_state()],
            )?;
        }
        tx.execute(
            "UPDATE assignment_resource_holds SET state='released' WHERE assignment_id=?1",
            [&assignment_id],
        )?;
        tx.execute(
            "UPDATE work_dispatch_outbox SET state='cancelled' WHERE assignment_id=?1",
            [&assignment_id],
        )?;
        receipts.push(receipt);
    }
    run["revision"] = json!(run["revision"].as_u64().unwrap() + 1);
    run["state"] = json!(purpose.stopped_state());
    run["waiting_reason"] = Value::Null;
    run["updated_at"] = json!(at);
    if purpose == super::work_run_intervention::Purpose::Cancel {
        for stage in run["stages"].as_array_mut()
            .ok_or_else(|| anyhow::anyhow!("cancellation stages missing"))? {
            if stage["state"] != "passed" {
                stage["state"] = json!("cancelled");
            }
        }
    }
    run[purpose.field()]["stop_confirmed"] = json!(true);
    run[purpose.field()]["resources_released"] = json!(true);
    run[purpose.field()]["accounting"] = json!("finalized");
    run[purpose.field()]["receipt"] = json!({"request_id":request_id,"at":at,"assignments":receipts,"completion_authorized":false,"external_effects":"not_attested"});
    let result = run.to_string();
    tx.execute(
        "UPDATE work_runs SET revision=?2,state=?4,body=?3 WHERE id=?1",
        params![id, run["revision"].as_u64(), result, purpose.stopped_state()],
    )?;
    tx.execute(
        "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
        params![id, request_id, command, result],
    )?;
    tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)", params![id,json!({"kind":purpose.stopped_event(),"request_id":request_id,"revision":run["revision"],"actor":{"kind":"system","id":purpose.reconciler()},"at":at,"stop_basis":"verified_assignments",(purpose.field()):run[purpose.field()]}).to_string()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{model::Address, operations, store::Store, work_runs::Command};
    #[test]
    fn unresolved_branch_rolls_back_other_branch_budget_and_finalization() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        store
            .configure_budget(
                budgets::Configure {
                    id: "budget".into(),
                    scope: budgets::Scope::Team,
                    scope_id: "team".into(),
                    unit: "credits".into(),
                    limit: 100,
                    starts_at: 1,
                    ends_at: now() + 60000,
                    expected_revision: 0,
                },
                100,
            )
            .unwrap();
        let run = json!({"id":"run","owner":"owner","revision":1,"state":"cancelling","completion_authorized":false,"stages":[],"cancellation":{"request_id":"stop"}});
        store
            .db
            .lock()
            .execute(
                "INSERT INTO work_runs VALUES ('run','team','new','{}',1,'cancelling',?1,?1)",
                [run.to_string()],
            )
            .unwrap();
        let mut second = Value::Null;
        let mut second_op = None;
        for id in ["a", "b"] {
            let mut op = store
                .prepare_operation(
                    "owner",
                    id,
                    Address {
                        node_id: "home".into(),
                        session_id: id.into(),
                    },
                )
                .unwrap();
            op.state = State::Stopped;
            let reservation = store
                .reserve_budget(
                    budgets::Reserve {
                        id: id.into(),
                        budget_ids: vec!["budget".into()],
                        amount: 10,
                        unit: "credits".into(),
                        operation_id: op.id.clone(),
                    },
                    100,
                )
                .unwrap();
            let assignment = json!({"id":id,"revision":1,"state":"prepared","worker":op.worker,"bundle":{"operation":op,"reservation":reservation},"dispatch":{"state":"blocked"},"creation":if id=="b" { json!({"state":"created"}) } else {Value::Null},"admission":if id=="b" { json!({}) } else {Value::Null}});
            let mut db = store.db.lock();
            let tx = db.transaction().unwrap();
            operations::save(&tx, &op, json!({"kind":"fixture"})).unwrap();
            tx.execute(
                "INSERT INTO operation_budget_bindings VALUES (?1,1,?2)",
                params![op.id, id],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO work_assignments VALUES (?1,'run',?1,1,'team',?2,'prepared',?3)",
                params![id, op.id, assignment.to_string()],
            )
            .unwrap();
            tx.commit().unwrap();
            if id == "b" {
                second = assignment;
                second_op = Some(op);
            }
        }
        let command = || Command::FinalizeCancel {
            request_id: "finish".into(),
            expected_revision: 1,
        };
        assert!(store
            .command_work_run("run", command())
            .unwrap_err()
            .to_string()
            .contains("exact execution drain"));
        assert_eq!(store.budget("budget").unwrap()["budget"]["reserved"], 20);
        assert_eq!(
            store.work_assignment("a").unwrap().unwrap()["state"],
            "prepared"
        );
        second["stop"] =
            json!({"receipt":{"state":"execution_drained","operation":second_op.unwrap()}});
        store
            .db
            .lock()
            .execute(
                "UPDATE work_assignments SET body=?1 WHERE id='b'",
                [second.to_string()],
            )
            .unwrap();
        assert!(store
            .command_work_run("run", command())
            .unwrap_err()
            .to_string()
            .contains("finalized accounting"));
        assert_eq!(store.budget("budget").unwrap()["budget"]["reserved"], 20);
        let settled = store
            .settle_budget(
                "b",
                Settle {
                    event_id: "observed".into(),
                    expected_revision: 1,
                    total_charge: 3,
                    finalized: true,
                    basis: "manual".into(),
                },
                100,
            )
            .unwrap();
        second["accounting"] = json!({"receipt":{"reservation":settled}});
        store
            .db
            .lock()
            .execute(
                "UPDATE work_assignments SET body=?1 WHERE id='b'",
                [second.to_string()],
            )
            .unwrap();
        let result = store.command_work_run("run", command()).unwrap();
        assert_eq!(result["state"], "cancelled");
        assert_eq!(store.work_run_events("run", 0).unwrap()["events"].as_array().unwrap().last().unwrap()["data"]["actor"],
            json!({"kind":"system","id":"cancellation_reconciler"}));
        assert_eq!(result["completion_authorized"], false);
        assert_eq!(store.budget("budget").unwrap()["budget"]["reserved"], 0);
        assert_eq!(store.budget("budget").unwrap()["budget"]["spent"], 3);
        assert_eq!(store.command_work_run("run", command()).unwrap(), result);
    }
}
