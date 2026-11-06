//! Bounded read-only audit pages anchored by record membership watermarks.
use super::{
    model::{now, valid_id},
    store::Store,
    trace_redaction::redact,
    work_run_trace_scope as scope,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub view: String,
    pub after: Option<u64>,
    pub through: Option<u64>,
    pub run_revision: Option<u64>,
    pub q: Option<String>,
    pub limit: Option<usize>,
}
impl Store {
    pub fn work_run_trace(&self, id: &str, input: Query) -> Result<Option<Value>> {
        let after = input.after.unwrap_or(0);
        let limit = input.limit.unwrap_or(25);
        let search = input.q.unwrap_or_default();
        if !valid_id(id)
            || after > i64::MAX as u64
            || input.through.is_some_and(|n| n > i64::MAX as u64)
            || !(1..=50).contains(&limit)
            || search.len() > 160
            || search.contains('\0')
        {
            bail!("invalid work run trace query")
        }
        if input.view != "manifest" {
            scope::select(&input.view)?;
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let Some(raw) = tx
            .query_row("SELECT body FROM work_runs WHERE id=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
        else {
            return Ok(None);
        };
        if raw.len() > 4 * 1024 * 1024 {
            bail!("trace context exceeds size bound")
        }
        let mut run: Value = serde_json::from_str(&raw)?;
        if run["id"] != id || run["home_hub"] != self.node_id {
            bail!("work run trace scope changed")
        }
        let revision = run["revision"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("work run trace revision unavailable"))?;
        if input.run_revision.is_some_and(|value| value != revision) {
            bail!("work run changed during trace read")
        }
        let mut result = json!({"schema_version":1,"home_hub":self.node_id,"team_id":run["team_id"],"run_id":id,"run_revision":revision,
            "view":input.view,"query":search,"read_at":now(),"read_only":true,"consistency":"anchored_membership_current_records",
            "redaction_policy":"credential_fields_environments_arguments_v1","archive_payloads_included":false,"cost_attribution":"operation_scoped_shared_coordinator_not_allocated"});
        if input.view == "manifest" {
            if after != 0 || input.through.is_some() || !search.is_empty() {
                bail!("manifest does not accept page or search cursors")
            }
            let mut streams = Vec::new();
            for view in scope::VIEWS {
                let sql = format!(
                    "SELECT COALESCE(MAX(cursor),0),COUNT(*) FROM ({})",
                    scope::select(view)?
                );
                let (through, count): (u64, u64) =
                    tx.query_row(&sql, [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
                streams.push(json!({"view":view,"through":through,"count":count}));
            }
            let call_source = scope::select("model_calls")?;
            let (calls,missing):(u64,u64)=tx.query_row(&format!("SELECT COUNT(*),COALESCE(SUM(CASE WHEN json_type(body,'$.request.prompt_provenance.instruction')='object' THEN 0 ELSE 1 END),0) FROM ({call_source})"),[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
            result["prompt_attestation"] = json!({"calls":calls,"missing":missing,"status":if calls==0 {"not_started"} else if missing==0 {"recorded"} else {"incomplete"}});
            let mut removed = Vec::new();
            redact(&mut run, "$", &mut removed, 0);
            result["context"] = run;
            result["retention"] = json!({"mode":"home_persistent_no_automatic_expiry","owner_deletion_supported":false,"scope":"home_records_and_completed_archives","raw_tool_payloads":"execution_session_only"});
            result["redacted_paths"] = json!(removed);
            result["streams"] = json!(streams);
            return Ok(Some(result));
        }
        let source = scope::select(&input.view)?;
        let maximum: u64 = tx.query_row(
            &format!("SELECT COALESCE(MAX(cursor),0) FROM ({source})"),
            [id],
            |r| r.get(0),
        )?;
        let through = input.through.unwrap_or(maximum);
        if through > maximum || after > through {
            bail!("trace watermark unavailable")
        }
        let sql=format!("SELECT cursor,body,links FROM ({source}) WHERE cursor>?2 AND cursor<=?3 ORDER BY cursor LIMIT 50");
        let mut statement = tx.prepare(&sql)?;
        let mut rows = statement.query(params![id, after, through])?;
        let mut items = Vec::new();
        let mut cursor = after;
        let mut bytes = 0;
        let mut scanned = 0;
        let needle = search.to_lowercase();
        while let Some(row) = rows.next()? {
            let position: u64 = row.get(0)?;
            let raw: String = row.get(1)?;
            let links: Value = serde_json::from_str(&row.get::<_, String>(2)?)?;
            if raw.len() > 4 * 1024 * 1024 {
                bail!("trace record exceeds bounded export size")
            }
            let mut data: Value = serde_json::from_str(&raw)?;
            let mut removed = Vec::new();
            redact(&mut data, "$", &mut removed, 0);
            let matches = needle.is_empty()
                || json!({"data":data,"links":links})
                    .to_string()
                    .to_lowercase()
                    .contains(&needle);
            if matches {
                let item = json!({"cursor":position,"data":data,"links":links,"raw_sha256":format!("{:x}",Sha256::digest(raw.as_bytes())),"raw_bytes":raw.len(),"redacted_paths":removed});
                let size = item.to_string().len();
                if bytes + size > 8 * 1024 * 1024 {
                    break;
                }
                bytes += size;
                items.push(item);
            }
            cursor = position;
            scanned += 1;
            if items.len() == limit {
                break;
            }
        }
        let more: bool = tx.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM ({source}) WHERE cursor>?2 AND cursor<=?3)"),
            params![id, cursor, through],
            |r| r.get(0),
        )?;
        if more && cursor == after {
            bail!("trace page cannot advance within size bound")
        }
        result["items"] = json!(items);
        result["after"] = json!(after);
        result["through"] = json!(through);
        result["scanned_to"] = json!(cursor);
        result["scanned"] = json!(scanned);
        result["next_cursor"] = if more { json!(cursor) } else { Value::Null };
        Ok(Some(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn query(view: &str, after: u64, through: Option<u64>, q: &str) -> Query {
        Query {
            view: view.into(),
            after: Some(after),
            through,
            run_revision: Some(1),
            q: Some(q.into()),
            limit: Some(1),
        }
    }
    fn seed(store: &Store) {
        let run = json!({"id":"run","team_id":"team","home_hub":"home","revision":1,"state":"running","coordinator":{"operation_id":"coordinator","conversation_id":"dm","source_message_id":"human"},"context":{"env":{"PRIVATE":"fixture-sensitive"},"profile_revision":"profile-v1"}});
        let db = store.db.lock();
        db.execute(
            "INSERT INTO work_runs VALUES ('run','team','new','{}',1,'running',?1,?1)",
            [run.to_string()],
        )
        .unwrap();
        for (id, run_id, operation, session) in [
            ("a", "run", "worker-op", "worker"),
            ("b", "other", "foreign-op", "other-worker"),
        ] {
            let assignment =
                json!({"id":id,"run_id":run_id,"worker":{"node_id":"home","session_id":session}});
            db.execute(
                "INSERT INTO work_assignments VALUES (?1,?2,'inspect',1,'team',?3,'prepared',?4)",
                params![id, run_id, operation, assignment.to_string()],
            )
            .unwrap();
        }
        for (operation, session) in [
            ("worker-op", "worker"),
            ("coordinator", "coordinator-worker"),
            ("foreign-op", "other-worker"),
        ] {
            db.execute(
                "INSERT INTO operations VALUES (?1,'owner',?1,'active',NULL,?2)",
                params![
                    operation,
                    json!({"id":operation,"worker":{"node_id":"home","session_id":session}})
                        .to_string()
                ],
            )
            .unwrap();
            db.execute(
                "INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",
                params![
                    operation,
                    json!({"kind":"fixture","operation_id":operation}).to_string()
                ],
            )
            .unwrap();
        }
        for (id, reply) in [
            ("human", None),
            ("answer", Some("human")),
            ("foreign-reply", Some("other-human")),
        ] {
            db.execute("INSERT INTO conversation_messages(id,conversation_id,team_id,actor,request_id,request,body) VALUES (?1,'dm','team',?1,?1,'{}',?2)",params![id,json!({"id":id,"in_reply_to":reply}).to_string()]).unwrap();
        }
        for number in 0..55 {
            let body = if number == 54 {
                json!({"kind":"needle","input_tokens":9,"owner_token":"fixture-sensitive","nested_json":"{\"api_key\":\"fixture-sensitive\"}"})
            } else {
                json!({"kind":"ordinary","number":number})
            };
            db.execute(
                "INSERT INTO work_run_events(run_id,body) VALUES ('run',?1)",
                [body.to_string()],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO operation_events(operation_id,body) VALUES ('worker-op',?1)",
            [
                json!({"kind":"artifact_evidence","evidence":{"payload":{"kind":"artifact"}}})
                    .to_string(),
            ],
        )
        .unwrap();
    }
    #[test]
    fn trace_pages_scope_membership_advance_empty_search_and_hide_sensitive_fields() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("ledger.sqlite"), "home").unwrap();
        seed(&store);
        let manifest = store
            .work_run_trace("run", query("manifest", 0, None, ""))
            .unwrap()
            .unwrap();
        assert_eq!(
            manifest["streams"].as_array().unwrap().len(),
            scope::VIEWS.len()
        );
        assert!(!manifest.to_string().contains("fixture-sensitive"));
        for view in scope::VIEWS {
            assert!(
                store
                    .work_run_trace("run", query(view, 0, None, ""))
                    .is_ok(),
                "{view}"
            );
        }
        let first = store
            .work_run_trace("run", query("work_events", 0, None, "needle"))
            .unwrap()
            .unwrap();
        assert_eq!(first["items"], json!([]));
        assert_eq!(first["scanned_to"], 50);
        assert_eq!(first["next_cursor"], 50);
        let second = store
            .work_run_trace(
                "run",
                query("work_events", 50, first["through"].as_u64(), "needle"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(second["items"][0]["data"]["input_tokens"], 9);
        assert!(second["next_cursor"].is_null());
        assert!(!second.to_string().contains("fixture-sensitive"));
        assert_eq!(second["items"][0]["raw_sha256"].as_str().unwrap().len(), 64);
        let secret_search = store
            .work_run_trace("run", query("work_events", 50, None, "fixture-sensitive"))
            .unwrap()
            .unwrap();
        assert_eq!(secret_search["items"], json!([]));
        let worker = store
            .work_run_trace("run", query("operations", 0, None, ""))
            .unwrap()
            .unwrap();
        assert_eq!(worker["items"][0]["links"]["scope"], "worker_assignment");
        let coordinator = store
            .work_run_trace(
                "run",
                query(
                    "operations",
                    worker["next_cursor"].as_u64().unwrap(),
                    None,
                    "",
                ),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            coordinator["items"][0]["links"]["scope"],
            "shared_coordinator_operation"
        );
        assert!(coordinator["next_cursor"].is_null());
        let archive = store
            .work_run_trace("run", query("archives", 0, None, ""))
            .unwrap()
            .unwrap();
        assert_eq!(
            archive["items"][0]["data"]["availability"],
            "missing_or_pending"
        );
        let conversation = store
            .work_run_trace("run", query("conversation", 0, None, "foreign-reply"))
            .unwrap()
            .unwrap();
        assert_eq!(conversation["items"], json!([]));
        let mut wrong = query("work_events", 0, None, "");
        wrong.run_revision = Some(2);
        assert!(store.work_run_trace("run", wrong).is_err());
        assert!(store
            .work_run_trace("run", query("../../messages", 0, None, ""))
            .is_err());
    }
    #[test]
    fn trace_reply_index_migration_preserves_history_and_uses_participant_indexes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.sqlite");
        let store = Store::open(&path, "home").unwrap();
        seed(&store);
        store
            .db
            .lock()
            .execute_batch("DROP INDEX conversation_reply_trace; PRAGMA user_version=26;")
            .unwrap();
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(
            store
                .db
                .lock()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            29
        );
        let db = store.db.lock();
        for (view, index) in [
            ("conversation", "conversation_reply_trace"),
            ("messages", "message_target"),
            ("communication_events", "lifecycle_message"),
        ] {
            let sql = format!("EXPLAIN QUERY PLAN {}", scope::select(view).unwrap());
            let mut stmt = db.prepare(&sql).unwrap();
            let plan = stmt
                .query_map(["run"], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert!(
                plan.iter().any(|line| line.contains(index)),
                "{view}: {plan:?}"
            );
        }
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM conversation_messages", [], |r| r
                .get::<_, u64>(0))
                .unwrap(),
            3
        );
        drop(db);
        let backup = std::fs::read_dir(root.path())
            .unwrap()
            .map(|p| p.unwrap().path())
            .find(|p| p.to_string_lossy().contains("pre-v26-"))
            .unwrap();
        let original = rusqlite::Connection::open(backup).unwrap();
        assert_eq!(
            original
                .query_row("PRAGMA user_version", [], |r| r.get::<_, u64>(0))
                .unwrap(),
            26
        );
        assert_eq!(
            original
                .query_row("SELECT COUNT(*) FROM conversation_messages", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            3
        );
    }
}
