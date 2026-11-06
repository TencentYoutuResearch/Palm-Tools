//! Owner-bound draft scope; writes recheck lease, budget and grant in the draft transaction.
use super::{
    model::{now, valid_id},
    operations::{Operation, State},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub id: String,
    pub attempt: u64,
    pub epoch: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attach {
    pub expected_revision: u64,
    pub attempt: u64,
    pub epoch: u64,
    pub draft_id: String,
    pub draft_revision: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostInspection {
    pub operation: Identity,
    pub workspace_id: String,
    pub paths: Vec<String>,
}
fn key(id: &str, attempt: u64) -> String {
    format!("builder-scope:{}", json!([id, attempt]))
}
pub(super) fn operation(db: &Connection, id: &str) -> Result<Operation> {
    let body: String = db.query_row("SELECT body FROM operations WHERE id=?1", [id], |r| {
        r.get(0)
    })?;
    Ok(serde_json::from_str(&body)?)
}
pub(super) fn scope(db: &Connection, id: &str, attempt: u64) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(id, attempt)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|v| Ok(serde_json::from_str(&v)?)).transpose()
}
impl Store {
    pub fn builder_scope(&self, id: &str) -> Result<Option<Value>> {
        if !valid_id(id) {
            bail!("invalid Builder operation identity")
        }
        let db = self.db.lock();
        let op = operation(&db, id)?;
        scope(&db, id, op.attempt)
    }
    pub fn bind_builder_scope(&self, id: &str, input: Attach) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = bind_in(&tx, &self.node_id, id, input)?;
        tx.commit()?;
        Ok(result)
    }
}
pub(super) fn bind_in(tx: &Connection, node_id: &str, id: &str, input: Attach) -> Result<Value> {
    if !valid_id(id)
        || !valid_id(&input.draft_id)
        || input.attempt == 0
        || input.epoch == 0
        || input.draft_revision == 0
    {
        bail!("invalid Builder scope")
    }
    let request = serde_json::to_value(&input)?;
    if let Some(old) = scope(&tx, id, input.attempt)? {
        if old["request"] != request {
            bail!("Builder scope is immutable")
        }
        return Ok(old);
    }
    let op = operation(&tx, id)?;
    if super::coordinator_control::bound(tx, id)? {
        bail!("Coordinator operation cannot become Builder")
    }
    if op.state != State::Prepared
        || op.revision != input.expected_revision
        || op.attempt != input.attempt
        || op.epoch != input.epoch
        || op.worker.node_id != node_id
        || !op.budget_required
        || !op.grant_required
    {
        bail!("Builder scope requires exact prepared budgeted local operation")
    }
    let body: String = tx.query_row(
        "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
        [&input.draft_id],
        |r| r.get(0),
    )?;
    let draft: Value = serde_json::from_str(&body)?;
    if draft["revision"].as_u64() != Some(input.draft_revision) || draft["status"] != "draft" {
        bail!("Builder draft revision conflict")
    }
    let row = json!({"operation_id":id,"request":request,"worker":op.worker,"home_hub":node_id,"workspaces":draft["interview"]["workspace_refs"],"created_at":now(),"actor":{"kind":"human","id":"local_owner"}});
    tx.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![key(id, input.attempt), serde_json::to_string(&row)?],
    )?;
    Ok(row)
}

pub(super) fn authorize(
    db: &Connection,
    identity: &Identity,
    prior: &Value,
    input: &super::builder_drafts::Save,
) -> Result<Value> {
    if !valid_id(&identity.id) || identity.attempt == 0 || identity.epoch == 0 {
        bail!("invalid Builder operation identity")
    }
    let op = operation(db, &identity.id)?;
    let at = now();
    if op.state != State::Active
        || op.attempt != identity.attempt
        || op.epoch != identity.epoch
        || op.lease_until.is_none_or(|until| until <= at)
        || !op.budget_required
        || !op.grant_required
    {
        bail!("Builder operation is not active and authorized")
    }
    let fixed = scope(db, &identity.id, identity.attempt)?
        .ok_or_else(|| anyhow::anyhow!("Builder scope missing"))?;
    if fixed["request"]["draft_id"] != input.id
        || fixed["request"]["epoch"].as_u64() != Some(identity.epoch)
        || fixed["workspaces"] != prior["interview"]["workspace_refs"]
    {
        bail!("Builder draft scope changed")
    }
    super::operation_budget::admit(db, &op, at)?;
    super::operation_grant::admit(db, &op, at)?;
    if op.resource_required && !super::resource_admission::admit(db, &op, at)?.allowed {
        bail!("Builder resource unavailable")
    }
    let grant = super::operation_grant::read(db, &op.id)?
        .ok_or_else(|| anyhow::anyhow!("Builder grant missing"))?;
    if !grant
        .scope
        .capabilities
        .contains(&super::team_grants::Capability::BuilderDraftWrite)
        || !grant.scope.tools.iter().any(|t| {
            t == if input.host_inspection.is_some() {
                "kode_builder_inspect_workspace"
            } else {
                "kode_builder_save_draft"
            }
        })
    {
        bail!("Builder draft write permission missing")
    }
    let next = serde_json::to_value(&input.interview)?;
    let protected = if input.host_inspection.is_some() {
        vec![
            "purpose",
            "workspace_refs",
            "answers",
            "questionnaire",
            "questions",
            "proposed_team",
            "proposed_workflow",
        ]
    } else {
        vec![
            "purpose",
            "workspace_refs",
            "answers",
            "questionnaire",
            "inspections",
        ]
    };
    for field in protected {
        if next[field] != prior["interview"][field] {
            bail!("Builder cannot change owner answers, scope or observations")
        }
    }
    if let Some(observation) = &input.host_inspection {
        validate_inspection(
            &op,
            &serde_json::to_value(&grant.scope.target)?,
            prior,
            &next,
            observation,
        )?;
    }
    if input.revoked {
        bail!("Builder cannot revoke owner draft")
    }
    if let Some(spec) = &input.interview.proposed_team {
        spec.validate()?;
        if spec.workspace_refs.iter().any(|w| {
            !input.interview.workspace_refs.iter().any(|s| {
                s.host_id == w.host_id
                    && s.workspace_id == w.workspace_id
                    && s.root_ref == w.root_ref
            })
        }) {
            bail!("Builder proposed workspace outside selected scope")
        }
    }
    let mut actor = json!({"kind":"builder","session_id":op.worker.session_id,"node_id":op.worker.node_id,"operation_id":op.id,"attempt":op.attempt,"epoch":op.epoch});
    if let Some(observation) = &input.host_inspection {
        actor["kind"] = json!("host_inspection");
        actor["selection"] = serde_json::to_value(observation)?;
    }
    Ok(actor)
}

fn validate_inspection(
    op: &Operation,
    target: &Value,
    prior: &Value,
    next: &Value,
    selection: &HostInspection,
) -> Result<()> {
    let allowed = crate::project_inspection::SELECTORS;
    if !valid_id(&selection.workspace_id)
        || selection.paths.is_empty()
        || selection.paths.len() > 8
        || selection
            .paths
            .iter()
            .any(|p| !allowed.contains(&p.as_str()))
        || selection
            .paths
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != selection.paths.len()
    {
        bail!("invalid Host inspection selection")
    }
    let before = prior["interview"]["inspections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let after = next["inspections"].as_array().cloned().unwrap_or_default();
    let selected = |row: &&Value| {
        row["workspace"]["host_id"] == op.worker.node_id
            && row["workspace"]["workspace_id"] == selection.workspace_id
    };
    let observed = after
        .iter()
        .find(selected)
        .ok_or_else(|| anyhow::anyhow!("Host observation missing"))?;
    if target["host"] != op.worker.node_id
        || target["workspace"] != selection.workspace_id
        || target["root"] != observed["workspace"]["root_ref"]
    {
        bail!("Host inspection outside granted workspace")
    }
    let old = before.iter().find(selected);
    let old_facts = old
        .and_then(|r| r["facts"].as_array())
        .cloned()
        .unwrap_or_default();
    let facts = observed["facts"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Host observation facts missing"))?;
    let in_selection = |fact: &Value| {
        let path = fact["path"].as_str().unwrap_or_default();
        selection.paths.iter().any(|selected| {
            path == selected || (crate::project_inspection::directory_selector(selected)
                && path.starts_with(&format!("{selected}/")))
        })
    };
    let untouched = |rows: &[Value]| {
        rows.iter()
            .filter(|r| !in_selection(r))
            .cloned()
            .collect::<Vec<_>>()
    };
    for selected in &selection.paths {
        let complete = facts.iter().any(|fact| fact["path"] == *selected
            && (fact["status"] == "directory_scanned" || fact["status"] == "missing"));
        if !complete && old_facts.iter().any(|old| {
            old["path"].as_str().is_some_and(|path| path.starts_with(&format!("{selected}/")))
                && !facts.iter().any(|fact| fact["path"] == old["path"])
        }) { bail!("partial Host inspection cannot remove prior observations") }
    }
    if selection
        .paths
        .iter()
        .any(|p| !facts.iter().any(|f| f["path"] == *p))
        || untouched(&old_facts) != untouched(facts)
        || before.iter().filter(|r| !selected(r)).collect::<Vec<_>>()
            != after.iter().filter(|r| !selected(r)).collect::<Vec<_>>()
    {
        bail!("Host inspection changed unselected observations")
    }
    Ok(())
}
