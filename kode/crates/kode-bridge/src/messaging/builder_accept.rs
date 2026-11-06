//! Explicit owner acceptance links a frozen Builder proposal to a non-executable team draft.
use super::{
    builder_drafts::Interview,
    model::{now, valid_id},
    store::Store,
    teams,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Accept {
    pub request_id: String,
    pub expected_revision: u64,
    pub team_id: String,
    pub team_revision: u64,
}
fn key(draft: &str, request: &str) -> String {
    format!("builder-accept:{}", json!([draft, request]))
}
fn read(db: &Connection, draft: &str, request: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(draft, request)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
impl Store {
    pub fn builder_acceptance(&self, id: &str, request: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(request) {
            bail!("invalid Builder acceptance identity")
        }
        read(&self.db.lock(), id, request)
    }
    pub fn accept_builder_proposal(&self, id: &str, input: Accept) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.team_id)
            || input.expected_revision == 0
        {
            bail!("invalid Builder acceptance")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(prior) = read(&tx, id, &input.request_id)? {
            if prior["request"] != request {
                bail!("Builder acceptance request identity conflict")
            }
            return Ok(prior);
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
        let interview: Interview = serde_json::from_value(draft["interview"].clone())?;
        let spec = interview
            .proposed_team
            .ok_or_else(|| anyhow::anyhow!("Builder proposal missing"))?;
        if spec.workspace_refs.iter().any(|w| {
            !interview.workspace_refs.iter().any(|s| {
                s.host_id == w.host_id
                    && s.workspace_id == w.workspace_id
                    && s.root_ref == w.root_ref
            })
        }) {
            bail!("Builder proposal workspace outside selection")
        }
        let team_request = format!(
            "builder-{:x}",
            Sha256::digest(serde_json::to_vec(&json!([id, input.request_id]))?)
        );
        let team = self.save_team_in(
            &tx,
            teams::Save {
                id: input.team_id.clone(),
                request_id: team_request,
                expected_revision: input.team_revision,
                spec,
            },
        )?;
        let result = json!({"request":request,"draft_id":id,"draft_revision":input.expected_revision,"team":team,"home_hub":self.node_id,"actor":{"kind":"human","id":"local_owner"},"accepted_at":now(),"activation_performed":false,"eligible_for_execution":false});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(id, &input.request_id), serde_json::to_string(&result)?],
        )?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![input.team_id,serde_json::to_string(&json!({"kind":"builder_proposal_accepted","draft_id":id,"draft_revision":input.expected_revision,"request_id":input.request_id,"team_revision":result["team"]["revision"],"actor":result["actor"],"at":result["accepted_at"]}))?])?;
        tx.commit()?;
        Ok(result)
    }
}
