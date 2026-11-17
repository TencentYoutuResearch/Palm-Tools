//! Durable terminal and blocked WorkRun notices reuse the inbox; discovery survives Host downtime.
use super::{
    builder_authority, coordinator_control, model::*, operations::State, store::Store,
    work_runs::ActiveQuery,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Queue {
    pub expected_revision: u64,
}
fn key(run: &str, revision: u64) -> String {
    format!("coordinator-update:{}", json!([run, revision]))
}
pub(super) fn read(db: &Connection, run: &str, revision: u64) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(run, revision)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
// A stage stays `ready` until its evidence is completed. Assignment receipts and a
// current Worker lease, rather than that coarse run label, prove execution began.
fn has_only_live_assigned_workers(db: &Connection, run: &Value, at: u64) -> Result<bool> {
    let mut seen = false;
    for stage in run["stages"].as_array().into_iter().flatten() {
        if matches!(stage["state"].as_str(), Some("passed" | "waived")) { continue; }
        let Some(id) = stage["assignment_id"].as_str() else { continue };
        seen = true;
        let row: Option<(String, String, Option<String>)> = db.query_row(
            "SELECT a.body,o.body,h.state FROM work_assignments a JOIN operations o ON o.id=a.operation_id LEFT JOIN assignment_resource_holds h ON h.assignment_id=a.id WHERE a.id=?1 AND a.run_id=?2",
            params![id, run["id"].as_str()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional()?;
        let Some((assignment, operation, hold)) = row else { return Ok(false) };
        let a: Value = serde_json::from_str(&assignment)?;
        let op: Value = serde_json::from_str(&operation)?;
        let command = &a["dispatch"]["command"]["operation"];
        if a["run_id"] != run["id"] || a["team_id"] != run["team_id"]
            || a["stage_id"] != stage["stage_id"] || a["stage_attempt"] != stage["attempt"]
            || a["state"] != "prepared" || a["resources"]["state"] != "held" || hold.as_deref() != Some("held")
            || a["creation"]["state"] != "created" || a["creation"]["session_id"] != a["worker"]["session_id"]
            || !matches!(a["admission"]["kind"].as_str(),Some("official_local_host" | "official_remote_host"))
            || a["mandate"]["receipt"]["message_id"].as_str().is_none_or(str::is_empty)
            || op["state"] != "active" || op["lease_until"].as_u64().is_none_or(|until| until <= at)
            || op["worker"] != a["worker"] || op["id"] != command["id"]
            || op["attempt"] != command["attempt"] || op["epoch"] != command["epoch"] {
            return Ok(false);
        }
    }
    Ok(seen)
}
impl Store {
    pub fn pending_coordinator_updates(&self, input: ActiveQuery) -> Result<Value> {
        if input.after.as_ref().is_some_and(|s| !valid_id(s)) {
            bail!("invalid Coordinator update cursor")
        }
        let db = self.db.lock();
        let accounting = super::work_run_accounting_status::source("r.id", "r.body");
        let mut q=db.prepare(&format!("SELECT id,revision,body FROM work_runs r WHERE id>?1 AND (state IN ('completed','failed','cancelled','waiting_user','cancel_unconfirmed','taking_over','paused') OR json_type(body,'$.pending_clarification')='object' OR (state='waiting_resource' AND CAST(json_extract(body,'$.updated_at') AS INTEGER)<=?2) OR EXISTS({accounting})) AND json_type(body,'$.coordinator')='object' AND NOT EXISTS(SELECT 1 FROM workbench_documents d WHERE d.key='coordinator-update:'||json_array(r.id,r.revision)) ORDER BY id LIMIT 32"))?;
        let candidates = q
            .query_map(
                params![input.after.unwrap_or_default(), now().saturating_sub(30000)],
                |r| Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?,r.get::<_,String>(2)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let next_cursor = if candidates.len() == 32 { json!(candidates.last().unwrap().0) } else { Value::Null };
        let mut items = Vec::new();
        for (id, revision, body) in candidates {
            let run: Value = serde_json::from_str(&body)?;
            if run["state"] == "waiting_resource" && !run["pending_clarification"].is_object()
                && has_only_live_assigned_workers(&db, &run, now())?
                && super::work_run_accounting_status::observe(&db, &run, &self.node_id)?["blocked"] != true { continue; }
            items.push(json!({"run_id":id,"revision":revision}));
        }
        Ok(json!({"next_cursor":next_cursor,"items":items}))
    }
    pub fn coordinator_update(&self, run: &str, revision: u64) -> Result<Option<Value>> {
        if !valid_id(run) || revision == 0 || revision > i64::MAX as u64 {
            bail!("invalid Coordinator update identity")
        }
        read(&self.db.lock(), run, revision)
    }
    pub fn queue_coordinator_update(&self, id: &str, input: Queue) -> Result<Value> {
        if !valid_id(id)
            || input.expected_revision == 0
            || input.expected_revision > i64::MAX as u64
        {
            bail!("invalid Coordinator update")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(prior) = read(&tx, id, input.expected_revision)? {
            return Ok(prior);
        }
        let body: String =
            tx.query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))?;
        let run: Value = serde_json::from_str(&body)?;
        let state = run["state"].as_str().unwrap_or("");
        let question_pending = run["pending_clarification"].is_object() && !matches!(state, "completed" | "failed" | "cancelled");
        let accounting = super::work_run_accounting_status::observe(&tx, &run, &self.node_id)?;
        let accounting_blocked = accounting["blocked"] == true && !matches!(state, "completed" | "failed" | "cancelled");
        let blocked = accounting_blocked || question_pending || matches!(state, "waiting_user" | "cancel_unconfirmed" | "taking_over" | "paused")
            || (state == "waiting_resource"
                && run["updated_at"]
                    .as_u64()
                    .is_some_and(|at| now().saturating_sub(at) >= 30000)
                && !has_only_live_assigned_workers(&tx, &run, now())?);
        if run["revision"] != input.expected_revision
            || !(matches!(state, "completed" | "failed" | "cancelled") || blocked)
        {
            bail!("Coordinator update requires exact terminal or blocked run")
        }
        let origin = &run["coordinator"];
        let team = run["team_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid run team"))?;
        let control = coordinator_control::current_in(&tx, team)?
            .ok_or_else(|| anyhow::anyhow!("Coordinator control missing"))?;
        if control["revision"] != origin["control_revision"]
            || control["conversation_id"] != origin["conversation_id"]
            || control["request"]["operation_id"] != origin["operation_id"]
        {
            bail!("Coordinator update control changed")
        }
        let op = builder_authority::operation(
            &tx,
            origin["operation_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Coordinator origin missing"))?,
        )?;
        let at = now();
        if op.state != State::Active
            || op.worker.node_id != self.node_id
            || origin["attempt"] != op.attempt
            || origin["epoch"] != op.epoch
            || op.lease_until.is_none_or(|t| t <= at)
        {
            bail!("Coordinator update requires active local lease")
        }
        super::operation_grant::admit(&tx, &op, at)?;
        super::operation_budget::admit(&tx, &op, at)?;
        if !super::resource_admission::admit(&tx, &op, at)?.allowed {
            bail!("Coordinator resource unavailable")
        }
        let mut summary = json!({"run_id":id,"revision":input.expected_revision,"state":run["state"],"event_kind":if blocked {"blocked"} else {"terminal"},"waiting_reason":run["waiting_reason"],"completion_authorized":run["completion_authorized"],"source_message_id":origin["source_message_id"],"conversation_id":origin["conversation_id"],"team_id":team});
        if accounting_blocked {
            summary["execution_accounting"] = accounting;
            summary["waiting_reason"] = json!("usage_reconciliation_required");
        }
        if question_pending {
            let q = &run["pending_clarification"];
            summary["worker_clarification_count"] = json!(super::assignment_clarification::pending(&run).len());
            summary["worker_clarification"] = json!({"assignment_id":q["assignment_id"],"stage_id":q["stage_id"],"stage_attempt":q["stage_attempt"],"request_id":q["request"]["request_id"],"call_id":q["request"]["call_id"],"questions":q["request"]["questions"],"context_hash":q["context_hash"]});
        }
        if matches!(state, "taking_over" | "paused") {
            summary["intervention"] = json!({"reason":run["intervention"]["reason"],
                "stop_confirmed":run["intervention"]["stop_confirmed"],
                "resources_released":run["intervention"]["resources_released"],
                "accounting":run["intervention"]["accounting"]});
        }
        let delivery = Self::insert_in(
            &tx,
            Message {
                id: uuid::Uuid::new_v4().to_string(),
                source: Address {
                    node_id: self.node_id.clone(),
                    session_id: format!("coordinator-owner-{:x}", Sha256::digest(team.as_bytes())),
                },
                target: op.worker.clone(),
                content: serde_json::to_string(
                    &json!({"format":"kode.coordinator.run-update.v1","run_id":id,"revision":input.expected_revision,"conversation_id":origin["conversation_id"],"operation_id":op.id}),
                )?,
                idempotency_key: format!("coordinator-update-{}", uuid::Uuid::new_v4()),
                direct_insert: false,
                in_reply_to: None,
                hop_count: 0,
                created_at: at,
                expires_at: at + 86400000,
                status: Status::Received,
                detail: None,
            },
        )?;
        let row = json!({"summary":summary,"receipt":{"message_id":delivery.id,"run_id":id,"revision":input.expected_revision,"team_id":team,"conversation_id":origin["conversation_id"],"operation_id":op.id,"attempt":op.attempt,"epoch":op.epoch,"control_revision":control["revision"],"worker":op.worker,"home_hub":self.node_id,"state":"queued","created_at":at}});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key(id, input.expected_revision),
                serde_json::to_string(&row)?
            ],
        )?;
        tx.execute(
            "INSERT INTO team_events(team_id,body) VALUES (?1,?2)",
            params![
                team,
                serde_json::to_string(
                    &json!({"kind":"coordinator_run_update_queued","receipt":row["receipt"]})
                )?
            ],
        )?;
        tx.commit()?;
        Ok(row)
    }
}

#[cfg(test)]
mod execution_notice_tests {
    use super::*;
    fn fixture() -> (Connection, Value, Value, Value) {
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE work_assignments(id TEXT,run_id TEXT,operation_id TEXT,body TEXT);CREATE TABLE operations(id TEXT,body TEXT);CREATE TABLE assignment_resource_holds(assignment_id TEXT,state TEXT);").unwrap();
        let run=json!({"id":"run","team_id":"team","stages":[{"stage_id":"implement","state":"ready","attempt":1,"assignment_id":"assignment"}]});
        let op=json!({"id":"operation","state":"active","lease_until":200,"attempt":1,"epoch":2,"worker":{"node_id":"home","session_id":"worker"}});
        let a=json!({"id":"assignment","run_id":"run","team_id":"team","stage_id":"implement","stage_attempt":1,"state":"prepared","worker":op["worker"],"dispatch":{"command":{"operation":{"id":"operation","attempt":1,"epoch":2}}},"resources":{"state":"held"},"admission":{"kind":"official_local_host"},"creation":{"state":"created","session_id":"worker"},"mandate":{"receipt":{"message_id":"mandate"}}});
        db.execute("INSERT INTO work_assignments VALUES('assignment','run','operation',?1)",[a.to_string()]).unwrap();
        db.execute("INSERT INTO operations VALUES('operation',?1)",[op.to_string()]).unwrap();
        db.execute("INSERT INTO assignment_resource_holds VALUES('assignment','held')",[]).unwrap();
        (db,run,a,op)
    }
    #[test]
    fn ready_stage_with_created_held_mandated_active_worker_is_execution_not_resource_block() {
        let (db,run,_,_)=fixture();assert!(has_only_live_assigned_workers(&db,&run,100).unwrap());
    }
    #[test]
    fn actual_resource_wait_and_expired_or_wrong_execution_remain_blocked() {
        let (db,mut run,a,op)=fixture();
        for change in [json!({"state":"prepared"}),json!({"lease_until":100}),json!({"epoch":3})] {
            let mut changed=op.clone();for(k,v)in change.as_object().unwrap(){changed[k]=v.clone();}
            db.execute("UPDATE operations SET body=?1",[changed.to_string()]).unwrap();assert!(!has_only_live_assigned_workers(&db,&run,100).unwrap());
        }
        db.execute("UPDATE operations SET body=?1",[op.to_string()]).unwrap();
        for field in ["creation","mandate","admission","resources"] {
            let mut changed=a.clone();changed[field]=Value::Null;db.execute("UPDATE work_assignments SET body=?1",[changed.to_string()]).unwrap();assert!(!has_only_live_assigned_workers(&db,&run,100).unwrap());
        }
        db.execute("UPDATE work_assignments SET body=?1",[a.to_string()]).unwrap();db.execute("UPDATE assignment_resource_holds SET state='released'",[]).unwrap();assert!(!has_only_live_assigned_workers(&db,&run,100).unwrap());
        run["stages"][0]["assignment_id"]=Value::Null;assert!(!has_only_live_assigned_workers(&db,&run,100).unwrap());
    }
    #[test]
    fn discovery_skips_live_worker_but_keeps_real_resource_wait_and_clarifications() {
        let root=tempfile::tempdir().unwrap();
        let store=Store::open(&root.path().join("ledger.sqlite"),"home").unwrap();
        let (_,mut run,a,mut op)=fixture();
        let at=now();op["lease_until"]=json!(at+60000);
        run["home_hub"]=json!("home");run["state"]=json!("waiting_resource");run["revision"]=json!(1);run["updated_at"]=json!(at-60000);run["coordinator"]=json!({});
        {
            let db=store.db.lock();
            db.execute("INSERT INTO work_runs VALUES('run','team','request','{}',1,'waiting_resource',?1,?1)",[run.to_string()]).unwrap();
            db.execute("INSERT INTO operations VALUES('operation','owner','request','\"active\"',?1,?2)",params![at+60000,op.to_string()]).unwrap();
            db.execute("INSERT INTO work_assignments VALUES('assignment','run','implement',1,'team','operation','prepared',?1)",[a.to_string()]).unwrap();
            db.execute("INSERT INTO assignment_resource_holds VALUES('assignment','account','home','/fixture','held','{}','{}')",[]).unwrap();
        }
        assert_eq!(store.pending_coordinator_updates(ActiveQuery{after:None}).unwrap()["items"],json!([]));
        assert!(store.queue_coordinator_update("run",Queue{expected_revision:1}).unwrap_err().to_string().contains("terminal or blocked"));
        {
            let db=store.db.lock();db.execute("UPDATE assignment_resource_holds SET state='released'",[]).unwrap();
        }
        assert_eq!(store.pending_coordinator_updates(ActiveQuery{after:None}).unwrap()["items"][0]["run_id"],"run");
        {
            let db=store.db.lock();db.execute("UPDATE assignment_resource_holds SET state='held'",[]).unwrap();run["pending_clarification"]=json!({"request":{"request_id":"question"}});db.execute("UPDATE work_runs SET body=?1",[run.to_string()]).unwrap();
        }
        assert_eq!(store.pending_coordinator_updates(ActiveQuery{after:None}).unwrap()["items"][0]["run_id"],"run");
    }

}
