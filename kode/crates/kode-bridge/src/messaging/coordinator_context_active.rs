//! Read-only Active ledger inspection. No lease creation, readiness transition,
//! scope-bound Host attestation, model/tool permission, or accounting admission.
use super::{
    coordinator_context_registry as registry, coordinator_control,
    model::{now, valid_id},
    operations::{Operation, State},
    runtime_host_enrollment as hosts,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Expectations detect stale reads; none of these fields confer authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Check {
    pub context_key: String,
    pub control_revision: u64,
    pub operation_id: String,
    pub current_operation_revision: u64,
    pub attempt: u64,
    pub epoch: u64,
    pub owner: String,
    pub session_id: String,
    pub journal_id: String,
    pub enrollment_id: String,
    pub boot_id: String,
}

pub(super) fn inspect_in(tx: &Transaction, home: &str, input: &Check) -> Result<Value> {
    if ![
        &input.operation_id,
        &input.owner,
        &input.session_id,
        &input.journal_id,
        &input.enrollment_id,
        &input.boot_id,
    ]
    .iter()
    .all(|id| valid_id(id))
        || input.control_revision == 0
        || input.current_operation_revision == 0
        || input.attempt == 0
        || input.epoch == 0
    {
        bail!("invalid scoped Active inspection identity")
    }
    let context = registry::read_in(tx, home, &input.context_key)?;
    let body: String = tx.query_row(
        "SELECT value FROM workbench_documents WHERE key=?1",
        [format!(
            "coordinator-context-control-v2:{}",
            json!(context.key)
        )],
        |r| r.get(0),
    )?;
    let control: Value = serde_json::from_str(&body)?;
    let binding: coordinator_control::Bind = serde_json::from_value(control["request"].clone())?;
    if control["context_key"] != context.key
        || control["context_scope"] != serde_json::to_value(&context.context_scope)?
        || control["home_hub"] != home
        || control["team_id"] != context.context_scope.team_id
        || control["revision"] != input.control_revision
        || control["journal_id"] != input.journal_id
        || binding.operation_id != input.operation_id
        || binding.attempt != input.attempt
        || binding.epoch != input.epoch
        || binding.team_revision != context.team_revision
        || binding.expected_revision != 0
        || control["runtime_ready"] != false
        || control["dispatch_state"] != "not_ready"
    {
        bail!("scoped Active control binding mismatch")
    }
    if coordinator_control::operation_binding(tx, &input.operation_id)?.as_ref() != Some(&control) {
        bail!("scoped Active operation fence changed")
    }
    let (op, _, at) = coordinator_control::inspect_active_policy_in(
        tx,
        home,
        &context.context_scope.team_id,
        &binding,
        input.current_operation_revision,
    )?;
    // Original prepared event, not a client-supplied owner or refreshed revision,
    // anchors identity to the exact operation revision accepted by the binding.
    let original:String=tx.query_row("SELECT json_extract(body,'$.operation') FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.operation.revision')=?2 AND json_extract(body,'$.operation.state')='prepared' ORDER BY seq DESC LIMIT 1",
        params![op.id,binding.operation_revision],|r|r.get(0))?;
    let original: Operation = serde_json::from_str(&original)?;
    if original.id != op.id
        || original.state != State::Prepared
        || original.revision != binding.operation_revision
        || original.owner != op.owner
        || original.worker != op.worker
        || original.attempt != op.attempt
        || original.epoch != op.epoch
        || op.owner != input.owner
        || op.worker.session_id != input.session_id
        || op.worker.session_id != format!("context-{}", context.key)
        || control["worker"] != serde_json::to_value(&op.worker)?
    {
        bail!("scoped Active original operation identity changed")
    }
    let reused:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE id!=?1 AND json_extract(body,'$.worker.node_id')=?2 AND json_extract(body,'$.worker.session_id')=?3)",params![op.id,op.worker.node_id,op.worker.session_id],|r|r.get(0))?;
    if reused {
        bail!("scoped Active session has another operation")
    }
    let enrollment = hosts::require_current_in(
        tx,
        home,
        &input.enrollment_id,
        &context.origin.host_id,
        &input.boot_id,
    )?;
    if enrollment.host_id != op.worker.node_id {
        bail!("scoped Active enrollment host mismatch")
    }
    let grant = super::operation_grant::read(tx, &op.id)?
        .ok_or_else(|| anyhow::anyhow!("scoped Active grant missing"))?;
    if grant.scope.target.host != context.origin.host_id
        || grant.scope.target.workspace != context.origin.workspace_id
        || grant.scope.target.root != context.origin.root_ref
    {
        bail!("scoped Active grant differs from exact origin")
    }
    super::assignment_admission::lease_gate(tx, &op.id, at)?;
    super::selection_evidence::admit(tx, &op)?;
    let budget_until = super::operation_budget::admit(tx, &op, at)?;
    let decision = super::operation_grant::validate_authority_in(tx, &op, at)?;
    let grant_until = decision["expires_at"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("scoped Active grant expiry missing"))?;
    let resource = super::resource_admission::admit(tx, &op, at)?;
    if !resource.allowed {
        bail!("scoped Active resource unavailable")
    }
    let lease_until = op
        .lease_until
        .ok_or_else(|| anyhow::anyhow!("scoped Active lease missing"))?;
    let effective_until = lease_until
        .min(budget_until)
        .min(grant_until)
        .min(resource.valid_until_ms.unwrap_or(u64::MAX));
    if effective_until <= now() {
        bail!("scoped Active authority expired")
    }
    let mut identity = json!({"context_key":context.key,"context_scope":context.context_scope,"origin":context.origin,
        "surface_id":context.surface_id,"thread_id":context.thread_id,"team_revision":context.team_revision,
        "audience_revision":context.audience_revision,"control_revision":input.control_revision,
        "journal_id":input.journal_id,"session_id":op.worker.session_id,"worker":op.worker,"owner":op.owner,"operation_id":op.id,
        "initial_operation_revision":binding.operation_revision,"attempt":op.attempt,"epoch":op.epoch,
        "enrollment":enrollment});
    // Observation revision and expiry deliberately never enter stable identity.
    identity["generation_id"] = json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&identity)?)
    ));
    Ok(
        json!({"identity":identity,"lease_observation":{"revision":op.revision,"expires_at":lease_until,
        "effective_until":effective_until,"checked_at":at},"execution_authorized":false,"runtime_ready":false,
        "inspection_only":true,"host_scope_attested":false}),
    )
}

impl Store {
    pub(super) fn inspect_active_context(&self, input: Check) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        inspect_in(&tx, &self.node_id, &input)
    }
}
