//! Owner-confirmed immutable optimization target. Creating a draft grants no execution.
use super::super::{
    model::{now, valid_id},
    store::Store,
    teams,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub draft_id: String,
    pub request_id: String,
    pub team_revision: u64,
    pub purpose: String,
}
fn key(id: &str) -> String {
    format!("builder-optimization:{id}")
}
fn read(db: &Connection, id: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(id)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn current(db: &Connection, id: &str) -> Result<Option<u64>> {
    Ok(db
        .query_row("SELECT revision FROM teams WHERE id=?1", [id], |r| r.get(0))
        .optional()?)
}
pub(super) fn enrich(db: &Connection, draft: &mut Value, detail: bool) -> Result<()> {
    if let Some(receipt) = read(db, draft["id"].as_str().unwrap_or(""))? {
        let mut target = receipt["optimization_target"].clone();
        let revision = current(
            db,
            target["team_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid optimization target"))?,
        )?;
        target["current_team_revision"] = json!(revision);
        target["status"] = json!(
            if revision.is_some() && json!(revision) == target["team_revision"] {
                "current"
            } else {
                "stale"
            }
        );
        if !detail {
            target.as_object_mut().unwrap().remove("baseline_spec");
        }
        draft["optimization_target"] = target;
    }
    Ok(())
}
pub(crate) fn check_accept(db: &Connection, draft: &str, team: &str, revision: u64) -> Result<()> {
    if let Some(receipt) = read(db, draft)? {
        let target = &receipt["optimization_target"];
        if target["team_id"] != team || target["team_revision"].as_u64() != Some(revision) {
            bail!("optimization target mismatch: exact confirmed Team and revision required")
        }
        if current(db, team)? != Some(revision) {
            bail!("optimization target stale: create a new explicitly confirmed draft")
        }
    }
    Ok(())
}
impl Store {
    pub fn create_builder_optimization(&self, team: &str, input: Create) -> Result<Value> {
        if !valid_id(team)
            || !valid_id(&input.draft_id)
            || !valid_id(&input.request_id)
            || input.team_revision == 0
            || !super::text(&input.purpose, 8192)
        {
            bail!("invalid optimization draft request")
        }
        let request = json!({"team_id":team,"command":input});
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(receipt) = read(&tx, &input.draft_id)? {
            if receipt["request"] != request {
                bail!("optimization draft request identity conflict")
            }
            return Ok(receipt);
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM builder_draft_revisions WHERE id=?1)",
            [&input.draft_id],
            |r| r.get(0),
        )?;
        if exists {
            bail!("optimization requires a new draft identity")
        }
        if current(&tx, team)? != Some(input.team_revision) {
            bail!("optimization target unknown or stale: confirm the current Team revision")
        }
        let body: String = tx.query_row(
            "SELECT body FROM team_revisions WHERE team_id=?1 AND revision=?2",
            params![team, input.team_revision],
            |r| r.get(0),
        )?;
        let team_body: Value = serde_json::from_str(&body)?;
        // Typed Spec is configuration only: reference IDs, roles and limits. Never
        // copy the Team envelope, sessions, transcripts, secrets or grant bodies.
        let spec: teams::Spec = serde_json::from_value(team_body["spec"].clone())?;
        let target = json!({"team_id":team,"team_revision":input.team_revision,
            "source":"owner_confirmed_optimization","baseline_spec":spec,
            "actor":{"kind":"human","id":"local_owner"},"confirmed_at":now()});
        let save = serde_json::from_value(
            json!({"id":input.draft_id,"request_id":input.request_id,
            "expected_revision":0,"revoked":false,"interview":{"purpose":input.purpose,
            "workspace_refs":spec.workspace_refs,"answers":{},"questions":[],"proposed_team":null}}),
        )?;
        // expected_revision=0 rejects any pre-existing draft, including a revoked one.
        let draft = self.save_builder_draft_in(&tx, save)?;
        let receipt = json!({"request":request,"draft":draft,"optimization_target":target,
            "model_started":false,"activation_performed":false,"eligible_for_execution":false});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(&input.draft_id), receipt.to_string()],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
}

#[cfg(test)]
#[path = "builder_optimization_tests.rs"]
mod tests;
