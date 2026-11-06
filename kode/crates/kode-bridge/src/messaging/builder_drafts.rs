//! Home-owned interview snapshots. These never create teams, grants or execution.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Interview {
    pub purpose: String,
    pub workspace_refs: Vec<super::teams::WorkspaceRef>,
    pub answers: BTreeMap<String, String>,
    pub questions: Vec<Question>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub questionnaire: Option<super::builder_interview::Questionnaire>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inspections: Vec<super::builder_facts::Inspection>,
    // Proposed configuration stays untrusted/non-executable until existing team APIs
    // validate it and the human explicitly activates that exact team revision.
    pub proposed_team: Option<super::teams::Spec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_workflow: Option<Value>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub prompt: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Save {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_inspection: Option<super::builder_authority::HostInspection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder_operation: Option<super::builder_authority::Identity>,
    pub id: String,
    pub request_id: String,
    pub expected_revision: u64,
    pub revoked: bool,
    pub interview: Interview,
}
fn text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.contains('\0')
}
impl Save {
    fn validate(&self) -> Result<()> {
        let i = &self.interview;
        if !valid_id(&self.id)
            || !valid_id(&self.request_id)
            || !text(&i.purpose, 8192)
            || i.workspace_refs.len() > 64
            || i.answers.len() > 128
            || i.questions.len() > 3
            || i.answers
                .iter()
                .any(|(k, v)| !valid_id(k) || !text(v, 8192))
            || i.questions.iter().any(|q| {
                !valid_id(&q.id) || !text(&q.prompt, 2048) || i.answers.contains_key(&q.id)
            })
            || i.questions
                .iter()
                .map(|q| &q.id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != i.questions.len()
            || i.workspace_refs.iter().any(|w| {
                !valid_id(&w.host_id) || !valid_id(&w.workspace_id) || !text(&w.root_ref, 1024)
            })
            || i.inspections.len() > 64
            || serde_json::to_vec(self)?.len() > 786432
        {
            bail!("invalid Builder draft")
        }
        if let Some(package) = &i.proposed_workflow {
            super::builder_workflow_proposal::validate(package, &i.workspace_refs)?;
        }
        let mut inspected = std::collections::HashSet::new();
        if let Some(questionnaire) = &i.questionnaire {
            questionnaire.validate()?;
        }
        for inspection in &i.inspections {
            inspection.validate(&i.workspace_refs)?;
            let w = &inspection.workspace;
            if !inspected.insert((&w.host_id, &w.workspace_id, &w.root_ref)) {
                bail!("duplicate Builder inspection workspace")
            }
        }
        Ok(())
    }
}
impl Store {
    pub fn builder_draft_command(&self, id: &str, request: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(request) {
            bail!("invalid Builder command identity")
        }
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT body FROM builder_draft_revisions WHERE id=?1 AND request_id=?2",
                params![id, request],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|v| Ok(serde_json::from_str(&v)?)).transpose()
    }
    pub fn builder_drafts(&self, page: super::teams::Page) -> Result<Value> {
        let limit = page.limit.unwrap_or(25);
        if limit == 0 || limit > 50 || page.after.len() > 256 {
            bail!("invalid Builder draft page")
        }
        let db = self.db.lock();
        let mut query = db.prepare("SELECT body FROM builder_draft_revisions r WHERE id>?1 AND revision=(SELECT MAX(revision) FROM builder_draft_revisions WHERE id=r.id) ORDER BY id LIMIT ?2")?;
        let mut items = query.query_map(params![page.after, limit+1], |r|r.get::<_,String>(0))?
            .map(|row| {
                let v: Value = serde_json::from_str(&row?)?;
                Ok(json!({"id":v["id"],"revision":v["revision"],"status":v["status"],"purpose":v["interview"]["purpose"],"updated_at":v["updated_at"]}))
            }).collect::<Result<Vec<Value>>>()?;
        let more = items.len() > limit;
        items.truncate(limit);
        let next = if more {
            items.last().map(|v| v["id"].clone())
        } else {
            None
        };
        Ok(json!({"items":items,"next_cursor":next,"home_hub":self.node_id}))
    }
    pub fn save_builder_draft(&self, input: Save) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = self.save_builder_draft_in(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub(super) fn save_builder_draft_in(
        &self,
        tx: &rusqlite::Connection,
        input: Save,
    ) -> Result<Value> {
        input.validate()?;
        let request = serde_json::to_string(&input)?;
        let retry: Option<(String, String)> = tx
            .query_row(
                "SELECT request,body FROM builder_draft_revisions WHERE id=?1 AND request_id=?2",
                params![input.id, input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((old, body)) = retry {
            if old != request {
                bail!("Builder draft request identity conflict")
            }
            return Ok(serde_json::from_str(&body)?);
        }
        let previous: Option<String> = tx.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [&input.id], |r| r.get(0)).optional()?;
        let prior: Option<Value> = previous.map(|s| serde_json::from_str(&s)).transpose()?;
        let revision = prior
            .as_ref()
            .and_then(|v| v["revision"].as_u64())
            .unwrap_or(0);
        if revision != input.expected_revision {
            bail!("Builder draft revision conflict")
        }
        if prior.as_ref().is_some_and(|v| v["status"] == "revoked") {
            bail!("Builder draft revoked")
        }
        if input.builder_operation.is_some() && input.host_inspection.is_some() {
            bail!("conflicting Builder write actors")
        }
        let identity = input
            .builder_operation
            .as_ref()
            .or_else(|| input.host_inspection.as_ref().map(|i| &i.operation));
        let actor = match identity {
            Some(identity) => super::builder_authority::authorize(
                &tx,
                identity,
                prior
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("Builder cannot create owner draft"))?,
                &input,
            )?,
            None => json!({"kind":"human","id":"local_owner"}),
        };
        let next = revision
            .checked_add(1)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(|| anyhow::anyhow!("Builder draft revision exhausted"))?;
        let at = now();
        let body = json!({"schema_version":1,"id":input.id,"revision":next,"home_hub":self.node_id,
            "status":if input.revoked {"revoked"} else {"draft"},"eligible_for_execution":false,
            "actor":actor,"request_id":input.request_id,
            "created_at":prior.as_ref().map(|v|v["created_at"].clone()).unwrap_or(json!(at)),
            "updated_at":at,"interview":input.interview});
        tx.execute("INSERT INTO builder_draft_revisions(id,revision,request_id,request,body) VALUES (?1,?2,?3,?4,?5)",
            params![input.id,next,input.request_id,request,serde_json::to_string(&body)?])?;
        Ok(body)
    }
    pub fn builder_draft(&self, id: &str) -> Result<Option<Value>> {
        if !valid_id(id) {
            bail!("invalid Builder draft identity")
        }
        let body: Option<String> = self.db.lock().query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [id], |r| r.get(0)).optional()?;
        body.map(|v| Ok(serde_json::from_str(&v)?)).transpose()
    }
}
