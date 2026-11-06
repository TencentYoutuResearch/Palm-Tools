//! Explicit owner confirmation creates a bounded creation budget and minimal Builder grant.
use super::{
    budgets,
    model::{now, valid_id},
    pricing,
    store::Store,
    team_grants,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    pub request_id: String,
    pub draft_revision: u64,
    pub selection_revision: u64,
    pub unit: String,
    pub limit: u64,
    pub starts_at: u64,
    pub ends_at: u64,
    pub input_per_million: u64,
    pub cached_per_million: u64,
    pub output_per_million: u64,
}
impl Store {
    pub fn builder_funding(&self, id: &str) -> Result<Value> {
        if !valid_id(id) {
            bail!("invalid Builder draft identity")
        }
        let db = self.db.lock();
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM builder_draft_revisions WHERE id=?1)",
            [id],
            |r| r.get(0),
        )?;
        if !exists {
            bail!("unknown Builder draft")
        }
        let body: Option<String> = db
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [format!("builder-funding:{id}")],
                |r| r.get(0),
            )
            .optional()?;
        let record: Option<Value> = body.map(|value| serde_json::from_str(&value)).transpose()?;
        Ok(
            json!({"home_hub":self.node_id,"draft_id":id,"record":record,"activation_performed":false}),
        )
    }
    pub fn confirm_builder_funding(&self, id: &str, input: Confirm) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.draft_revision == 0
            || input.selection_revision == 0
            || input.limit == 0
            || !valid_id(&input.unit)
        {
            bail!("invalid Builder funding confirmation")
        }
        let request = serde_json::to_value(&input)?;
        let key = format!("builder-funding:{id}");
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            let previous: Value = serde_json::from_str(&previous)?;
            if previous["request"] != request {
                bail!("Builder funding already configured; original confirmation required")
            }
            return Ok(previous);
        }
        let at = now();
        if input.starts_at > at || input.ends_at <= at {
            bail!("Builder funding period is not current")
        }
        let body: String = tx.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )?;
        let draft: Value = serde_json::from_str(&body)?;
        if draft["status"] != "draft" || draft["revision"].as_u64() != Some(input.draft_revision) {
            bail!("Builder draft revision conflict")
        }
        let body: String = tx.query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [format!("builder-selection:{id}")],
            |r| r.get(0),
        )?;
        let selection: Value = serde_json::from_str(&body)?;
        if selection["revision"].as_u64() != Some(input.selection_revision)
            || selection["draft_revision"].as_u64() != Some(input.draft_revision)
        {
            bail!("Builder selection revision conflict")
        }
        let workspace = &selection["selection"]["workspace"];
        if workspace["host_id"] != self.node_id
            || !draft["interview"]["workspace_refs"]
                .as_array()
                .is_some_and(|refs| refs.contains(workspace))
        {
            bail!("Builder workspace is not selected on home Hub")
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                self.node_id,
                id,
                input.request_id
            ]))?)
        );
        let scope_id = format!("builder-{}", &digest[..32]);
        let budget_id = format!("{scope_id}-budget");
        let budget = budgets::configure_in(
            &tx,
            budgets::Configure {
                id: budget_id.clone(),
                scope: budgets::Scope::Team,
                scope_id: scope_id.clone(),
                unit: input.unit.clone(),
                limit: input.limit,
                starts_at: input.starts_at,
                ends_at: input.ends_at,
                expected_revision: 0,
            },
            at,
        )?;
        let price = pricing::create_in(
            &tx,
            pricing::Price {
                id: format!("{scope_id}-price"),
                model: selection["selection"]["model"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("missing selected model"))?
                    .into(),
                unit: input.unit.clone(),
                model_policy: pricing::ModelPolicy::RequestedModel,
                input_per_million: input.input_per_million,
                cached_per_million: input.cached_per_million,
                output_per_million: input.output_per_million,
            },
        )?;
        let target = team_grants::Target {
            host: self.node_id.clone(),
            workspace: workspace["workspace_id"]
                .as_str()
                .unwrap_or_default()
                .into(),
            root: workspace["root_ref"].as_str().unwrap_or_default().into(),
        };
        let grant = team_grants::write_in(
            &tx,
            team_grants::Write {
                expected_revision: 0,
                policy: team_grants::Policy {
                    id: format!("{scope_id}-grant"),
                    team_id: scope_id,
                    enabled: true,
                    expires_at: input.ends_at,
                    targets: vec![target],
                    capabilities: vec![
                        team_grants::Capability::Read,
                        team_grants::Capability::BuilderDraftWrite,
                    ],
                    tools: [
                        "kode_builder_read_draft",
                        "kode_builder_preflight",
                        "kode_builder_inspect_workspace",
                        "kode_builder_prepare_questions",
                        "kode_builder_save_draft",
                        "kode_builder_catalog",
                        "kode_builder_policy_details",
                    ]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                    network: false,
                    budget_ids: vec![budget_id],
                },
            },
            at,
        )?;
        let result = json!({"home_hub":self.node_id,"draft_id":id,"request":request,"selection":selection,"budget":budget,"price":price,"grant":grant["grant"],"label":"团队预算","purpose":"builder_creation","activation_performed":false,"execution_started":false});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key, serde_json::to_string(&result)?],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
