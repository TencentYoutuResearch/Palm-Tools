//! Discussion transport is not execution authority. New input is stored without delivery
//! until isolated contexts are ready. Existing legacy deliveries retain their original routing.
use super::{model::*, storage::*, tasks};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use crate::messaging::{model::now, team_activation};

pub(in crate::messaging) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS collaboration_coordinator_inputs(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,
 team_id TEXT NOT NULL,surface_id TEXT NOT NULL,thread_id TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS collaboration_input_pending ON collaboration_coordinator_inputs(conversation_id,seq);
CREATE TABLE IF NOT EXISTS collaboration_coordinator_replies(
 conversation_id TEXT NOT NULL,request_id TEXT NOT NULL,request TEXT NOT NULL,body TEXT NOT NULL,
 PRIMARY KEY(conversation_id,request_id));
"#;

fn bound_task(db: &Connection, surface: &str, thread: &str) -> Result<Option<Task>> {
    let body: Option<String> = db.query_row("SELECT body FROM collaboration_tasks WHERE archive_surface_id=?1 AND thread_id=?2", params![surface,thread], |r| r.get(0)).optional()?;
    body.map(|b| Ok(serde_json::from_str(&b)?)).transpose()
}
fn terminal(db: &Connection, task: &Task) -> Result<bool> {
    if task.state == "cancel_requested" { return Ok(true); }
    if let Some(run) = &task.work_run_id {
        let state: String = db.query_row("SELECT state FROM work_runs WHERE id=?1 AND team_id=?2", params![run,task.team_id], |r| r.get(0))?;
        return Ok(["cancelling","cancelled","completed","failed"].contains(&state.as_str()));
    }
    Ok(false)
}
/// Called in the authenticated owner send transaction, never from a session or webhook.
pub(super) fn accept(db: &Connection, home: &str, surface: &Surface, row: &mut Value, mentions: &[Mention]) -> Result<()> {
    let task = bound_task(db, &surface.id, row["thread_id"].as_str().unwrap())?;
    let team = if let Some(task) = &task {
        tasks::guard(db, home, task)?;
        if terminal(db, task)? { row["delivery_reason"] = json!("task_settled_or_cancelled"); return Ok(()); }
        if mentions.iter().any(|m| m.team_id != task.team_id || m.worker_id.is_some()) {
            bail!("discussion recipient differs from bound task")
        }
        task.team_id.clone()
    } else if mentions.len() == 1 && mentions[0].worker_id.is_none() {
        mentions[0].team_id.clone()
    } else {
        row["delivery_reason"] = json!("recipient_required"); return Ok(());
    };
    // The shared Coordinator contains this owner's private team conversation. Never publish
    // its generated content to a surface with a different/wider audience without approval.
    if surface.team_ids != vec![team.clone()] {
        row["delivery_reason"] = json!("audience_publication_approval_required"); return Ok(());
    }
    let revision = check_team(db, surface, &team, None, None)?;
    let Some(_active) = team_activation::authorized(db, &team, revision, now())? else {
        row["delivery_reason"] = json!("team_activation_required"); return Ok(());
    };
    // The Team-wide persistent session is not a model context boundary. Preserve
    // this message without enqueuing it. Existing deliveries remain unchanged.
    row["delivery_state"] = json!("stored_only");
    row["delivery_reason"] = json!("isolated_context_required");
    row["context_readiness"] = json!({"state":"not_ready",
        "reason":"isolated_context_required","isolation":"unavailable",
        "legacy_shared_session_reused":false});
    Ok(())
}
/// Recheck audience, owner provenance and immutable task/run routing at each delivery/read.
pub(in crate::messaging) fn source(db: &Connection, conversation: &str, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = db.query_row("SELECT body FROM collaboration_coordinator_inputs WHERE conversation_id=?1 AND id=?2", params![conversation,id], |r| r.get(0)).optional()?;
    let Some(raw) = raw else { return Ok(None); };
    let input: Value = serde_json::from_str(&raw)?;
    let route = &input["discussion"];
    let scope: Scope = serde_json::from_value(route["scope"].clone())?;
    let s = surface(db, &scope.home_hub, route["surface_id"].as_str().ok_or_else(|| anyhow::anyhow!("discussion surface missing"))?, true)?;
    let team = input["team_id"].as_str().ok_or_else(|| anyhow::anyhow!("discussion team missing"))?;
    if s.scope != scope || s.audience_revision != route["audience_revision"].as_u64().unwrap_or(0)
        || s.team_ids != vec![team.to_owned()] || input["execution_authorized"] != false
        || input["actor"] != json!({"kind":"human","id":"local_owner"}) {
        bail!("discussion audience or provenance changed")
    }
    check_team(db, &s, team, input["team_revision"].as_u64(), None)?;
    let message = message(db, &s.id, id)?;
    if message["actor"] != input["actor"] || message["content"] != input["content"] || message["thread_id"] != route["thread_id"] {
        bail!("discussion source mismatch")
    }
    if let Some(id) = route["task_id"].as_str() {
        let task = tasks::task(db, id)?;
        tasks::guard(db, &scope.home_hub, &task)?;
        if task.team_id != team || task.archive_surface_id != s.id || json!(task.thread_id) != route["thread_id"] || json!(task.work_run_id) != route["run_id"] {
            bail!("discussion task route changed")
        }
    }
    Ok(Some(input))
}
pub(in crate::messaging) fn admit_delivery(db: &Connection, input: &Value) -> Result<()> {
    if let Some(task) = input["discussion"]["task_id"].as_str() {
        if terminal(db, &tasks::task(db, task)?)? { bail!("discussion task settled or cancelled before delivery"); }
    }
    Ok(())
}
pub(in crate::messaging) fn reply_receipt(db: &Connection, conversation: &str, request: &str) -> Result<Option<(String,String)>> {
    Ok(db.query_row("SELECT request,body FROM collaboration_coordinator_replies WHERE conversation_id=?1 AND request_id=?2",params![conversation,request],|r| Ok((r.get(0)?,r.get(1)?))).optional()?)
}
/// Late replies are an archive only. They never reopen a settled task or start execution.
pub(in crate::messaging) fn publish(db: &Connection, input: &Value, encoded: &str, mut reply: Value) -> Result<Value> {
    let route = &input["discussion"];
    let surface = route["surface_id"].as_str().unwrap();
    let thread = route["thread_id"].as_str().unwrap();
    reply["surface_id"] = json!(surface); reply["thread_id"] = json!(thread);
    reply["scope"] = route["scope"].clone(); reply["task_id"] = route["task_id"].clone(); reply["run_id"] = route["run_id"].clone();
    reply["kind"] = json!("superagent_reply"); reply["execution_authorized"] = json!(false);
    let reply = insert_message(db, surface, thread, "superagent_reply", reply)?;
    db.execute("INSERT INTO collaboration_coordinator_replies(conversation_id,request_id,request,body) VALUES (?1,?2,?3,?4)",params![reply["conversation_id"].as_str(),reply["request_id"].as_str(),encoded,reply.to_string()])?;
    Ok(reply)
}

/// Read-time evidence, separate from immutable owner-send receipts.
pub(super) fn presentation(db: &Connection, row: &mut Value) -> Result<()> {
    if row["discussion_route"].is_null() { return Ok(()); }
    let key = format!("coordinator-input:{}", json!(row["id"].as_str().unwrap()));
    let saved: Option<String> = db.query_row("SELECT value FROM workbench_documents WHERE key=?1",[key],|r|r.get(0)).optional()?;
    if let Some(saved) = saved {
        let saved: Value = serde_json::from_str(&saved)?;
        let phase: Option<u32> = db.query_row("SELECT phase FROM runtime_deliveries WHERE message_id=?1 AND session=?2",params![saved["receipt"]["message_id"].as_str(),saved["receipt"]["worker"]["session_id"].as_str()],|r|r.get(0)).optional()?;
        row["delivery_state"] = json!(if phase == Some(2) { "consumed_by_coordinator" } else { "queued_to_coordinator" });
        row["coordinator_delivery_id"] = saved["receipt"]["message_id"].clone();
    } else if let Some(id) = row["discussion_route"]["task_id"].as_str() {
        if terminal(db, &tasks::task(db,id)?)? {
            row["delivery_state"] = json!("stored_only"); row["delivery_reason"] = json!("task_settled_or_cancelled");
        }
    }
    Ok(())
}
