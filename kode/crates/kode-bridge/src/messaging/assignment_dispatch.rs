//! Durable Host creation receipts. Acknowledgement is historical, never workflow completion.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pending {
    pub host: String,
    pub after: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CreationState {
    Created,
    Uncertain,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: String,
    pub command: Value,
    pub state: CreationState,
}
impl Store {
    pub fn pending_assignment_dispatches(&self, input: Pending) -> Result<Value> {
        if !valid_id(&input.host) || input.after.as_ref().is_some_and(|id| !valid_id(id)) {
            bail!("invalid dispatch cursor")
        }
        let db = self.db.lock();
        let mut query=db.prepare("SELECT a.id,a.body FROM work_assignments a JOIN work_dispatch_outbox o ON a.id=o.assignment_id WHERE a.id>?1 AND a.state='prepared' AND json_extract(a.body,'$.worker.node_id')=?2 AND o.state IN ('blocked','ready','uncertain') ORDER BY a.id LIMIT 64")?;
        let rows = query
            .query_map(
                params![input.after.unwrap_or_default(), input.host],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let next = if rows.len() == 64 {
            rows.last().map(|r| r.0.clone())
        } else {
            None
        };
        let items = rows
            .into_iter()
            .map(|(_, body)| serde_json::from_str::<Value>(&body))
            .collect::<serde_json::Result<Vec<_>>>()?;
        Ok(json!({"items":items,"next_cursor":next}))
    }
    pub fn assignment_creation_receipt(&self, id: &str, input: Receipt) -> Result<Value> {
        self.assignment_creation_receipt_from(&self.node_id, id, input)
    }
    pub(super) fn assignment_creation_receipt_from(
        &self,
        executor: &str,
        id: &str,
        input: Receipt,
    ) -> Result<Value> {
        if !valid_id(executor)
            || !valid_id(id)
            || !valid_id(&input.request_id)
            || serde_json::to_vec(&input)?.len() > 65536
        {
            bail!("invalid dispatch receipt")
        }
        let key = format!("assignment-creation:{id}:{}", input.request_id);
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let mut assignment: Value = serde_json::from_str(&body)?;
        if assignment["worker"]["node_id"] != executor {
            bail!("foreign Assignment creation Host")
        }
        let previous: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(body) = previous {
            let old: Value = serde_json::from_str(&body)?;
            if old["request"] != request {
                bail!("dispatch receipt identity conflict")
            }
            return Ok(old["result"].clone());
        }
        if assignment["dispatch"]["command"] != input.command {
            bail!("dispatch receipt command mismatch")
        }
        if assignment["creation"]["state"] == "created" && input.state != CreationState::Created {
            bail!("cannot downgrade acknowledged creation")
        }
        if input.state == CreationState::Created {
            if assignment["state"] != "prepared" || assignment["admission"].is_null() {
                bail!("creation has no Host admission")
            }
            let claimed: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='command' AND json_extract(body,'$.command.action.kind') IN ('claim','claim_resource') AND json_extract(body,'$.command.attempt')=?2 AND json_extract(body,'$.command.epoch')=?3)",
                params![assignment["bundle"]["operation"]["id"].as_str(), input.command["operation"]["attempt"].as_u64(), input.command["operation"]["epoch"].as_u64()],
                |r| r.get(0),
            )?;
            if !claimed {
                bail!("creation has no claimed operation")
            }
        }
        let at = now();
        let result = json!({"assignment_id":id,"command_id":input.command["command_id"],"session_id":input.command["session_id"],"state":input.state,"at":at,"historical":true,"completion_authorized":false});
        assignment["creation"] = result.clone();
        assignment["revision"] = json!(assignment["revision"].as_u64().unwrap() + 1);
        tx.execute(
            "UPDATE work_assignments SET body=?2 WHERE id=?1",
            params![id, serde_json::to_string(&assignment)?],
        )?;
        if assignment["state"] != "abandoned" {
            tx.execute(
                "UPDATE work_dispatch_outbox SET state=?2 WHERE assignment_id=?1",
                params![
                    id,
                    if input.state == CreationState::Created {
                        "created"
                    } else {
                        "uncertain"
                    }
                ],
            )?;
        }
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key,
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![assignment["run_id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_creation_receipt","at":at,"actor":{"kind":"host","id":executor},"result":result}))?])?;
        tx.commit()?;
        Ok(result)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemotePending {
    pub after: Option<String>,
}
impl Store {
    pub(super) fn remote_assignment_catalog(
        &self,
        executor: &str,
        after: Option<String>,
    ) -> Result<Value> {
        if !valid_id(executor) || after.as_ref().is_some_and(|id| !valid_id(id)) {
            bail!("invalid remote Assignment catalog cursor")
        }
        let db = self.db.lock();
        let mut query = db.prepare("SELECT a.id,a.body FROM work_assignments a JOIN work_dispatch_outbox o ON a.id=o.assignment_id WHERE a.id>?1 AND a.state='prepared' AND json_extract(a.body,'$.worker.node_id')=?2 AND (json_extract(a.body,'$.resources.state')='held' OR (json_extract(a.body,'$.resources') IS NULL AND json_extract(a.body,'$.creation') IS NULL AND (EXISTS(SELECT 1 FROM json_each(a.body,'$.inputs.binding.sources')) OR EXISTS(SELECT 1 FROM json_each(a.body,'$.candidate.grant_scope.capabilities') WHERE value='workspace_write')))) AND o.state IN ('blocked','ready','uncertain') ORDER BY a.id LIMIT 64")?;
        let rows = query
            .query_map(params![after.unwrap_or_default(), executor], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let next = if rows.len() == 64 {
            rows.last().map(|r| r.0.clone())
        } else {
            None
        };
        let items = rows.iter().map(|(id,body)| -> Result<Value> {
            let row: Value = serde_json::from_str(body)?;
            Ok(json!({"assignment_id":id,"worker_session":row["worker"]["session_id"],"operation":row["dispatch"]["command"]["operation"]}))
        }).collect::<Result<Vec<_>>>()?;
        let result = json!({"home_hub":self.node_id,"execution_host":executor,"items":items,"next_cursor":next});
        if serde_json::to_vec(&result)?.len() > 65536 {
            bail!("remote Assignment catalog exceeds transport limit")
        }
        Ok(result)
    }
}

#[cfg(test)]
mod task_catalog_tests {
    use super::*;
    #[test]
    fn task_worktree_remote_catalog_discovers_unprovisioned_write_before_home_resources() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        let rows = [
            ("a-write", "worker", true, false, false, false),
            ("b-read", "worker", false, false, false, false),
            ("c-snapshot", "worker", false, true, false, false),
            ("d-held", "worker", false, false, true, false),
            ("e-foreign", "another-host", true, false, false, false),
            ("f-created", "worker", true, false, false, true),
        ];
        for (id, host, write, source, held, created) in rows {
            let body = json!({"id":id,"worker":{"node_id":host,"session_id":format!("worker-{id}")},
                "candidate":{"grant_scope":{"capabilities":if write {vec!["read","workspace_write"]} else {vec!["read"]}}},
                "inputs":{"binding":{"sources":if source {json!({"upstream":{}})} else {json!({})}}},
                "resources":if held {json!({"state":"held"})} else {Value::Null},
                "creation":if created {json!({"state":"created"})} else {Value::Null},
                "dispatch":{"command":{"operation":{"id":id,"attempt":1,"epoch":1,"home_node":"home"}}}});
            let db = store.db.lock();
            db.execute("INSERT INTO work_assignments(id,run_id,stage_id,stage_attempt,team_id,operation_id,state,body) VALUES (?1,?1,'stage',1,'team',?1,'prepared',?2)",params![id,body.to_string()]).unwrap();
            db.execute("INSERT INTO work_dispatch_outbox VALUES (?1,'blocked','{}')",[id]).unwrap();
        }
        let page = store.remote_assignment_catalog("worker", None).unwrap();
        let ids: Vec<_> = page["items"].as_array().unwrap().iter().map(|item| item["assignment_id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a-write", "c-snapshot", "d-held"]);
        assert_eq!(page["home_hub"], "home");
        assert_eq!(page["execution_host"], "worker");
        assert!(page["next_cursor"].is_null());
        let next = store.remote_assignment_catalog("worker", Some("a-write".into())).unwrap();
        assert_eq!(next["items"][0]["assignment_id"], "c-snapshot");
        let unchanged = store.work_assignment("a-write").unwrap().unwrap();
        assert!(unchanged["resources"].is_null());
        assert!(unchanged["execution_workspace"].is_null());
    }
}
