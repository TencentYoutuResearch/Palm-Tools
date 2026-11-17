//! Owner-only, live task references. No conversation write, model delivery or authority is created.
use super::{model::{Kind, Task}, tasks};
use crate::messaging::{model::valid_id, store::Store};
use anyhow::{bail, Result};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Page {
    #[serde(default)]
    pub after: String,
}

impl Store {
    pub(super) fn conversation_task_notices(&self, conversation: &str, page: Page) -> Result<Value> {
        if !valid_id(conversation) || (!page.after.is_empty() && !valid_id(&page.after)) {
            bail!("invalid conversation task notice identity")
        }
        let mut connection = self.db.lock();
        // One read transaction pins task, audience, workspace and run to the same snapshot.
        let db = connection.transaction()?;
        let team: String = db.query_row("SELECT id FROM teams WHERE conversation_id=?1", [conversation], |r| r.get(0))?;
        // Page task identities, not events: repeated reads and restarts cannot duplicate notices.
        let mut query = db.prepare("SELECT body FROM collaboration_tasks WHERE team_id=?1 AND id>?2 ORDER BY id LIMIT 33")?;
        let mut rows = query.query_map(params![team, page.after], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = rows.len() > 32;
        if more { rows.pop(); }
        let mut cursor = Value::Null;
        let mut items = Vec::new();
        let mut unavailable = false;
        for body in rows {
            let task: Task = serde_json::from_str(&body)?;
            cursor = json!(task.id);
            let (origin, archive) = match tasks::guard(&db, &self.node_id, &task) {
                Ok(value) => value,
                Err(_) => { unavailable = true; continue; }
            };
            // Wider or private-origin surfaces retain their existing publication boundary.
            if origin.kind != Kind::Channel || archive.kind != Kind::Channel
                || origin.team_ids != [team.clone()] || archive.team_ids != [team.clone()] { continue; }
            let Some(run_id) = &task.work_run_id else { continue };
            let body: String = db.query_row("SELECT body FROM work_runs WHERE id=?1", [run_id], |r| r.get(0))?;
            let run: Value = serde_json::from_str(&body)?;
            if run["id"] != *run_id || run["team_id"] != team || run["team_revision"] != task.team_revision || run["home_hub"] != self.node_id
                || run["collaboration"]["task_id"] != task.id
                || !matches!(run["collaboration"]["format"].as_str(), Some("kode.collaboration.work-source.v1" | "kode.collaboration.work-source.v2"))
                || run["collaboration"]["context_id"] != task.context_id
                || run["collaboration"]["archive_surface_id"] != task.archive_surface_id
                || run["collaboration"]["thread_id"] != task.thread_id
                || run["collaboration"]["scope"] != serde_json::to_value(&task.scope)?
                || run["collaboration"]["origin_audience_revision"] != task.origin_audience_revision
                || run["collaboration"]["archive_audience_revision"] != task.archive_audience_revision {
                unavailable = true; continue;
            }
            let state = run["state"].as_str().unwrap_or("");
            // Stopping/unknown work is not an answer prompt. Existing stop UI remains unchanged.
            if !matches!(state, "running" | "queued" | "waiting_resource" | "waiting_user" | "cancel_unconfirmed" | "paused" | "taking_over" | "completed" | "failed" | "cancelled") { continue; }
            let terminal = matches!(state, "completed" | "failed" | "cancelled");
            let questions = if matches!(state, "running" | "queued" | "waiting_resource" | "waiting_user") {
                crate::messaging::assignment_clarification::pending(&run).len()
            } else { 0 };
            if questions == 0 && !terminal && !matches!(state, "waiting_user" | "cancel_unconfirmed" | "paused" | "taking_over") { continue; }
            // Only the approved task label is displayed. Questions/results stay in the original thread.
            let title: String = task.summary.chars().take(160).collect();
            items.push(json!({"task_id":task.id,"team_id":team,"scope":task.scope,
                "surface_id":archive.id,"channel_title":archive.title,"thread_id":task.thread_id,
                "run_id":run_id,"run_revision":run["revision"],"state":state,"question_count":questions,
                "completion_authorized":run["completion_authorized"]==true,
                "title":title,"title_truncated":task.summary.chars().count()>160}));
        }
        Ok(json!({"conversation_id":conversation,"team_id":team,"home_hub":self.node_id,
            "items":items,"unavailable":unavailable,"next_cursor":if more { cursor } else { Value::Null }}))
    }
}
