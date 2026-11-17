//! Internal owner-frozen scope/Host binding for the tool-free conversation profile.
//! No management route. Registration is not inference or publication permission.
use super::{
    coordinator_context_registry as registry, coordinator_control,
    model::valid_id,
    operations::{Operation, State},
    runtime_host_enrollment as hosts,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Bind {
    pub request_id: String,
    pub context_key: String,
    pub expected_control_revision: u64,
    pub enrollment_id: String,
    pub expected_enrollment_revision: u64,
    pub expected_operation_revision: u64,
    pub expected_binding_revision: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Revoke {
    pub request_id: String,
    pub binding_id: String,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: String,
    home: String,
    revision: u64,
    revoked: bool,
    request: Bind,
    frozen: Value,
}
fn key(context: &str) -> String {
    format!("coordinator-context-host-binding-v2:{context}")
}
fn read<T: serde::de::DeserializeOwned>(db: &Connection, key: &str) -> Result<Option<T>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| Ok(serde_json::from_str(&raw)?)).transpose()
}
fn hash(value: &Value) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn manifest() -> Value {
    json!({"profile":"conversation_reply_v1","version":1,"tools":[]})
}
fn view(row: &Record, replay: bool) -> Value {
    json!({"binding_id":row.id,"revision":row.revision,"state":if row.revoked{"revoked"}else{"bound_not_admitted"},
        "context_key":row.request.context_key,"frozen":row.frozen,"receipt_replay":replay,
        "claim_allowed":false,"execution_authorized":false,"runtime_ready":false})
}
fn snapshot(
    db: &Connection,
    home: &str,
    context_key: &str,
    enrollment_id: &str,
) -> Result<(Value, Operation)> {
    let context = registry::read_in(db, home, context_key)?;
    let control: Value = read(
        db,
        &format!("coordinator-context-control-v2:{}", json!(context_key)),
    )?
    .ok_or_else(|| anyhow::anyhow!("scoped control missing"))?;
    let input: coordinator_control::Bind = serde_json::from_value(control["request"].clone())?;
    if control["context_key"] != context_key
        || control["context_scope"] != serde_json::to_value(&context.context_scope)?
        || control["team_id"] != context.context_scope.team_id
        || control["home_hub"] != home
        || control["revision"].as_u64().filter(|r| *r > 0).is_none()
        || !control["journal_id"].as_str().is_some_and(valid_id)
        || input.expected_revision != 0
        || input.team_revision != context.team_revision
        || control["runtime_ready"] != false
        || control["dispatch_state"] != "not_ready"
        || coordinator_control::operation_binding(db, &input.operation_id)?.as_ref()
            != Some(&control)
    {
        bail!("scoped Host control identity mismatch")
    }
    let op = super::builder_authority::operation(db, &input.operation_id)?;
    let (op, active, _) = match op.state {
        State::Prepared => coordinator_control::inspect_binding_for_staging(
            db,
            home,
            &context.context_scope.team_id,
            &input,
        )?,
        State::Active => coordinator_control::inspect_active_policy_in(
            db,
            home,
            &context.context_scope.team_id,
            &input,
            op.revision,
        )?,
        _ => bail!("scoped Host operation is not claimable or active"),
    };
    if op.worker.session_id != format!("context-{context_key}")
        || control["worker"] != serde_json::to_value(&op.worker)?
    {
        bail!("scoped Host worker mismatch")
    }
    let reused:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE id!=?1 AND json_extract(body,'$.worker.node_id')=?2 AND json_extract(body,'$.worker.session_id')=?3)",params![op.id,op.worker.node_id,op.worker.session_id],|r|r.get(0))?;
    if reused {
        bail!("scoped Host session reused")
    }
    let enrollment = hosts::current_for_host_in(db, home, enrollment_id, &context.origin.host_id)?;
    let grant = super::operation_grant::read(db, &op.id)?
        .ok_or_else(|| anyhow::anyhow!("scoped Host grant missing"))?;
    if grant.scope.target.host != context.origin.host_id
        || grant.scope.target.workspace != context.origin.workspace_id
        || grant.scope.target.root != context.origin.root_ref
    {
        bail!("scoped Host grant differs from exact origin")
    }
    let catalog = manifest();
    let target = active["snapshot"]["team"]["spec"]["execution_targets"].as_array()
        .and_then(|targets| targets.iter().find(|target| target["id"] == input.target_id))
        .ok_or_else(|| anyhow::anyhow!("scoped Host execution target missing"))?;
    let frozen = json!({"context":context,"control":control,"enrollment":enrollment,
        "operation":{"id":op.id,"owner":op.owner,"worker":op.worker,"attempt":op.attempt,"epoch":op.epoch,
            "initial_revision":input.operation_revision,"selection":op.selection_policy,"resource":op.resource},
        "activation_sha256":hash(&active)?,"execution_target":target,"grant":grant,"manifest":catalog,"manifest_sha256":hash(&catalog)?});
    Ok((frozen, op))
}

/// Called by the original grant/claim transaction. No runtime flags supplied by a caller.
pub(super) fn lease_gate(db: &Connection, op: &Operation, control: &Value, at: u64) -> Result<()> {
    let context = control["context_key"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("scoped Coordinator runtime not ready"))?;
    let row: Record = read(db, &key(context))?
        .ok_or_else(|| anyhow::anyhow!("scoped Coordinator runtime not ready"))?;
    if row.revoked
        || row.revision != 1
        || row.request.context_key != context
        || row.home != op.worker.node_id
        || row.frozen["control"] != *control
    {
        bail!("scoped Host binding revoked or changed")
    }
    let (current, actual) = snapshot(db, &row.home, context, &row.request.enrollment_id)?;
    if current != row.frozen
        || actual.id != op.id
        || actual.revision != op.revision
        || actual.attempt != op.attempt
        || actual.epoch != op.epoch
        || actual.owner != op.owner
        || actual.worker != op.worker
        || actual.state != op.state
        || actual.lease_until != op.lease_until
    {
        bail!("scoped Host frozen authority changed")
    }
    if op.state == State::Active && op.lease_until.is_none_or(|until| until <= at) {
        bail!("scoped Host active lease expired")
    }
    super::selection_evidence::admit(db, op)?;
    super::operation_grant::validate_authority_in(db, op, at)?;
    super::operation_budget::admit(db, op, at)?;
    if !super::resource_admission::admit(db, op, at)?.allowed {
        bail!("scoped Host resource unavailable")
    }
    Ok(())
}

/// Exact active owner-frozen binding, for the internal conversation-call path.
pub(super) fn current_active_in(db:&Connection,home:&str,context:&str,id:&str,at:u64)->Result<(Value,Operation)> {
    let (frozen,op)=current_source_in(db,home,context,id,at)?;
    if op.state!=State::Active || op.lease_until.is_none_or(|until|until<=at) {
        bail!("scoped Host binding has no active lease")
    }
    Ok((frozen,op))
}

/// Ingress identity may span Prepared -> Active, but does not authorize injection.
pub(super) fn current_source_in(db:&Connection,home:&str,context:&str,id:&str,at:u64)->Result<(Value,Operation)> {
    let row:Record=read(db,&key(context))?.ok_or_else(||anyhow::anyhow!("scoped Host binding missing"))?;
    if row.id!=id || row.home!=home || row.request.context_key!=context {
        bail!("scoped Host binding identity mismatch")
    }
    let operation=row.frozen["operation"]["id"].as_str().ok_or_else(||anyhow::anyhow!("scoped Host operation missing"))?;
    let op=super::builder_authority::operation(db,operation)?;
    lease_gate(db,&op,&row.frozen["control"],at)?;
    Ok((row.frozen,op))
}

/// Publication after the original operation Report is not another lease admission.
/// Preserve spent/finalized accounting; require current audience, grant and Host identity.
pub(super) fn settlement_in(db:&Connection,home:&str,context:&str,id:&str,at:u64)->Result<(Value,Operation)> {
    let row:Record=read(db,&key(context))?.ok_or_else(||anyhow::anyhow!("scoped Host binding missing"))?;
    if row.id!=id || row.home!=home || row.request.context_key!=context || row.revoked || row.revision!=1 {
        bail!("scoped publication Host binding changed")
    }
    let current=registry::read_in(db,home,context)?;
    if serde_json::to_value(&current)?!=row.frozen["context"] {bail!("scoped publication origin changed")}
    let host=hosts::current_for_host_in(db,home,&row.request.enrollment_id,&current.origin.host_id)?;
    if serde_json::to_value(host)?!=row.frozen["enrollment"] {bail!("scoped publication Host changed")}
    let control:Value=read(db,&format!("coordinator-context-control-v2:{}",json!(context)))?
        .ok_or_else(||anyhow::anyhow!("scoped control missing"))?;
    let binding:coordinator_control::Bind=serde_json::from_value(control["request"].clone())?;
    if control!=row.frozen["control"] || coordinator_control::operation_binding(db,&binding.operation_id)?.as_ref()!=Some(&control) {
        bail!("scoped publication control changed")
    }
    let op=super::builder_authority::operation(db,&binding.operation_id)?;
    let identity=json!({"id":op.id,"owner":op.owner,"worker":op.worker,"attempt":op.attempt,"epoch":op.epoch,
        "initial_revision":binding.operation_revision,"selection":op.selection_policy,"resource":op.resource});
    if op.state!=State::Reported || op.revision<=binding.operation_revision || identity!=row.frozen["operation"]
        || !op.grant_required || !op.budget_required || !op.resource_required {
        bail!("scoped publication requires original reported operation")
    }
    let active=super::team_activation::authorized(db,&current.context_scope.team_id,current.team_revision,at)?
        .ok_or_else(||anyhow::anyhow!("scoped publication team authority unavailable"))?;
    if hash(&active)?!=row.frozen["activation_sha256"] {bail!("scoped publication activation changed")}
    let grant=super::operation_grant::read(db,&op.id)?.ok_or_else(||anyhow::anyhow!("scoped publication grant missing"))?;
    if serde_json::to_value(grant)?!=row.frozen["grant"] {bail!("scoped publication grant changed")}
    super::operation_grant::validate_authority_in(db,&op,at)?;
    let reported:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM operation_reports WHERE operation_id=?1 AND json_extract(result,'$.applied')=1 AND json_extract(result,'$.operation.attempt')=?2 AND json_extract(result,'$.operation.epoch')=?3)",params![op.id,op.attempt,op.epoch],|r|r.get(0))?;
    if !reported {bail!("scoped publication lacks accepted operation report")}
    Ok((row.frozen,op))
}

/// Authentication supplies `session`; request JSON cannot choose the principal.
pub(super) fn require_worker_in(db:&Connection,home:&str,context:&str,session:&str)->Result<Value> {
    let row:Record=read(db,&key(context))?.ok_or_else(||anyhow::anyhow!("scoped Host binding missing"))?;
    if row.home!=home || row.request.context_key!=context || row.frozen["operation"]["worker"]["node_id"]!=home
        || row.frozen["operation"]["worker"]["session_id"]!=session {bail!("foreign scoped worker")}
    Ok(view(&row,false))
}
pub(super) fn source_authority_in(db:&Connection,home:&str,context:&str,session:&str)->Result<Value> {
    let host=require_worker_in(db,home,context,session)?;
    let (frozen,op)=current_source_in(db,home,context,host["binding_id"].as_str().unwrap(),super::model::now())?;
    let c=&frozen["context"];let ctl=&frozen["control"];
    let team_id=c["context_scope"]["team_id"].as_str().ok_or_else(||anyhow::anyhow!("scope team missing"))?;
    let team_revision=c["team_revision"].as_u64().ok_or_else(||anyhow::anyhow!("scope team revision missing"))?;
    let activation=super::team_activation::authorized(db,team_id,team_revision,super::model::now())?
        .ok_or_else(||anyhow::anyhow!("scope team activation unavailable"))?;
    let team=&activation["snapshot"]["team"];
    if hash(&activation)?!=frozen["activation_sha256"] || team["id"]!=team_id
        || team["home_hub"]!=home || team["revision"]!=team_revision {
        bail!("scope Team snapshot differs from frozen identity")
    }
    let authority=json!({"context_key":context,"context_scope":c["context_scope"],"origin":c["origin"],
        "surface_id":c["surface_id"],"thread_id":c["thread_id"],"journal_id":ctl["journal_id"],"session_id":op.worker.session_id,"worker":op.worker,
        "operation_id":op.id,"operation_revision":ctl["request"]["operation_revision"],"attempt":op.attempt,"epoch":op.epoch,
        "control_revision":ctl["revision"],"team_revision":c["team_revision"],"audience_revision":c["audience_revision"]});
    Ok(json!({"authority":authority,"host_binding":host,"operation":op,"team_snapshot":team,
        "lease_observation":{"revision":op.revision,"expires_at":op.lease_until},"source_read_allowed":true,"dispatch_allowed":false}))
}
impl Store {
    pub(super) fn context_host_binding(&self,context:&str)->Result<Option<Value>> {
        Ok(read::<Record>(&self.db.lock(),&key(context))?.map(|r|view(&r,false)))
    }
    pub(super) fn context_worker_identity(&self,context:&str,session:&str)->Result<()> {
        require_worker_in(&self.db.lock(),&self.node_id,context,session)?;Ok(())
    }
    pub(super) fn context_source_authority(&self,context:&str,session:&str)->Result<Value> {
        let mut db=self.db.lock();let tx=db.transaction()?;
        source_authority_in(&tx,&self.node_id,context,session)
    }
    /// Internal owner control plane only. No production route calls this method.
    pub(super) fn bind_context_host(&self, input: Bind) -> Result<Value> {
        if !valid_id(&input.request_id)
            || !valid_id(&input.enrollment_id)
            || input.expected_binding_revision != 0
        {
            bail!("invalid initial scoped Host binding")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        registry::read_in(&tx, &self.node_id, &input.context_key)?;
        if let Some(old) = read::<Record>(&tx, &key(&input.context_key))? {
            if old.request != input {
                bail!("scoped Host binding request conflict; new context epoch required")
            }
            return Ok(view(&old, true));
        }
        let (frozen, op) = snapshot(&tx, &self.node_id, &input.context_key, &input.enrollment_id)?;
        if op.state != State::Prepared
            || op.revision != input.expected_operation_revision
            || frozen["control"]["revision"] != input.expected_control_revision
            || frozen["enrollment"]["revision"] != input.expected_enrollment_revision
        {
            bail!("scoped Host registration revision conflict")
        }
        let record = Record {
            id: uuid::Uuid::new_v4().to_string(),
            home: self.node_id.clone(),
            revision: 1,
            revoked: false,
            request: input,
            frozen,
        };
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key(&record.request.context_key),
                serde_json::to_string(&record)?
            ],
        )?;
        tx.commit()?;
        Ok(view(&record, false))
    }
    pub(super) fn revoke_context_host(&self, context: &str, input: Revoke) -> Result<Value> {
        if !valid_id(&input.request_id) || !valid_id(&input.binding_id) {
            bail!("invalid scoped Host revocation")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let mut row: Record = read(&tx, &key(context))?
            .ok_or_else(|| anyhow::anyhow!("scoped Host binding missing"))?;
        if row.home != self.node_id
            || row.id != input.binding_id
            || row.request.context_key != context
        {
            bail!("scoped Host revoke identity mismatch")
        }
        let receipt_key = format!(
            "coordinator-context-host-revoke-v2:{}",
            json!([context, input.request_id])
        );
        if let Some(old) = read::<Revoke>(&tx, &receipt_key)? {
            if old != input {
                bail!("scoped Host revoke request conflict")
            }
            return Ok(view(&row, true));
        }
        if row.revoked || row.revision != input.expected_revision {
            bail!("scoped Host revoke revision conflict")
        }
        row.revoked = true;
        row.revision += 1;
        if tx.execute(
            "UPDATE workbench_documents SET revision=?1,value=?2 WHERE key=?3 AND revision=?4",
            params![
                row.revision,
                serde_json::to_string(&row)?,
                key(context),
                input.expected_revision
            ],
        )? != 1
        {
            bail!("scoped Host revoke CAS conflict")
        }
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![receipt_key, serde_json::to_string(&input)?],
        )?;
        tx.commit()?;
        Ok(view(&row, false))
    }
}
