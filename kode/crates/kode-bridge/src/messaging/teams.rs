//! Home-owned team drafts. Stable identity is separate from sessions; saving never activates execution.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceRef {
    pub host_id: String,
    pub workspace_id: String,
    pub root_ref: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub id: String,
    pub host_id: String,
    pub executor_profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_profile_revision: Option<String>,
    pub provider_id: String,
    pub model_id: String,
    pub effort: Option<String>,
    pub account_binding_id: String,
    pub capability_profile_revision: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Worker {
    pub id: String,
    pub role: String,
    pub responsibilities: Vec<String>,
    pub allowed_target_ids: Vec<String>,
    pub required_capabilities: Vec<String>,
    pub workspace_refs: Vec<WorkspaceRef>,
    pub max_parallel: u16,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkflowRef {
    pub id: String,
    pub version: String,
    pub hash: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryBinding {
    pub id: String,
    pub workflow: WorkflowRef,
    pub project: WorkflowRef,
    pub delivery_policy: WorkflowRef,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub max_active_assignments: u16,
    pub max_active_runs: u16,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Builder,
    Coordinator,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Proactive {
    Off,
    Observe,
    Auto,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoordinatorStartup {
    pub workspace_id: String,
    pub task_tag: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    pub name: String,
    pub purpose: String,
    pub kind: Kind,
    pub workspace_refs: Vec<WorkspaceRef>,
    pub execution_targets: Vec<Target>,
    pub workers: Vec<Worker>,
    pub coordinator_targets: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinator_startup: Option<CoordinatorStartup>,
    pub workflow_pack_refs: Vec<WorkflowRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delivery_bindings: Vec<DeliveryBinding>,
    pub grant_id: Option<String>,
    pub budget_policy_id: Option<String>,
    pub scheduling_policy_id: Option<String>,
    pub limits: Limits,
    pub proactive_mode: Proactive,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Save {
    pub id: String,
    pub request_id: String,
    pub expected_revision: u64,
    pub spec: Spec,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    #[serde(default)]
    pub after: String,
    pub limit: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectoryPage {
    #[serde(default)]
    pub after: String,
    pub limit: Option<usize>,
    pub q: Option<String>,
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.contains('\0')
}
fn workspace(w: &WorkspaceRef) -> bool {
    valid_id(&w.host_id) && valid_id(&w.workspace_id) && text(&w.root_ref, 1024)
}
fn workspace_key(w: &WorkspaceRef) -> (&str, &str, &str) {
    (&w.host_id, &w.workspace_id, &w.root_ref)
}
impl Spec {
    pub(super) fn validate(&self) -> Result<()> {
        if !text(&self.name, 160)
            || !text(&self.purpose, 8192)
            || self.workspace_refs.len() > 64
            || self.execution_targets.len() > 64
            || self.workers.len() > 64
            || self.workflow_pack_refs.len() > 32
            || self.delivery_bindings.len() > 64
            || self.coordinator_targets.len() > 64
            || !(1..=256).contains(&self.limits.max_active_assignments)
            || !(1..=64).contains(&self.limits.max_active_runs)
        {
            bail!("invalid team draft bounds")
        }
        let mut workspaces = HashSet::new();
        for w in &self.workspace_refs {
            if !workspace(w) || !workspaces.insert(workspace_key(w)) {
                bail!("invalid or duplicate team workspace")
            }
        }
        if let Some(startup) = &self.coordinator_startup {
            if self.kind != Kind::Coordinator
                || !valid_id(&startup.workspace_id)
                || !text(&startup.task_tag, 160)
                || !self
                    .workspace_refs
                    .iter()
                    .any(|w| w.workspace_id == startup.workspace_id)
            {
                bail!("invalid Coordinator startup configuration")
            }
        }
        let mut targets = HashSet::new();
        for t in &self.execution_targets {
            if !valid_id(&t.id)
                || !targets.insert(t.id.as_str())
                || !valid_id(&t.host_id)
                || !valid_id(&t.executor_profile_id)
                || t.executor_profile_revision.as_ref().is_some_and(|r| {
                    r.len() != 64
                        || !r
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                })
                || !text(&t.provider_id, 256)
                || !text(&t.model_id, 256)
                || t.effort.as_ref().is_some_and(|v| !text(v, 64))
                || !text(&t.account_binding_id, 256)
                || !text(&t.capability_profile_revision, 256)
            {
                bail!("invalid or duplicate execution target")
            }
        }
        let valid_targets = |ids: &[String]| {
            ids.len() <= 64
                && ids.iter().all(|id| targets.contains(id.as_str()))
                && ids.iter().collect::<HashSet<_>>().len() == ids.len()
        };
        if !valid_targets(&self.coordinator_targets) {
            bail!("unknown or duplicate coordinator target")
        }
        let mut workers = HashSet::new();
        for w in &self.workers {
            if !valid_id(&w.id)
                || !workers.insert(&w.id)
                || !text(&w.role, 160)
                || w.responsibilities.len() > 32
                || w.responsibilities.iter().any(|r| !text(r, 2048))
                || !valid_targets(&w.allowed_target_ids)
                || w.required_capabilities.len() > 32
                || w.required_capabilities.iter().any(|c| !valid_id(c))
                || w.workspace_refs.len() > 64
                || w.workspace_refs
                    .iter()
                    .any(|r| !workspaces.contains(&workspace_key(r)))
                || !(1..=64).contains(&w.max_parallel)
            {
                bail!("invalid worker or reference outside team draft")
            }
        }
        let mut workflows = HashSet::new();
        for w in &self.workflow_pack_refs {
            if !valid_id(&w.id)
                || !text(&w.version, 128)
                || w.hash.len() != 64
                || !w.hash.bytes().all(|v| v.is_ascii_hexdigit())
                || !workflows.insert((&w.id, &w.version))
            {
                bail!("invalid or duplicate workflow reference")
            }
        }
        let mut bindings = HashSet::new();
        for binding in &self.delivery_bindings {
            if !valid_id(&binding.id) || !bindings.insert(&binding.id) {
                bail!("invalid or duplicate delivery binding");
            }
            for reference in [
                &binding.workflow,
                &binding.project,
                &binding.delivery_policy,
            ] {
                if !valid_id(&reference.id)
                    || !valid_id(&reference.version)
                    || reference.hash.len() != 64
                    || !reference
                        .hash
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                {
                    bail!("invalid delivery binding reference");
                }
            }
            if !self.workflow_pack_refs.contains(&binding.workflow) {
                bail!("delivery workflow is outside team workflow references");
            }
        }
        for id in [
            &self.grant_id,
            &self.budget_policy_id,
            &self.scheduling_policy_id,
        ]
        .into_iter()
        .flatten()
        {
            if !valid_id(id) {
                bail!("invalid team policy reference")
            }
        }
        if serde_json::to_vec(self)?.len() > 65536 {
            bail!("team draft exceeds size limit")
        }
        Ok(())
    }
}
impl Store {
    pub fn save_team(&self, input: Save) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = self.save_team_in(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub(super) fn save_team_in(&self, tx: &rusqlite::Transaction, input: Save) -> Result<Value> {
        if !valid_id(&input.id) || !valid_id(&input.request_id) {
            bail!("invalid team command identity")
        }
        input.spec.validate()?;
        let request = serde_json::to_string(&input)?;
        let retry: Option<(String, String)> = tx
            .query_row(
                "SELECT request,body FROM team_revisions WHERE team_id=?1 AND request_id=?2",
                params![input.id, input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((old, body)) = retry {
            if old != request {
                bail!("team request identity conflict")
            }
            return Ok(serde_json::from_str(&body)?);
        }
        let previous:Option<(u64,String)>=tx.query_row("SELECT revision,body FROM team_revisions WHERE team_id=?1 ORDER BY revision DESC LIMIT 1",[&input.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let revision = previous.as_ref().map(|v| v.0).unwrap_or(0);
        if revision != input.expected_revision {
            bail!("team revision conflict")
        }
        let prior = previous
            .map(|(_, body)| serde_json::from_str::<Value>(&body))
            .transpose()?;
        if prior
            .as_ref()
            .is_some_and(|p| p["spec"]["kind"] != json!(input.spec.kind))
        {
            bail!("team kind is immutable")
        }
        let revision = revision
            .checked_add(1)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(|| anyhow::anyhow!("team revision exhausted"))?;
        let superagent_id = prior
            .as_ref()
            .map(|p| p["superagent_id"].clone())
            .unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string()));
        let conversation_id = prior
            .as_ref()
            .map(|p| p["conversation_id"].clone())
            .unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string()));
        let created_at = prior
            .as_ref()
            .map(|p| p["created_at"].clone())
            .unwrap_or_else(|| json!(now()));
        let at = now();
        let row = json!({"schema_version":1,"id":input.id,"revision":revision,"home_hub":self.node_id,
            "owner":{"kind":"human","id":"local_owner"},"superagent_id":superagent_id,"conversation_id":conversation_id,
            "created_at":created_at,"updated_at":at,"status":"draft","active_revision":null,"eligible_for_execution":false,
            "activation_requirements":["workflow_validation","resource_coverage","workspace_and_grant","budget_and_scheduling","human_activation"],"spec":input.spec});
        let body = serde_json::to_string(&row)?;
        tx.execute("INSERT INTO team_revisions(team_id,revision,request_id,request,body) VALUES (?1,?2,?3,?4,?5)",params![input.id,revision,input.request_id,request,body])?;
        tx.execute("INSERT INTO teams(id,revision,superagent_id,conversation_id) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",params![input.id,revision,row["superagent_id"].as_str(),row["conversation_id"].as_str()])?;
        tx.execute("INSERT INTO team_events(team_id,body) VALUES (?1,?2)",params![input.id,serde_json::to_string(&json!({"kind":"team_draft_saved","team_id":input.id,"revision":revision,"request_id":input.request_id,"actor":{"kind":"human","id":"local_owner"},"home_hub":self.node_id,"at":at}))?])?;
        Ok(row)
    }
    pub fn team(&self, id: &str, revision: Option<u64>) -> Result<Option<Value>> {
        let db = self.db.lock();
        let body:Option<String>=match revision {
            Some(rev)=>db.query_row("SELECT body FROM team_revisions WHERE team_id=?1 AND revision=?2",params![id,rev],|r|r.get(0)).optional()?,
            None=>db.query_row("SELECT r.body FROM teams t JOIN team_revisions r ON r.team_id=t.id AND r.revision=t.revision WHERE t.id=?1",[id],|r|r.get(0)).optional()?,
        };
        body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub fn team_events(&self, id: &str, after: u64) -> Result<Value> {
        let db = self.db.lock();
        let mut query = db.prepare(
            "SELECT seq,body FROM team_events WHERE team_id=?1 AND seq>?2 ORDER BY seq LIMIT 200",
        )?;
        let events = query
            .query_map(params![id, after], |r| {
                Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?))
            })?
            .map(|row| {
                let (seq, body) = row?;
                Ok(json!({"seq":seq,"data":serde_json::from_str::<Value>(&body)?}))
            })
            .collect::<Result<Vec<_>>>()?;
        let next = events
            .last()
            .and_then(|v| v["seq"].as_u64())
            .unwrap_or(after);
        Ok(json!({"events":events,"next_cursor":next}))
    }
    pub fn teams(&self, page: Page) -> Result<Value> {
        self.search_teams(page, None)
    }
    pub fn search_teams(&self, page: Page, search: Option<String>) -> Result<Value> {
        let search = search.unwrap_or_default();
        if search.len() > 160 || search.contains('\0') {
            bail!("invalid team search")
        }
        let search = search.trim();
        let limit = page.limit.unwrap_or(25);
        if limit == 0 || limit > 50 || page.after.len() > 256 {
            bail!("invalid team page")
        }
        let db = self.db.lock();
        let mut query=db.prepare("SELECT r.body FROM teams t JOIN team_revisions r ON r.team_id=t.id AND r.revision=t.revision WHERE t.id>?1 AND (?3='' OR instr(lower(json_extract(r.body,'$.spec.name')),lower(?3))>0 OR instr(lower(json_extract(r.body,'$.spec.purpose')),lower(?3))>0) ORDER BY t.id LIMIT ?2")?;
        let mut items = query
            .query_map(params![page.after, limit + 1, search], |r| {
                r.get::<_, String>(0)
            })?
            .map(|row| Ok(serde_json::from_str::<Value>(&row?)?))
            .collect::<Result<Vec<_>>>()?;
        let more = items.len() > limit;
        items.truncate(limit);
        let next = if more {
            items.last().map(|v| v["id"].clone())
        } else {
            None
        };
        Ok(json!({"items":items,"next_cursor":next,"home_hub":self.node_id}))
    }
}
