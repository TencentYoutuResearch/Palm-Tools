//! Atomic Builder funding and scope preparation. Owner policies already exist; no inference.
use super::{
    builder_authority,
    model::{now, valid_id},
    operation_bundle, pricing,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_ref: Option<SelectionRef>,
    pub draft_id: String,
    pub draft_revision: u64,
    pub price_id: String,
    pub operation: operation_bundle::Request,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionRef {
    pub revision: u64,
    pub draft_revision: u64,
    pub provider: String,
}
impl Store {
    pub fn prepare_builder_start(&self, input: Request) -> Result<Value> {
        if !valid_id(&input.draft_id)
            || !valid_id(&input.price_id)
            || input.draft_revision == 0
            || serde_json::to_vec(&input)?.len() > 65536
        {
            bail!("invalid Builder start request")
        }
        let request = serde_json::to_value(&input)?;
        let key = format!(
            "builder-start:{}",
            json!([input.operation.owner_session, input.operation.request_key])
        );
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            let prior: Value = serde_json::from_str(&prior)?;
            if prior["request"] != request {
                bail!("Builder start identity conflict")
            }
            return Ok(prior["result"].clone());
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE owner=?1 AND request_key=?2)",
            params![input.operation.owner_session, input.operation.request_key],
            |r| r.get(0),
        )?;
        if exists {
            bail!("Builder cannot adopt an existing operation")
        }
        if input.operation.worker.node_id != self.node_id {
            bail!("Builder must start on its home Hub")
        }
        if let Some(selected) = &input.selection_ref {
            super::builder_selection::validate_start_selection(&tx, &input, selected)?;
        }
        let body: String = tx.query_row(
            "SELECT body FROM price_versions WHERE id=?1",
            [&input.price_id],
            |r| r.get(0),
        )?;
        let price: pricing::Price = serde_json::from_str(&body)?;
        if price.model != input.operation.selection_policy.model
            || price.model_policy != pricing::ModelPolicy::RequestedModel
        {
            bail!("Builder requires matching requested-model pricing")
        }
        let target = &input.operation.grant_scope.target;
        let body: String = tx.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [&input.draft_id],
            |r| r.get(0),
        )?;
        let draft: Value = serde_json::from_str(&body)?;
        if !draft["interview"]["workspace_refs"]
            .as_array()
            .is_some_and(|refs| {
                refs.iter().any(|w| {
                    w["host_id"] == target.host
                        && w["workspace_id"] == target.workspace
                        && w["root_ref"] == target.root
                })
            })
        {
            bail!("Builder grant workspace is outside selected draft")
        }
        use super::team_grants::Capability;
        let tools = [
            "kode_builder_read_draft",
            "kode_builder_preflight",
            "kode_builder_inspect_workspace",
            "kode_builder_prepare_questions",
            "kode_builder_save_draft",
            "kode_builder_catalog",
            "kode_builder_policy_details",
        ];
        if !tools
            .iter()
            .all(|name| input.operation.grant_scope.tools.iter().any(|t| t == name))
        {
            bail!("complete Builder tool grant required")
        }
        if ![Capability::Read, Capability::BuilderDraftWrite]
            .iter()
            .all(|c| input.operation.grant_scope.capabilities.contains(c))
        {
            bail!("Builder read and draft-write capabilities required")
        }
        let bundle = operation_bundle::prepare_in(&tx, input.operation, now())?;
        let op = &bundle["operation"];
        let id = op["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("operation identity missing"))?;
        let pricing = pricing::bind_price_in(
            &tx,
            bundle["reservation"]["request"]["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("reservation missing"))?,
            &input.price_id,
        )?;
        let scope = builder_authority::bind_in(
            &tx,
            &self.node_id,
            id,
            builder_authority::Attach {
                expected_revision: op["revision"].as_u64().unwrap(),
                attempt: op["attempt"].as_u64().unwrap(),
                epoch: op["epoch"].as_u64().unwrap(),
                draft_id: input.draft_id,
                draft_revision: input.draft_revision,
            },
        )?;
        let result = json!({"bundle":bundle,"pricing":pricing,"scope":scope,"dispatch_state":"not_dispatched"});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key,
                serde_json::to_string(&json!({"request":request,"result":result}))?
            ],
        )?;
        tx.commit()?;
        Ok(result)
    }
}
