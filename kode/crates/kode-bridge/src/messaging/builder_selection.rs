//! Owner-selected Builder runtime intent, separate from executable grants and funding.
use super::{model::valid_id, store::Store, teams::WorkspaceRef};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub profile_id: String,
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub workspace: WorkspaceRef,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Save {
    pub request_id: String,
    pub expected_revision: u64,
    pub draft_revision: u64,
    pub selection: Selection,
}
fn text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0')
}
impl Store {
    pub fn builder_selection(&self, id: &str) -> Result<Value> {
        if !valid_id(id) {
            bail!("invalid Builder draft identity")
        }
        let db = self.db.lock();
        let draft: String = db.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )?;
        let draft: Value = serde_json::from_str(&draft)?;
        let body: Option<String> = db
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [format!("builder-selection:{id}")],
                |r| r.get(0),
            )
            .optional()?;
        let record: Option<Value> = body.map(|s| serde_json::from_str(&s)).transpose()?;
        Ok(
            json!({"home_hub":self.node_id,"draft_id":id,"draft_revision":draft["revision"],"draft_status":draft["status"],"record":record,"eligible_for_execution":false}),
        )
    }
    pub fn save_builder_selection(&self, id: &str, input: Save) -> Result<Value> {
        let s = &input.selection;
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&s.profile_id)
            || !text(&s.provider)
            || !text(&s.model)
            || s.effort.as_ref().is_some_and(|v| !text(v))
            || input.draft_revision == 0
            || input.expected_revision >= 9007199254740991
            || !valid_id(&s.workspace.host_id)
            || !valid_id(&s.workspace.workspace_id)
            || !text(&s.workspace.root_ref)
        {
            bail!("invalid Builder selection")
        }
        let request = serde_json::to_value(&input)?;
        let key = format!("builder-selection:{id}");
        let receipt_key = format!(
            "builder-selection-command:{}",
            json!([id, input.request_id])
        );
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&receipt_key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            let previous: Value = serde_json::from_str(&previous)?;
            if previous["request"] != request {
                bail!("Builder selection request identity conflict")
            }
            return Ok(previous["receipt"].clone());
        }
        let body: String = tx.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )?;
        let draft: Value = serde_json::from_str(&body)?;
        if draft["status"] != "draft" || draft["revision"].as_u64() != Some(input.draft_revision) {
            bail!("Builder draft revoked or revision conflict")
        }
        let workspace = serde_json::to_value(&s.workspace)?;
        if !draft["interview"]["workspace_refs"]
            .as_array()
            .is_some_and(|refs| refs.contains(&workspace))
        {
            bail!("Builder workspace not selected in draft")
        }
        let revision: Option<u64> = tx
            .query_row(
                "SELECT revision FROM workbench_documents WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if revision.unwrap_or(0) != input.expected_revision {
            bail!("Builder selection revision conflict")
        }
        let revision = input.expected_revision + 1;
        let receipt = json!({"home_hub":self.node_id,"draft_id":id,"draft_revision":input.draft_revision,"revision":revision,"request_id":input.request_id,"selection":input.selection,"eligible_for_execution":false});
        tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value", params![key,revision,serde_json::to_string(&receipt)?])?;
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                receipt_key,
                serde_json::to_string(&json!({"request":request,"receipt":receipt}))?
            ],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
}

/// Validate the confirmed runtime intent in the same transaction that reserves funding.
/// Exact historical start receipts are recovered before this current-state check.
pub(super) fn validate_start_selection(
    tx: &rusqlite::Transaction,
    input: &super::builder_start::Request,
    reference: &super::builder_start::SelectionRef,
) -> Result<()> {
    let body: String = tx.query_row(
        "SELECT value FROM workbench_documents WHERE key=?1",
        [format!("builder-selection:{}", input.draft_id)],
        |r| r.get(0),
    )?;
    let selected: Value = serde_json::from_str(&body)?;
    if reference.revision == 0
        || reference.draft_revision == 0
        || reference.draft_revision.checked_add(1) != Some(input.draft_revision)
        || selected["revision"].as_u64() != Some(reference.revision)
        || selected["draft_revision"].as_u64() != Some(reference.draft_revision)
    {
        bail!("Builder selection revision conflict")
    }
    let choice = &selected["selection"];
    let op = &input.operation;
    let target = &op.grant_scope.target;
    if choice["provider"] != reference.provider
        || choice["model"] != op.selection_policy.model
        || choice["effort"] != serde_json::to_value(&op.selection_policy.effort)?
        || choice["profile_id"] != op.resource.profile
        || choice["workspace"]["host_id"] != target.host
        || choice["workspace"]["workspace_id"] != target.workspace
        || choice["workspace"]["root_ref"] != target.root
    {
        bail!("Builder start differs from confirmed selection")
    }
    let old: String = tx.query_row(
        "SELECT body FROM builder_draft_revisions WHERE id=?1 AND revision=?2",
        params![input.draft_id, reference.draft_revision],
        |r| r.get(0),
    )?;
    let current: String = tx.query_row(
        "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
        [&input.draft_id],
        |r| r.get(0),
    )?;
    let old: Value = serde_json::from_str(&old)?;
    let current: Value = serde_json::from_str(&current)?;
    if current["status"] != "draft" || current["revision"].as_u64() != Some(input.draft_revision) {
        bail!("Builder selection draft changed")
    }
    let mut before = old["interview"].clone();
    let mut after = current["interview"].clone();
    // Legacy empty interviews acquire their questionnaire during initialization.
    if before["questionnaire"].is_null() {
        for value in [&mut before, &mut after] {
            if let Some(fields) = value.as_object_mut() {
                fields.remove("questionnaire");
                fields.remove("questions");
            }
        }
    }
    if before != after {
        bail!("Builder selection draft changed")
    }
    Ok(())
}
