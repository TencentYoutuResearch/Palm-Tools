//! Human answer patches and draft revisions commit together. Builder tools cannot use this endpoint.
use super::{
    builder_drafts::{Interview, Question, Save},
    model::valid_id,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub request_id: String,
    pub expected_revision: u64,
    #[serde(default)]
    pub answers: BTreeMap<String, String>,
    #[serde(default)]
    pub clear_answers: Vec<String>,
}
impl Store {
    pub fn answer_builder_draft(&self, id: &str, input: Answer) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = self.answer_builder_draft_in(&tx, id, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub(super) fn answer_builder_draft_in(
        &self,
        tx: &rusqlite::Transaction,
        id: &str,
        mut input: Answer,
    ) -> Result<Value> {
        input.clear_answers.sort();
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.answers.len() > 128
            || input.clear_answers.len() > 128
            || input.answers.is_empty() && input.clear_answers.is_empty()
            || input.clear_answers.windows(2).any(|w| w[0] == w[1])
            || input.answers.iter().any(|(k, v)| {
                !valid_id(k) || v.trim().is_empty() || v.len() > 8192 || v.contains('\0')
            })
            || input
                .clear_answers
                .iter()
                .any(|k| !valid_id(k) || input.answers.contains_key(k))
            || serde_json::to_vec(&input)?.len() > 131072
        {
            bail!("invalid Builder answers")
        }
        let key = format!("builder-answer:{}", json!([id, input.request_id]));
        let request = serde_json::to_value(&input)?;
        let replay: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(replay) = replay {
            let replay: Value = serde_json::from_str(&replay)?;
            if replay["request"] != request {
                bail!("Builder answer request identity conflict")
            }
            return Ok(replay["receipt"].clone());
        }
        let body: String = tx.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )?;
        let draft: Value = serde_json::from_str(&body)?;
        if draft["status"] != "draft" || draft["revision"].as_u64() != Some(input.expected_revision)
        {
            bail!("Builder draft revoked or revision conflict")
        }
        let mut interview: Interview = serde_json::from_value(draft["interview"].clone())?;
        let mut known: HashSet<String> = interview
            .answers
            .keys()
            .cloned()
            .chain(interview.questions.iter().map(|q| q.id.clone()))
            .collect();
        if let Some(plan) = &interview.questionnaire {
            known.extend(plan.questions.iter().map(|q| q.id.clone()));
        }
        if input
            .answers
            .keys()
            .chain(input.clear_answers.iter())
            .any(|k| !known.contains(k))
        {
            bail!("unknown Builder question")
        }
        let old = interview.answers.clone();
        for key in &input.clear_answers {
            interview.answers.remove(key);
        }
        interview.answers.extend(input.answers.clone());
        if let Some(plan) = &interview.questionnaire {
            let mut pending = Vec::new();
            for q in &plan.questions {
                if q.when_answer
                    .as_ref()
                    .is_some_and(|c| interview.answers.get(&c.question_id) != Some(&c.equals))
                {
                    if input.answers.contains_key(&q.id) {
                        bail!("answer supplied for inactive Builder question")
                    }
                    interview.answers.remove(&q.id);
                } else if !interview.answers.contains_key(&q.id) && pending.len() < 3 {
                    pending.push(Question {
                        id: q.id.clone(),
                        prompt: q.prompt.clone(),
                    });
                }
            }
            interview.questions = pending;
        } else {
            interview
                .questions
                .retain(|q| !interview.answers.contains_key(&q.id));
        }
        if old != interview.answers {
            interview.proposed_team = None;
            interview.proposed_workflow = None;
        }
        let receipt = self.save_builder_draft_in(
            &tx,
            Save {
                builder_operation: None,
                host_inspection: None,
                id: id.into(),
                request_id: input.request_id,
                expected_revision: input.expected_revision,
                revoked: false,
                interview,
            },
        )?;
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key,
                serde_json::to_string(&json!({"request":request,"receipt":receipt}))?
            ],
        )?;
        Ok(receipt)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspaces {
    pub request_id: String,
    pub expected_revision: u64,
    pub workspace_refs: Vec<super::teams::WorkspaceRef>,
}
impl Store {
    /// Workspace selection is configuration intent, not a grant or filesystem inspection.
    pub fn set_builder_workspaces(&self, id: &str, input: Workspaces) -> Result<Value> {
        if !valid_id(id) || !valid_id(&input.request_id) || input.expected_revision == 0 || input.workspace_refs.len() > 64 {
            bail!("invalid Builder workspace selection")
        }
        let mut seen = HashSet::new();
        for workspace in &input.workspace_refs {
            if !seen.insert((&workspace.host_id, &workspace.workspace_id)) {
                bail!("duplicate Builder workspace")
            }
        }
        let key = format!("builder-workspaces:{}", json!([id, input.request_id]));
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let previous: Option<String> = tx.query_row("SELECT value FROM workbench_documents WHERE key=?1", [&key], |r| r.get(0)).optional()?;
        if let Some(previous) = previous {
            let previous: Value = serde_json::from_str(&previous)?;
            if previous["request"] != request { bail!("Builder workspace request identity conflict") }
            return Ok(previous["receipt"].clone());
        }
        let body: String = tx.query_row("SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1", [id], |r| r.get(0))?;
        let draft: Value = serde_json::from_str(&body)?;
        if draft["status"] != "draft" || draft["revision"].as_u64() != Some(input.expected_revision) {
            bail!("Builder draft revoked or revision conflict")
        }
        let mut interview: Interview = serde_json::from_value(draft["interview"].clone())?;
        if serde_json::to_value(&interview.workspace_refs)? != serde_json::to_value(&input.workspace_refs)? {
            interview.inspections.clear();
            interview.proposed_team = None;
            interview.proposed_workflow = None;
        }
        interview.workspace_refs = input.workspace_refs;
        let receipt = self.save_builder_draft_in(&tx, Save { builder_operation: None, host_inspection: None,
            id: id.into(), request_id: input.request_id, expected_revision: input.expected_revision, revoked: false, interview })?;
        tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)", params![key, serde_json::to_string(&json!({"request":request,"receipt":receipt}))?])?;
        tx.commit()?;
        Ok(receipt)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchStatus {
    pub kind: String,
    pub request_id: String,
    pub expected_revision: u64,
}
impl Store {
    /// One DB snapshot decides whether an unrecorded old-revision patch can still commit.
    pub fn builder_patch_status(&self, id: &str, query: PatchStatus) -> Result<Value> {
        if !valid_id(id) || !valid_id(&query.request_id) || query.expected_revision == 0 || !["answers", "workspaces"].contains(&query.kind.as_str()) {
            bail!("invalid Builder patch status")
        }
        let prefix = if query.kind == "answers" { "builder-answer" } else { "builder-workspaces" };
        let key = format!("{}:{}", prefix, json!([id, query.request_id]));
        let db = self.db.lock();
        let recorded: Option<String> = db.query_row("SELECT value FROM workbench_documents WHERE key=?1", [&key], |r| r.get(0)).optional()?;
        let body: String = db.query_row("SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1", [id], |r| r.get(0))?;
        let draft: Value = serde_json::from_str(&body)?;
        let recorded: Option<Value> = recorded.map(|body| serde_json::from_str(&body)).transpose()?;
        let state = if recorded.is_some() { "recorded" } else if draft["status"] == "revoked" || draft["revision"].as_u64().is_some_and(|revision| revision > query.expected_revision) { "rejected_revision" } else { "unconfirmed" };
        Ok(json!({"home_hub":self.node_id,"draft_id":id,"kind":query.kind,"request_id":query.request_id,
            "expected_revision":query.expected_revision,"current_revision":draft["revision"],"state":state,"record":recorded}))
    }
}
