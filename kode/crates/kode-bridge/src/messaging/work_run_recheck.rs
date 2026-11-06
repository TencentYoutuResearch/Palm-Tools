//! Owner intent to recheck the same frozen work; never attest execution or stop.
use super::model::now;
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
    if !matches!(
        run["state"].as_str(),
        Some("queued" | "running" | "waiting_resource")
    ) || run["completion_authorized"] != false
        || !run["cancellation"].is_null()
    {
        bail!("work run cannot recheck execution in this state")
    }
    let previous = run["revision"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("work run revision missing"))?;
    let revision = previous + 1;
    let at = now();
    let intent = json!({"request_id":request_id,"expected_revision":previous,"reason":reason,
        "state":"requested","actor":{"kind":"human","id":"local_owner"},"at":at});
    run["revision"] = json!(revision);
    run["updated_at"] = json!(at);
    run["execution_recheck"] = intent.clone();
    let result = serde_json::to_string(run)?;
    tx.execute(
        "UPDATE work_runs SET revision=?2,body=?3 WHERE id=?1",
        params![id, revision, result],
    )?;
    tx.execute(
        "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
        params![id, request_id, command, result],
    )?;
    tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)", params![id,
        serde_json::to_string(&json!({"kind":"execution_recheck_requested","request_id":request_id,
            "revision":revision,"at":at,"actor":{"kind":"human","id":"local_owner"},"recheck":intent}))?])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::{store::Store, work_runs::Command};

    fn command(request_id: &str, revision: u64) -> Command {
        Command::RecheckExecution {
            request_id: request_id.into(),
            expected_revision: revision,
            reason: "Check current execution conditions".into(),
        }
    }

    #[test]
    fn recheck_is_one_durable_intent_without_replacing_work_or_attesting_stop() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let run = json!({"id":"run","team_id":"team","home_hub":"home","revision":1,"state":"running",
            "completion_authorized":false,"context":{"hash":"frozen"},"stages":[{"assignment_id":"same-assignment","state":"running","attempt":1}],"cancellation":null});
        store
            .db
            .lock()
            .execute(
                "INSERT INTO work_runs VALUES ('run','team','new','{}',1,'running',?1,?1)",
                [run.to_string()],
            )
            .unwrap();
        let absent = store
            .work_run_command_receipt("run", "recheck")
            .unwrap()
            .unwrap();
        assert!(absent["receipt"].is_null());
        assert_eq!(absent["run_revision"], 1);
        let receipt = store
            .command_work_run("run", command("recheck", 1))
            .unwrap();
        assert_eq!(receipt["revision"], 2);
        let proof = store
            .work_run_command_receipt("run", "recheck")
            .unwrap()
            .unwrap();
        assert_eq!(proof["receipt"]["result"], receipt);
        assert_eq!(proof["run_revision"], 2);
        let missing = store
            .work_run_command_receipt("run", "unsubmitted")
            .unwrap()
            .unwrap();
        assert!(missing["receipt"].is_null());
        assert_eq!(missing["run_revision"], 2);
        assert!(store
            .command_work_run("run", command("unsubmitted", 1))
            .is_err());
        for field in [
            "context",
            "stages",
            "state",
            "completion_authorized",
            "cancellation",
        ] {
            assert_eq!(receipt[field], run[field]);
        }
        assert_eq!(receipt["execution_recheck"]["state"], "requested");
        assert_eq!(
            store
                .command_work_run("run", command("recheck", 1))
                .unwrap(),
            receipt
        );
        assert!(store
            .command_work_run("run", command("another", 1))
            .is_err());
        assert!(store
            .command_work_run("run", command("recheck", 2))
            .is_err());
        let events = store.work_run_events("run", 0).unwrap();
        assert_eq!(events["events"].as_array().unwrap().len(), 1);
        assert_eq!(
            events["events"][0]["data"]["kind"],
            "execution_recheck_requested"
        );
        drop(store);
        let reopened = Store::open(&path, "home").unwrap();
        assert_eq!(
            reopened
                .command_work_run("run", command("recheck", 1))
                .unwrap(),
            receipt
        );
    }

    #[test]
    fn recheck_cannot_bypass_human_decisions_cancellation_or_delivery() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        for state in [
            "waiting_user",
            "cancelling",
            "cancel_unconfirmed",
            "completed",
            "failed",
            "cancelled",
        ] {
            let run = json!({"id":"run","revision":1,"state":state,"completion_authorized":false});
            store
                .db
                .lock()
                .execute(
                    "INSERT OR REPLACE INTO work_runs VALUES ('run','team','new','{}',1,?1,?2,?2)",
                    params![state, run.to_string()],
                )
                .unwrap();
            assert!(
                store
                    .command_work_run("run", command("recheck", 1))
                    .is_err(),
                "{state}"
            );
            assert_eq!(store.work_run("run").unwrap().unwrap(), run);
        }
        for change in [
            json!({"completion_authorized":true}),
            json!({"cancellation":{"stop_confirmed":false}}),
        ] {
            let mut run =
                json!({"id":"run","revision":1,"state":"running","completion_authorized":false});
            for (key, value) in change.as_object().unwrap() {
                run[key] = value.clone();
            }
            store.db.lock().execute("INSERT OR REPLACE INTO work_runs VALUES ('run','team','new','{}',1,'running',?1,?1)", [run.to_string()]).unwrap();
            assert!(store
                .command_work_run("run", command("recheck", 1))
                .is_err());
        }
    }
}
