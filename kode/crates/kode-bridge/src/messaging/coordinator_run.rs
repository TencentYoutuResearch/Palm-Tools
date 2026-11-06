//! Coordinator requests reuse WorkRun creation; authority is checked inside its transaction.
use super::{
    builder_authority, coordinator_control, coordinator_input,
    model::{now, valid_id},
    operations::State,
    store::Store,
    work_runs,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    pub request_id: String,
    pub source_message_id: String,
    pub operation_id: String,
    pub control_revision: u64,
    pub attempt: u64,
    pub epoch: u64,
    pub binding_id: String,
    pub inputs: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_run_id: Option<String>,
}
fn run_id(conversation: &str, request: &str) -> String {
    format!(
        "coordinator-{:x}",
        Sha256::digest(serde_json::to_vec(&json!([conversation, request])).unwrap())
    )
}
pub(super) fn authorize(
    db: &Connection,
    home: &str,
    conversation: &str,
    input: &Start,
) -> Result<Value> {
    let source = coordinator_input::read(db, conversation, &input.source_message_id)?
        .ok_or_else(|| anyhow::anyhow!("Coordinator input missing"))?;
    if source["request"]
        != json!({"operation_id":input.operation_id,"control_revision":input.control_revision,"attempt":input.attempt,"epoch":input.epoch})
    {
        bail!("Coordinator workflow input binding mismatch")
    }
    if let Some(prior_id) = source["message"]["prior_run_id"].as_str() {
        if input.prior_run_id.as_deref() != Some(prior_id) {
            bail!("Coordinator must preserve the human follow-up reference")
        }
    }
    let team = source["message"]["team_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid source team"))?;
    let control = coordinator_control::current_in(db, team)?
        .ok_or_else(|| anyhow::anyhow!("Coordinator control missing"))?;
    if control["revision"] != input.control_revision
        || control["conversation_id"] != conversation
        || control["request"]["operation_id"] != input.operation_id
    {
        bail!("Coordinator workflow control changed")
    }
    let op = builder_authority::operation(db, &input.operation_id)?;
    let at = now();
    if op.state != State::Active
        || op.attempt != input.attempt
        || op.epoch != input.epoch
        || op.worker.node_id != home
        || op.lease_until.is_none_or(|t| t <= at)
    {
        bail!("Coordinator workflow requires active local lease")
    }
    super::operation_grant::admit(db, &op, at)?;
    super::operation_budget::admit(db, &op, at)?;
    if !super::resource_admission::admit(db, &op, at)?.allowed {
        bail!("Coordinator resource unavailable")
    }
    let grant = super::operation_grant::read(db, &op.id)?
        .ok_or_else(|| anyhow::anyhow!("Coordinator grant missing"))?;
    if !grant
        .scope
        .capabilities
        .contains(&super::team_grants::Capability::Delegate)
        || !grant
            .scope
            .tools
            .iter()
            .any(|t| t == "kode_coordinator_workflow_start")
    {
        bail!("Coordinator workflow delegation not granted")
    }
    let delivery = source["receipt"]["message_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid input receipt"))?;
    let consumed:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM runtime_deliveries WHERE message_id=?1 AND session=?2 AND phase=2)",params![delivery,op.worker.session_id],|r|r.get(0))?;
    if !consumed {
        bail!("Coordinator input consumption not confirmed")
    }
    Ok(
        json!({"conversation_id":conversation,"source_message_id":input.source_message_id,"source_delivery_id":delivery,"operation_id":op.id,"control_revision":input.control_revision,"attempt":input.attempt,"epoch":input.epoch,"superagent_id":control["superagent_id"]}),
    )
}
impl Store {
    pub fn start_coordinator_run(&self, conversation: &str, input: Start) -> Result<Value> {
        if ![
            conversation,
            &input.request_id,
            &input.source_message_id,
            &input.operation_id,
            &input.binding_id,
        ]
        .iter()
        .all(|s| valid_id(s))
            || input.control_revision == 0
            || input.attempt == 0
            || input.epoch == 0
        {
            bail!("invalid Coordinator workflow request")
        }
        let source =
            coordinator_input::read(&self.db.lock(), conversation, &input.source_message_id)?
                .ok_or_else(|| anyhow::anyhow!("Coordinator input missing"))?;
        let id = run_id(conversation, &input.request_id);
        let create = work_runs::Create {
            id: id.clone(),
            request_id: id,
            team_id: source["message"]["team_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid source team"))?
                .into(),
            team_revision: source["message"]["team_revision"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("invalid source revision"))?,
            binding_id: input.binding_id.clone(),
            inputs: input.inputs.clone(),
            prior_run_id: input.prior_run_id.clone(),
        };
        self.create_work_run_scoped(create, Some((conversation, &input)))
    }
    pub fn coordinator_run_receipt(
        &self,
        conversation: &str,
        request: &str,
    ) -> Result<Option<Value>> {
        if !valid_id(conversation) || !valid_id(request) {
            bail!("invalid Coordinator workflow receipt")
        }
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT initial_body FROM work_runs WHERE id=?1",
                [run_id(conversation, request)],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|s| {
            let row: Value = serde_json::from_str(&s)?;
            if row["coordinator"]["conversation_id"] != conversation {
                bail!("Coordinator workflow receipt conflict")
            };
            Ok(row)
        })
        .transpose()
    }
}
