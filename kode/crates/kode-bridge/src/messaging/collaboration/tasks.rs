//! Task identity and approved archive are independent of execution. No model dispatch occurs here.
use super::{model::*, storage::*};
use crate::messaging::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

#[derive(Debug)]
pub(super) struct UnsupportedMutation;
impl std::fmt::Display for UnsupportedMutation {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        f.write_str("active task amendments and pause are not supported; cancel this execution or create a separately approved task")
    }
}
impl std::error::Error for UnsupportedMutation {}

fn publication(
    input: Option<&Publication>,
    origin: &Surface,
    destination: &Surface,
    content: &str,
) -> Result<()> {
    if origin.id == destination.id {
        return Ok(());
    }
    let p = input.ok_or_else(|| anyhow::anyhow!("explicit publication approval required"))?;
    if p.destination_id != destination.id
        || p.destination_revision != destination.revision
        || p.summary_sha256 != digest(content)
    {
        bail!("publication approval does not match destination, audience or summary")
    }
    Ok(())
}
pub(super) fn task(db: &Connection, id: &str) -> Result<Task> {
    if !valid_id(id) {
        bail!("invalid task identity")
    }
    let body: String = db.query_row(
        "SELECT body FROM collaboration_tasks WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&body)?)
}
pub(super) fn guard(db: &Connection, home: &str, row: &Task) -> Result<(Surface, Surface)> {
    let origin = surface(db, home, &row.origin_surface_id, true)?;
    let archive = surface(db, home, &row.archive_surface_id, true)?;
    if origin.scope != row.scope
        || archive.scope != row.scope
        || origin.audience_revision != row.origin_audience_revision
        || archive.audience_revision != row.archive_audience_revision
    {
        bail!("task audience or workspace changed; explicit reauthorization required")
    }
    check_team(db, &origin, &row.team_id, Some(row.team_revision), None)?;
    check_team(db, &archive, &row.team_id, Some(row.team_revision), None)?;
    Ok((origin, archive))
}
pub(super) fn event(db: &Connection, row: &Task, kind: &str, body: Value) -> Result<Value> {
    let delivery_state = if kind == "work_run_recorded" { "recorded" } else if body["status"] == "work_run_cancel_requested" { "work_run_cancel_requested" } else if body["status"] == "stored_only" { "stored_only" } else { "pending_context_adapter" };
    let mut body = json!({"task_id":row.id,"kind":kind,"scope":row.scope,"created_at":now(),"payload":body,"delivery_state":delivery_state});
    db.execute(
        "INSERT INTO collaboration_task_events(task_id,kind,body) VALUES (?1,?2,?3)",
        params![row.id, kind, serde_json::to_string(&body)?],
    )?;
    let sequence = db.last_insert_rowid();
    body["sequence"] = json!(sequence);
    db.execute(
        "UPDATE collaboration_task_events SET body=?1 WHERE seq=?2",
        params![serde_json::to_string(&body)?, sequence],
    )?;
    Ok(body)
}
impl Store {
    pub(super) fn create_collaboration_task(&self, input: CreateTask) -> Result<Value> {
        if !text(&input.summary, 16384)
            || !valid_id(&input.origin_message_id)
            || !valid_id(&input.team_id)
            || input.team_revision == 0
        {
            bail!("invalid task request")
        }
        let request = serde_json::to_value(&input)?;
        let namespace = format!("task:{}", input.origin_surface_id);
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let origin = surface(&tx, &self.node_id, &input.origin_surface_id, true)?;
        let archive = surface(&tx, &self.node_id, &input.archive_surface_id, true)?;
        if let Some(result) = receipt(&tx, &namespace, &input.request_id, &request)? {
            let saved: Task = serde_json::from_value(result.clone())?;
            guard(&tx, &self.node_id, &saved)?;
            return Ok(result);
        }
        if origin.scope != archive.scope
            || archive.kind != Kind::Channel
            || origin.revision != input.origin_revision
            || archive.revision != input.archive_revision
        {
            bail!("archive scope, kind or revision mismatch")
        }
        check_team(
            &tx,
            &origin,
            &input.team_id,
            Some(input.team_revision),
            None,
        )?;
        check_team(
            &tx,
            &archive,
            &input.team_id,
            Some(input.team_revision),
            None,
        )?;
        let source = message(&tx, &origin.id, &input.origin_message_id)?;
        if source["actor"]["kind"] != "human"
            || source["actor"]["id"] != "local_owner"
            || source["kind"] != "discussion"
        {
            bail!("task requires an owner discussion message")
        }
        publication(
            input.publication.as_ref(),
            &origin,
            &archive,
            &input.summary,
        )?;
        let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_tasks WHERE origin_surface_id=?1 AND origin_message_id=?2 AND team_id=?3)",params![origin.id,input.origin_message_id,input.team_id],|r|r.get(0))?;
        if duplicate {
            bail!("source already has a task for this team; use its existing identity")
        }
        let id = uuid::Uuid::new_v4().to_string();
        let row = Task {
            id: id.clone(),
            scope: origin.scope.clone(),
            origin_surface_id: origin.id.clone(),
            origin_message_id: input.origin_message_id,
            origin_revision: origin.revision,
            archive_surface_id: archive.id.clone(),
            archive_revision: archive.revision,
            origin_audience_revision: origin.audience_revision,
            archive_audience_revision: archive.audience_revision,
            thread_id: uuid::Uuid::new_v4().to_string(),
            team_id: input.team_id,
            team_revision: input.team_revision,
            summary: input.summary,
            revision: 1,
            execution_revision: Some(1),
            state: "recorded".into(),
            dispatch_state: "blocked_context_adapter".into(),
            context_id: format!("collaboration-task:{id}"),
            work_run_id: None,
            created_at: now(),
        };
        // No original DM text is copied to either archive or context. The owner approves this exact summary.
        insert_message(
            &tx,
            &archive.id,
            &row.thread_id,
            "task_root",
            json!({"id":row.thread_id,"surface_id":archive.id,"thread_id":row.thread_id,"task_id":row.id,"scope":row.scope,"actor":{"kind":"human","id":"local_owner"},"kind":"task_root","content":row.summary,"created_at":row.created_at}),
        )?;
        let body = serde_json::to_value(&row)?;
        tx.execute("INSERT INTO collaboration_tasks(id,scope_key,origin_surface_id,origin_message_id,archive_surface_id,thread_id,team_id,revision,body) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![row.id,scope_key(&row.scope)?,row.origin_surface_id,row.origin_message_id,row.archive_surface_id,row.thread_id,row.team_id,row.revision,serde_json::to_string(&row)?])?;
        event(
            &tx,
            &row,
            "task_recorded",
            json!({"summary":row.summary,"context_id":row.context_id,"execution_authorized":false}),
        )?;
        save_receipt(&tx, &namespace, &input.request_id, &request, &body)?;
        tx.commit()?;
        Ok(body)
    }
    pub(super) fn collaboration_task(&self, id: &str) -> Result<Value> {
        let db = self.db.lock();
        let row = task(&db, id)?;
        guard(&db, &self.node_id, &row)?;
        Ok(serde_json::to_value(row)?)
    }
    pub(super) fn collaboration_tasks(&self, surface_id: &str) -> Result<Value> {
        let db = self.db.lock();
        surface(&db, &self.node_id, surface_id, true)?;
        let mut q=db.prepare("SELECT body FROM collaboration_tasks WHERE origin_surface_id=?1 OR archive_surface_id=?1 ORDER BY id LIMIT 201")?;
        let rows = q
            .query_map([surface_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len() > 200 {
            bail!("task directory exceeds supported bound")
        }
        let mut items = Vec::new();
        for body in rows {
            let row: Task = serde_json::from_str(&body)?;
            if guard(&db, &self.node_id, &row).is_ok() {
                items.push(serde_json::to_value(row)?)
            }
        }
        Ok(json!({"surface_id":surface_id,"items":items}))
    }
    pub(super) fn command_collaboration_task(&self, id: &str, input: Command) -> Result<Value> {
        if input.expected_revision >= i64::MAX as u64
            || input.content.as_ref().is_some_and(|c| !text(c, 16384))
        {
            bail!("invalid task command")
        }
        if matches!(input.action, Action::Question | Action::Supplement) && input.content.is_none()
        {
            bail!("task message required")
        }
        let request = serde_json::to_value(&input)?;
        let namespace = format!("task-command:{id}");
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let mut row = task(&tx, id)?;
        let (origin, archive) = guard(&tx, &self.node_id, &row)?;
        let source = if input.source_surface_id == origin.id {
            &origin
        } else if input.source_surface_id == archive.id {
            &archive
        } else {
            bail!("command source outside task")
        };
        if let Some(result) = receipt(&tx, &namespace, &input.request_id, &request)? {
            return Ok(result);
        }
        if row.revision != input.expected_revision {
            bail!("task revision changed")
        }
        if matches!(row.state.as_str(), "cancel_requested") {
            bail!("task cancellation already requested")
        }
        if let Some(worker) = input.worker_id.as_deref() {
            check_team(
                &tx,
                &archive,
                &row.team_id,
                Some(row.team_revision),
                Some(worker),
            )?;
        }
        if let Some(content) = input.content.as_deref() {
            publication(input.publication.as_ref(), source, &archive, content)?;
        }
        // Until reauthorization/steering is implemented, reject scope changes before any write.
        // Exact old receipts were returned above and stay idempotent.
        if row.work_run_id.is_some() && matches!(input.action, Action::Supplement | Action::Pause) {
            bail!(UnsupportedMutation)
        }
        let execution_revision = row.execution_revision.unwrap_or(row.revision);
        row.execution_revision = Some(if input.action == Action::Supplement {
            execution_revision.checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("execution revision exhausted"))?
        } else {
            execution_revision
        });
        let execution = if input.action == Action::Cancel {
            super::execution::cancel_in(&tx, &self.node_id, &row, &input.request_id)?
        } else {
            Value::Null
        };
        let delivery_state = if input.action == Action::Question {
            "stored_only"
        } else if execution.is_null() {
            "pending_context_adapter"
        } else {
            "work_run_cancel_requested"
        };
        let state = match input.action {
            Action::Cancel => "cancel_requested",
            Action::Pause => "pause_requested",
            _ => &row.state,
        }
        .to_string();
        row.state = state;
        row.revision += 1;
        let delivery = event(
            &tx,
            &row,
            "owner_command",
            json!({"action":input.action,"content":input.content,"worker_id":input.worker_id,"source_surface_id":source.id,"actor":{"kind":"human","id":"local_owner"},"status":delivery_state,"execution":execution,"execution_delivery":if input.action==Action::Question { json!({"state":"not_delivered","reason":"worker_question_delivery_not_supported"}) } else { Value::Null }}),
        )?;
        let public_content = input.content.clone().unwrap_or_else(|| {
            if input.action == Action::Cancel {
                "Cancellation requested; not confirmed.".into()
            } else {
                "Pause requested; not confirmed.".into()
            }
        });
        insert_message(
            &tx,
            &archive.id,
            &row.thread_id,
            "owner_command",
            json!({"id":uuid::Uuid::new_v4().to_string(),"surface_id":archive.id,"thread_id":row.thread_id,"task_id":id,"scope":row.scope,"actor":{"kind":"human","id":"local_owner"},"kind":"owner_command","action":input.action,"content":public_content,"created_at":now(),"delivery_state":delivery_state}),
        )?;
        tx.execute(
            "UPDATE collaboration_tasks SET revision=?1,body=?2 WHERE id=?3",
            params![row.revision, serde_json::to_string(&row)?, id],
        )?;
        let result = json!({"task":row,"command":delivery});
        save_receipt(&tx, &namespace, &input.request_id, &request, &result)?;
        tx.commit()?;
        Ok(result)
    }
    pub(super) fn collaboration_task_events(&self, id: &str, page: Page) -> Result<Value> {
        let limit = page.limit.unwrap_or(25);
        if limit == 0 || limit > 50 || page.after > i64::MAX as u64 || page.thread_id.is_some() {
            bail!("invalid task event page")
        }
        let db = self.db.lock();
        let row = task(&db, id)?;
        guard(&db, &self.node_id, &row)?;
        let mut q=db.prepare("SELECT seq,body FROM collaboration_task_events WHERE task_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
        let rows = q
            .query_map(params![id, page.after, limit + 1], |r| {
                Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = rows.len() > limit;
        let mut next = page.after;
        let mut items = Vec::new();
        for (seq, body) in rows.into_iter().take(limit) {
            next = seq;
            items.push(serde_json::from_str::<Value>(&body)?)
        }
        Ok(json!({"task_id":id,"items":items,"next_cursor":if more{json!(next)}else{Value::Null}}))
    }
    pub(super) fn collaboration_task_context(&self, id: &str) -> Result<Value> {
        let db = self.db.lock();
        let row = task(&db, id)?;
        guard(&db, &self.node_id, &row)?;
        let mut q=db.prepare("SELECT body FROM collaboration_messages WHERE surface_id=?1 AND thread_id=?2 AND kind='owner_command' ORDER BY seq DESC LIMIT 51")?;
        let rows = q
            .query_map(params![row.archive_surface_id, row.thread_id], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len() > 50 {
            bail!("task context requires explicit compaction")
        }
        let mut messages = Vec::new();
        let mut bytes = row.summary.len();
        for body in rows.into_iter().rev() {
            bytes += body.len();
            if bytes > 262144 {
                bail!("task context exceeds bound; explicit compaction required")
            }
            messages.push(serde_json::from_str::<Value>(&body)?);
        }
        Ok(
            json!({"task_id":id,"context_id":row.context_id,"scope":row.scope,"team_id":row.team_id,"summary":row.summary,"messages":messages,"includes_private_transcript":false,"execution_authorized":false,"dispatch_state":row.dispatch_state}),
        )
    }
}
