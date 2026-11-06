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
impl Store {
    pub fn pending_coordinator_updates(&self, input: ActiveQuery) -> Result<Value> {
        if input.after.as_ref().is_some_and(|s| !valid_id(s)) {
            bail!("invalid Coordinator update cursor")
        }
        let db = self.db.lock();
        let accounting = super::work_run_accounting_status::source("r.id", "r.body");
        let mut q=db.prepare(&format!("SELECT id,revision FROM work_runs r WHERE id>?1 AND (state IN ('completed','failed','cancelled','waiting_user','cancel_unconfirmed','taking_over','paused') OR json_type(body,'$.pending_clarification')='object' OR (state='waiting_resource' AND CAST(json_extract(body,'$.updated_at') AS INTEGER)<=?2) OR EXISTS({accounting})) AND json_type(body,'$.coordinator')='object' AND NOT EXISTS(SELECT 1 FROM workbench_documents d WHERE d.key='coordinator-update:'||json_array(r.id,r.revision)) ORDER BY id LIMIT 32"))?;
        let items = q
            .query_map(
                params![input.after.unwrap_or_default(), now().saturating_sub(30000)],
                |r| Ok(json!({"run_id":r.get::<_,String>(0)?,"revision":r.get::<_,u64>(1)?})),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(
            json!({"next_cursor":if items.len()==32{items.last().unwrap()["run_id"].clone()}else{Value::Null},"items":items}),
        )
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
                    .is_some_and(|at| now().saturating_sub(at) >= 30000));
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
