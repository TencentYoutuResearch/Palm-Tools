//! One control operation per stable team. Existing operation lease/funding governs runtime authority.
use super::{
    builder_authority,
    model::{now, valid_id},
    operations::{Operation, State},
    store::Store,
    team_activation,
    team_policies::Policy,
    teams::Spec,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bind {
    pub request_id: String,
    pub expected_revision: u64,
    pub team_revision: u64,
    pub activation_revision: u64,
    pub operation_id: String,
    pub operation_revision: u64,
    pub attempt: u64,
    pub epoch: u64,
    pub target_id: String,
}
fn key(kind: &str, id: &str) -> String {
    format!("coordinator-{kind}:{}", json!(id))
}
fn read(db: &Connection, key: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
pub(super) fn current_in(db: &Connection, team: &str) -> Result<Option<Value>> {
    read(db, &key("control", team))
}
pub(super) fn operation_binding(db: &Connection, id: &str) -> Result<Option<Value>> {
    read(db, &key("operation", id))
}
pub(super) fn bound(db: &Connection, id: &str) -> Result<bool> {
    Ok(read(db, &key("operation", id))?.is_some())
}
pub(super) fn lease_gate(db: &Connection, op: &Operation, at: u64) -> Result<()> {
    let Some(binding) = read(db, &key("operation", &op.id))? else {
        return Ok(());
    };
    let team = binding["team_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid Coordinator binding"))?;
    let current = read(db, &key("control", team))?
        .ok_or_else(|| anyhow::anyhow!("Coordinator control missing"))?;
    if current["revision"] != binding["revision"]
        || current["request"]["operation_id"] != op.id
        || binding["request"]["attempt"] != op.attempt
        || binding["request"]["epoch"] != op.epoch
    {
        bail!("Coordinator control superseded")
    }
    let revision = binding["request"]["team_revision"].as_u64().unwrap_or(0);
    let active = team_activation::authorized(db, team, revision, at)?
        .ok_or_else(|| anyhow::anyhow!("Coordinator team authority unavailable"))?;
    if active["revision"] != binding["request"]["activation_revision"] {
        bail!("Coordinator activation changed")
    }
    Ok(())
}
impl Store {
    pub fn coordinator_control(&self, team: &str) -> Result<Option<Value>> {
        if !valid_id(team) {
            bail!("invalid Coordinator team")
        }
        read(&self.db.lock(), &key("control", team))
    }
    pub fn bind_coordinator_control(&self, team: &str, input: Bind) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = bind_in(&tx, &self.node_id, team, input)?;
        tx.commit()?;
        Ok(result)
    }
}
pub(super) fn bind_in(
    tx: &rusqlite::Transaction,
    home: &str,
    team: &str,
    input: Bind,
) -> Result<Value> {
    if ![
        team,
        &input.request_id,
        &input.operation_id,
        &input.target_id,
    ]
    .iter()
    .all(|id| valid_id(id))
        || input.team_revision == 0
        || input.activation_revision == 0
        || input.attempt == 0
        || input.epoch == 0
        || input.expected_revision >= i64::MAX as u64
    {
        bail!("invalid Coordinator binding")
    }
    let request = serde_json::to_value(&input)?;
    let receipt_key = format!("coordinator-command:{}", json!([team, input.request_id]));
    if let Some(prior) = read(&tx, &receipt_key)? {
        if prior["request"] != request {
            bail!("Coordinator request identity conflict")
        };
        return Ok(prior);
    }
    let current = read(&tx, &key("control", team))?;
    if current
        .as_ref()
        .and_then(|v| v["revision"].as_u64())
        .unwrap_or(0)
        != input.expected_revision
    {
        bail!("Coordinator control revision conflict")
    }
    if let Some(old) = &current {
        let recovery = super::coordinator_recovery::assess(tx, old)?;
        if recovery["unresolved_tools"].as_u64().unwrap_or(1) > 0 {
            bail!("prior Coordinator tool outcome remains unresolved")
        }
        if recovery["replacement_prerequisites_satisfied"] != true {
            bail!("prior Coordinator is not stopped/reported and reconciled")
        }
    }

    if read(&tx, &key("operation", &input.operation_id))?.is_some() {
        bail!("Coordinator operation already bound")
    }
    let op = builder_authority::operation(&tx, &input.operation_id)?;
    if op.state != State::Prepared
        || op.revision != input.operation_revision
        || op.attempt != input.attempt
        || op.epoch != input.epoch
        || op.worker.node_id != home
        || !op.budget_required
        || !op.grant_required
        || !op.resource_required
    {
        bail!("Coordinator requires exact prepared funded local operation")
    }
    let assigned: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM work_assignments WHERE operation_id=?1)",
        [&op.id],
        |r| r.get(0),
    )?;
    if assigned || builder_authority::scope(&tx, &op.id, op.attempt)?.is_some() {
        bail!("Coordinator operation has another role")
    }
    let at = now();
    let active = team_activation::authorized(&tx, team, input.team_revision, at)?
        .ok_or_else(|| anyhow::anyhow!("Coordinator team authority unavailable"))?;
    if active["revision"] != input.activation_revision {
        bail!("Coordinator activation changed")
    }
    let spec: Spec = serde_json::from_value(active["snapshot"]["team"]["spec"].clone())?;
    let target = spec
        .execution_targets
        .iter()
        .find(|t| t.id == input.target_id && spec.coordinator_targets.contains(&t.id))
        .ok_or_else(|| anyhow::anyhow!("target is not a configured Coordinator"))?;
    let selection = op
        .selection_policy
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Coordinator selection policy missing"))?;
    if target.host_id != op.worker.node_id
        || target.model_id != selection.model
        || target.effort != selection.effort
        || target.executor_profile_revision.as_ref() != Some(&selection.profile_revision)
    {
        bail!("Coordinator execution selection mismatch")
    }
    let scheduling: Policy =
        serde_json::from_value(active["snapshot"]["policies"]["scheduling"]["policy"].clone())?;
    let Policy::Scheduling { targets, .. } = scheduling else {
        bail!("Coordinator scheduling policy missing")
    };
    let candidate = targets
        .get(&input.target_id)
        .ok_or_else(|| anyhow::anyhow!("Coordinator resource candidate missing"))?;
    if serde_json::to_value(&op.resource)? != serde_json::to_value(&candidate.resource)?
        || candidate.resource.host != target.host_id
        || candidate.resource.profile != target.executor_profile_id
        || candidate.resource.account_id != target.account_binding_id
    {
        bail!("Coordinator resource selection mismatch")
    }
    let capability: String = tx.query_row(
        "SELECT body FROM capability_profiles WHERE id=?1 AND revision=?2",
        params![candidate.capability_id, candidate.capability_revision],
        |r| r.get(0),
    )?;
    let capability: Value = serde_json::from_str(&capability)?;
    if candidate.capability_revision.to_string() != target.capability_profile_revision
        || capability["host"] != target.host_id
        || capability["profile"] != target.executor_profile_id
        || capability["model"] != target.model_id
    {
        bail!("Coordinator capability identity mismatch")
    }
    super::operation_budget::admit(&tx, &op, at)?;
    super::operation_grant::admit(&tx, &op, at)?;
    if !super::resource_admission::admit(&tx, &op, at)?.allowed {
        bail!("Coordinator resource unavailable")
    }
    let grant = super::operation_grant::read(&tx, &op.id)?
        .ok_or_else(|| anyhow::anyhow!("Coordinator grant missing"))?;
    if grant.scope.team_id != team
        || grant.grant_id != active["snapshot"]["grant"]["policy"]["id"]
        || grant.scope.revision != active["snapshot"]["grant"]["revision"]
        || !spec.workspace_refs.iter().any(|w| {
            w.host_id == grant.scope.target.host
                && w.workspace_id == grant.scope.target.workspace
                && w.root_ref == grant.scope.target.root
        })
    {
        bail!("Coordinator grant differs from activated scope")
    }
    let accounting:(String,Option<String>)=tx.query_row("SELECT r.body,p.body FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id LEFT JOIN reservation_prices rp ON rp.reservation_id=r.id LEFT JOIN price_versions p ON p.id=rp.price_id WHERE b.operation_id=?1 AND b.attempt=?2",params![op.id,op.attempt],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let reservation: super::budgets::Reservation = serde_json::from_str(&accounting.0)?;
    let price: super::pricing::Price = serde_json::from_str(
        &accounting
            .1
            .ok_or_else(|| anyhow::anyhow!("Coordinator price missing"))?,
    )?;
    let Policy::Budget {
        budget_ids,
        unit,
        max_assignment_charge,
        ..
    } = serde_json::from_value::<Policy>(
        active["snapshot"]["policies"]["budget"]["policy"].clone(),
    )?
    else {
        bail!("Coordinator budget policy missing")
    };
    if reservation.request.unit != unit
        || reservation.request.amount > max_assignment_charge
        || reservation
            .request
            .budget_ids
            .iter()
            .any(|b| !budget_ids.contains(b))
        || price.unit != unit
        || price.model != target.model_id
        || price.model_policy != super::pricing::ModelPolicy::RequestedModel
        || candidate
            .internal_price_id
            .as_ref()
            .is_some_and(|p| p != &price.id)
    {
        bail!("Coordinator funding differs from activated policy")
    }
    let revision = input.expected_revision + 1;
    let mut result = json!({"team_id":team,"superagent_id":active["snapshot"]["team"]["superagent_id"],"conversation_id":active["snapshot"]["team"]["conversation_id"],"home_hub":home,"revision":revision,"request":request,"worker":op.worker,"created_at":at,"actor":{"kind":"human","id":"local_owner"},"dispatch_state":"not_dispatched"});
    if let Some(previous) = current {
        result["predecessor"] = json!({"control_revision":previous["revision"],"operation_id":previous["request"]["operation_id"],"attempt":previous["request"]["attempt"],"epoch":previous["request"]["epoch"],"worker":previous["worker"]});
    }
    for k in [key("control", team), key("operation", &op.id), receipt_key] {
        tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value",params![k,revision,serde_json::to_string(&result)?])?;
    }
    tx.execute(
        "INSERT INTO team_events(team_id,body) VALUES (?1,?2)",
        params![
            team,
            serde_json::to_string(&json!({"kind":"coordinator_control_bound","control":result}))?
        ],
    )?;
    Ok(result)
}
