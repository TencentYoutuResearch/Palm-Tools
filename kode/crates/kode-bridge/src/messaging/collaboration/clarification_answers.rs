//! Explicit archive-thread owner answers. Ordinary discussion is never answer authority.
use super::{storage, tasks};
use crate::messaging::{
    assignment_answers, assignment_resources,
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Answer {
    request_id: String,
    source_surface_id: String,
    thread_id: String,
    run_id: String,
    assignment_id: String,
    question_request_id: String,
    content: String,
}
pub(in crate::messaging) fn frozen_source(db: &Connection, receipt: &Value) -> Result<Value> {
    let source = &receipt["human_source"];
    let body: String = db.query_row("SELECT body FROM collaboration_messages WHERE id=?1 AND surface_id=?2 AND thread_id=?3 AND kind='clarification_answer'",
        params![receipt["source_message_id"].as_str(),source["surface_id"].as_str(),source["thread_id"].as_str()],|r|r.get(0))?;
    let human: Value = serde_json::from_str(&body)?;
    if source["kind"] != "collaboration_owner"
        || human["task_id"] != source["task_id"]
        || human["scope"] != source["scope"]
        || human["actor"] != json!({"kind":"human","id":"local_owner"})
    {
        bail!("archived owner answer provenance mismatch")
    }
    Ok(human)
}
pub(in crate::messaging) fn notify(
    db: &Connection,
    home: &str,
    run: &Value,
    question: &Value,
) -> Result<()> {
    let Some(id) = run["collaboration"]["task_id"].as_str() else {
        return Ok(());
    };
    let row = tasks::task(db, id)?;
    tasks::guard(db, home, &row)?;
    if row.work_run_id.as_deref() != run["id"].as_str() {
        bail!("question task run mismatch")
    }
    storage::insert_message(
        db,
        &row.archive_surface_id,
        &row.thread_id,
        "worker_clarification",
        json!({
            "id":uuid::Uuid::new_v4().to_string(),"surface_id":row.archive_surface_id,"thread_id":row.thread_id,
            "task_id":row.id,"scope":row.scope,"team_id":row.team_id,"actor":{"kind":"superagent","id":run["context"]["team"]["superagent_id"]},
            "kind":"worker_clarification","run_id":run["id"],"assignment_id":question["assignment_id"],
            "question_request_id":question["request"]["request_id"],"questions":question["request"]["questions"],
            "content":"Worker needs an explicit answer for this task.","created_at":question["recorded_at"]
        }),
    )?;
    tasks::event(
        db,
        &row,
        "worker_clarification_requested",
        json!({"run_id":run["id"],"receipt":question}),
    )?;
    Ok(())
}
impl Store {
    pub(super) fn answer_collaboration_clarification(
        &self,
        id: &str,
        input: Answer,
    ) -> Result<Value> {
        if ![
            id,
            &input.request_id,
            &input.source_surface_id,
            &input.thread_id,
            &input.run_id,
            &input.assignment_id,
            &input.question_request_id,
        ]
        .iter()
        .all(|s| valid_id(s))
            || !storage::text(&input.content, 16384)
        {
            bail!("invalid collaboration clarification answer")
        }
        let request = serde_json::to_value(&input)?;
        let namespace = format!("task-clarification-answer:{id}");
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let row = tasks::task(&tx, id)?;
        tasks::guard(&tx, &self.node_id, &row)?;
        if input.source_surface_id != row.archive_surface_id
            || input.thread_id != row.thread_id
            || row.work_run_id.as_deref() != Some(input.run_id.as_str())
        {
            bail!("clarification answers require the task's exact archive thread and run")
        }
        if let Some(prior) = storage::receipt(&tx, &namespace, &input.request_id, &request)? {
            return Ok(prior);
        }
        let body: String = tx.query_row(
            "SELECT body FROM work_assignments WHERE id=?1",
            [&input.assignment_id],
            |r| r.get(0),
        )?;
        let assignment: Value = serde_json::from_str(&body)?;
        let (run, operation) = assignment_resources::authorized_context(
            &tx,
            &input.assignment_id,
            &assignment,
            now(),
        )?;
        if run["id"] != input.run_id
            || run["collaboration"]["task_id"] != id
            || run["team_id"] != row.team_id
        {
            bail!("clarification answer task assignment scope mismatch")
        }
        let human = storage::insert_message(
            &tx,
            &row.archive_surface_id,
            &row.thread_id,
            "clarification_answer",
            json!({
                "id":uuid::Uuid::new_v4().to_string(),"surface_id":row.archive_surface_id,"thread_id":row.thread_id,
                "task_id":row.id,"scope":row.scope,"team_id":row.team_id,"actor":{"kind":"human","id":"local_owner"},
                "kind":"clarification_answer","content":input.content,"created_at":now(),
                "clarification_target":{"run_id":input.run_id,"assignment_id":input.assignment_id,"question_request_id":input.question_request_id}
            }),
        )?;
        let source_id = human["id"].as_str().unwrap().to_string();
        let result = assignment_answers::queue_in(
            &tx,
            &self.node_id,
            &input.assignment_id,
            &input.question_request_id,
            &source_id,
            request.clone(),
            assignment,
            run,
            operation,
            human,
            json!({"kind":"collaboration_owner","task_id":row.id,"surface_id":row.archive_surface_id,"thread_id":row.thread_id,"scope":row.scope}),
        )?;
        storage::save_receipt(&tx, &namespace, &input.request_id, &request, &result)?;
        tasks::event(
            &tx,
            &row,
            "worker_clarification_answer_queued",
            json!({"receipt":result}),
        )?;
        tx.commit()?;
        Ok(result)
    }
}
