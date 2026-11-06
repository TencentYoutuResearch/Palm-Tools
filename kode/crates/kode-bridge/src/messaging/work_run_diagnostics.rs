//! Home-owned session/operation metadata. Reading this projection has no execution effects.
use super::{
    model::{now, valid_id},
    operations::Operation,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub run_revision: u64,
    pub after: Option<String>,
}

impl Store {
    pub fn work_run_diagnostics(&self, id: &str, input: Query) -> Result<Option<Value>> {
        let after = input.after.unwrap_or_default();
        if !valid_id(id)
            || input.run_revision == 0
            || input.run_revision > i64::MAX as u64
            || (!after.is_empty() && !valid_id(&after))
        {
            bail!("invalid session diagnostic scope")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let Some(body) = tx
            .query_row("SELECT body FROM work_runs WHERE id=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
        else {
            return Ok(None);
        };
        if body.len() > 4 * 1024 * 1024 {
            bail!("session diagnostic context exceeds bound")
        }
        let run: Value = serde_json::from_str(&body)?;
        if run["id"] != id
            || run["home_hub"] != self.node_id
            || run["revision"] != input.run_revision
        {
            bail!("session diagnostic run changed")
        }
        let mut query = tx.prepare(
            "SELECT id,body FROM work_assignments WHERE run_id=?1 AND id>?2 ORDER BY id LIMIT 26",
        )?;
        let rows = query
            .query_map(params![id, after], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = rows.len() > 25;
        let mut items = Vec::new();
        for (assignment_id, body) in rows.into_iter().take(25) {
            if body.len() > 4 * 1024 * 1024 {
                bail!("session diagnostic record exceeds bound")
            }
            let assignment: Value = serde_json::from_str(&body)?;
            if assignment["id"] != assignment_id
                || assignment["run_id"] != id
                || assignment["team_id"] != run["team_id"]
            {
                bail!("session diagnostic assignment scope changed")
            }
            let operation_id = assignment["bundle"]["operation"]["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("session diagnostic operation missing"))?;
            let raw: String = tx.query_row(
                "SELECT body FROM operations WHERE id=?1",
                [operation_id],
                |row| row.get(0),
            )?;
            let operation: Operation = serde_json::from_str(&raw)?;
            if assignment["worker"] != serde_json::to_value(&operation.worker)?
                || assignment["bundle"]["operation"]["attempt"] != operation.attempt
            {
                bail!("session diagnostic execution identity changed")
            }
            let held:u64=tx.query_row("SELECT COUNT(*) FROM assignment_resource_holds WHERE assignment_id=?1 AND state='held'",[&assignment_id],|row|row.get(0))?;
            let current = run["stages"].as_array().is_some_and(|stages| {
                stages.iter().any(|stage| {
                    stage["assignment_id"] == assignment_id
                        && stage["attempt"] == assignment["stage_attempt"]
                })
            });
            items.push(json!({"assignment_id":assignment_id,"stage_id":assignment["stage_id"],"stage_attempt":assignment["stage_attempt"],
                "current_stage_attempt":current,"assignment_state":assignment["state"],"worker":operation.worker,
                "operation":{"id":operation.id,"state":operation.state,"attempt":operation.attempt,"epoch":operation.epoch,
                    "revision":operation.revision,"lease_until":operation.lease_until},
                "creation_state":assignment["creation"]["state"],"admitted":!assignment["admission"].is_null(),
                "stop_state":assignment["stop"]["receipt"]["state"],"accounting_confirmed":!assignment["accounting"]["receipt"].is_null(),
                "held_resources":held,"runtime_liveness":"not_probed","session_access":"read_only"}));
        }
        let next = if more {
            items.last().map(|item| item["assignment_id"].clone())
        } else {
            None
        };
        Ok(Some(
            json!({"schema_version":1,"home_hub":self.node_id,"team_id":run["team_id"],"run_id":id,
            "run_revision":input.run_revision,"run_state":run["state"],"observed_at":now(),"read_only":true,
            "scope":"home_durable_assignment_metadata","items":items,"next_cursor":next,
            "limitations":["runtime_liveness_not_probed","remote_session_history_not_read","stop_requires_authenticated_receipt"]}),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::model::Address;
    #[test]
    fn diagnostic_pages_are_scoped_bounded_read_only_metadata_and_survive_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let run = json!({"id":"run","team_id":"team","home_hub":"home","revision":4,"state":"taking_over",
            "stages":[{"stage_id":"implementation","attempt":1,"assignment_id":"a00"}]});
        store
            .db
            .lock()
            .execute(
                "INSERT INTO work_runs VALUES ('run','team','create','{}',4,'taking_over',?1,?1)",
                [run.to_string()],
            )
            .unwrap();
        for index in 0..26 {
            let id = format!("a{index:02}");
            let op = store
                .prepare_operation(
                    "owner",
                    &id,
                    Address {
                        node_id: "remote".into(),
                        session_id: format!("worker{index}"),
                    },
                )
                .unwrap();
            let assignment = json!({"id":id,"run_id":"run","team_id":"team","worker":op.worker,"bundle":{"operation":op},
                "state":"prepared","stage_id":"implementation","stage_attempt":index+1,"untrusted_content":"private-fixture-payload"});
            store.db.lock().execute("INSERT INTO work_assignments VALUES (?1,'run','implementation',?4,'team',?2,'prepared',?3)",params![id,op.id,assignment.to_string(),index+1]).unwrap();
        }
        let read = |after| {
            store
                .work_run_diagnostics(
                    "run",
                    Query {
                        run_revision: 4,
                        after,
                    },
                )
                .unwrap()
                .unwrap()
        };
        let first = read(None);
        assert_eq!(first["items"].as_array().unwrap().len(), 25);
        assert_eq!(first["next_cursor"], "a24");
        assert_eq!(first["items"][0]["current_stage_attempt"], true);
        assert_eq!(first["items"][1]["current_stage_attempt"], false);
        assert_eq!(first["items"][0]["runtime_liveness"], "not_probed");
        assert_eq!(first["items"][0]["session_access"], "read_only");
        assert!(!first.to_string().contains("private-fixture-payload"));
        assert_eq!(
            read(Some("a24".into()))["items"].as_array().unwrap().len(),
            1
        );
        assert_eq!(store.work_run("run").unwrap().unwrap(), run);
        assert!(store
            .work_run_diagnostics(
                "run",
                Query {
                    run_revision: 3,
                    after: None
                }
            )
            .is_err());
        assert!(store
            .work_run_diagnostics(
                "run",
                Query {
                    run_revision: 4,
                    after: Some("../outside".into())
                }
            )
            .is_err());
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        let again = store
            .work_run_diagnostics(
                "run",
                Query {
                    run_revision: 4,
                    after: None,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(again["items"], first["items"]);
        assert_eq!(
            store.work_run_events("run", 0).unwrap()["events"],
            json!([])
        );
    }
}
