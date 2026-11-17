//! Durable scoped staging ledger, not permission to call a model or acquire a lease.
//! All paths recheck current authority and the one explicitly referenced input.
//! Claimed/uncertain entries never become pending again. No legacy inbox is touched.
use super::{
    coordinator_context_input as inputs, coordinator_context_registry as registry,
    coordinator_control,
    model::{valid_id, Address},
    operations::Operation,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) struct Authority {
    pub context: registry::Record,
    pub control: Value,
    pub operation: Operation,
    pub journal_id: String,
}
fn load(db: &Connection, key: &str) -> Result<Option<Value>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn require(db: &Connection, key: &str) -> Result<Value> {
    load(db, key)?.ok_or_else(|| anyhow::anyhow!("scoped inbox record missing"))
}
fn insert(db: &Connection, key: &str, value: &impl Serialize) -> Result<()> {
    db.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}

/// Prepared-only staging authority. This deliberately does not call or bypass the
/// runtime lease gate: active/uncertain/recovery operations remain unsupported.
pub(super) fn authority_in(tx: &Transaction, home: &str, key: &str) -> Result<Authority> {
    let context = registry::read_in(tx, home, key)?;
    let control = require(
        tx,
        &format!("coordinator-context-control-v2:{}", json!(key)),
    )?;
    let bind: coordinator_control::Bind = serde_json::from_value(control["request"].clone())?;
    let journal = control["journal_id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or_else(|| anyhow::anyhow!("scoped inbox journal identity missing"))?
        .to_string();
    if control["context_key"] != key
        || control["context_scope"] != serde_json::to_value(&context.context_scope)?
        || control["home_hub"] != home
        || control["team_id"] != context.context_scope.team_id
        || control["revision"].as_u64().filter(|r| *r > 0).is_none()
        || control["runtime_ready"] != false
        || control["dispatch_state"] != "not_ready"
        || bind.team_revision != context.team_revision
        || bind.expected_revision != 0
    {
        bail!("scoped inbox control identity mismatch")
    }
    let fence = coordinator_control::operation_binding(tx, &bind.operation_id)?
        .ok_or_else(|| anyhow::anyhow!("scoped inbox operation fence missing"))?;
    if fence != control {
        bail!("scoped inbox operation fence changed")
    }
    let (operation, _, _) = coordinator_control::inspect_binding_for_staging(
        tx,
        home,
        &context.context_scope.team_id,
        &bind,
    )?;
    if control["worker"] != serde_json::to_value(&operation.worker)?
        || operation.worker.session_id != format!("context-{key}")
    {
        bail!("scoped inbox worker identity mismatch")
    }
    let grant = super::operation_grant::read(tx, &operation.id)?
        .ok_or_else(|| anyhow::anyhow!("scoped inbox grant missing"))?;
    if grant.scope.target.host != context.origin.host_id
        || grant.scope.target.workspace != context.origin.workspace_id
        || grant.scope.target.root != context.origin.root_ref
    {
        bail!("scoped inbox grant differs from exact origin")
    }
    let reused:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE id!=?1 AND json_extract(body,'$.worker.node_id')=?2 AND json_extract(body,'$.worker.session_id')=?3)",
        params![operation.id,operation.worker.node_id,operation.worker.session_id],|r|r.get(0))?;
    if reused {
        bail!("scoped inbox worker session has another operation")
    }
    Ok(Authority {
        context,
        control,
        operation,
        journal_id: journal,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Enqueue {
    pub request_id: String,
    pub input_request_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Claim {
    pub request_id: String,
    pub entry_id: String,
    pub operation_id: String,
    pub journal_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Outcome {
    Completed,
    Uncertain,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Finish {
    pub request_id: String,
    pub entry_id: String,
    pub claim_id: String,
    pub operation_id: String,
    pub journal_id: String,
    pub outcome: Outcome,
    pub reply: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum State {
    Pending,
    Claimed,
    Completed,
    Uncertain,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    context_key: String,
    input_request_id: String,
    source_message_id: String,
    source_sequence: u64,
    source_content_sha256: String,
    operation_id: String,
    operation_revision: u64,
    operation_attempt: u64,
    operation_epoch: u64,
    control_revision: u64,
    journal_id: String,
    worker: Address,
    revision: u64,
    state: State,
    claim_id: Option<String>,
    reply: Option<String>,
}
fn entry_key(context: &str, id: &str) -> String {
    format!("coordinator-context-inbox-v2:{context}:{id}")
}
fn command_key(context: &str, request: &str) -> String {
    format!(
        "coordinator-context-inbox-command-v2:{}",
        json!([context, request])
    )
}
fn source_key(source: &str) -> String {
    format!("coordinator-context-inbox-source-v2:{}", json!(source))
}
fn ids(ids: &[&str]) -> Result<()> {
    if !ids.iter().all(|id| valid_id(id)) {
        bail!("invalid scoped inbox identity")
    }
    Ok(())
}
fn exact_input(tx: &Transaction, home: &str, a: &Authority, input: &str) -> Result<Value> {
    let source = inputs::read_in(tx, home, &a.context.key, input)?;
    let receipt = &source["receipt"];
    let id = receipt["source_message_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("scoped input identity missing"))?;
    if require(tx, &format!("coordinator-context-source-v2:{}", json!(id)))? != *receipt {
        bail!("scoped input source fence changed")
    }
    Ok(source)
}
fn checked_entry(tx: &Transaction, home: &str, a: &Authority, id: &str) -> Result<(Entry, Value)> {
    checked_entry_revision(tx,home,a,id,a.operation.revision)
}
fn checked_entry_revision(tx: &Transaction, home: &str, a: &Authority, id: &str, initial_revision:u64) -> Result<(Entry, Value)> {
    ids(&[id])?;
    let entry: Entry = serde_json::from_value(require(tx, &entry_key(&a.context.key, id))?)?;
    if entry.id != id
        || entry.context_key != a.context.key
        || entry.operation_id != a.operation.id
        || entry.operation_revision != initial_revision
        || entry.operation_attempt != a.operation.attempt
        || entry.operation_epoch != a.operation.epoch
        || Some(entry.control_revision) != a.control["revision"].as_u64()
        || entry.journal_id != a.journal_id
        || serde_json::to_value(&entry.worker)? != serde_json::to_value(&a.operation.worker)?
    {
        bail!("scoped inbox entry binding changed")
    }
    let source = exact_input(tx, home, a, &entry.input_request_id)?;
    if source["receipt"]["source_message_id"] != entry.source_message_id
        || source["receipt"]["source_sequence"] != entry.source_sequence
        || source["receipt"]["request"]["expected_content_sha256"] != entry.source_content_sha256
    {
        bail!("scoped inbox source binding changed")
    }
    let fence = require(tx, &source_key(&entry.source_message_id))?;
    if fence != json!({"context_key":a.context.key,"entry_id":entry.id}) {
        bail!("scoped inbox source already owned elsewhere")
    }
    Ok((entry, source))
}

/// Active conversation reads keep the input's original Prepared revision fixed.
/// Lease renewals change only the current operation observation, never source ownership.
pub(super) fn conversation_claim_in(tx:&Transaction,home:&str,context:&str,binding:&str,entry_id:&str,claim_id:&str,at:u64)->Result<Value> {
    let (frozen,op)=super::coordinator_context_host_binding::current_active_in(tx,home,context,binding,at)?;
    conversation_source_checked(tx,home,entry_id,claim_id,frozen,op,false)
}
pub(super) fn conversation_ingress_in(tx:&Transaction,home:&str,context:&str,binding:&str,entry_id:&str,claim_id:&str,at:u64)->Result<Value> {
    let (frozen,op)=super::coordinator_context_host_binding::current_source_in(tx,home,context,binding,at)?;
    conversation_source_checked(tx,home,entry_id,claim_id,frozen,op,false)
}
pub(super) fn conversation_settlement_in(tx:&Transaction,home:&str,context:&str,binding:&str,entry_id:&str,claim_id:&str,at:u64)->Result<Value> {
    let (frozen,op)=super::coordinator_context_host_binding::settlement_in(tx,home,context,binding,at)?;
    conversation_source_checked(tx,home,entry_id,claim_id,frozen,op,true)
}
fn conversation_source_checked(tx:&Transaction,home:&str,entry_id:&str,claim_id:&str,frozen:Value,op:Operation,settlement:bool)->Result<Value> {
    let control=frozen["control"].clone();
    let initial_revision=control["request"]["operation_revision"].as_u64().ok_or_else(||anyhow::anyhow!("scoped input initial revision missing"))?;
    let a=Authority {context:serde_json::from_value(frozen["context"].clone())?,
        journal_id:control["journal_id"].as_str().ok_or_else(||anyhow::anyhow!("scoped journal missing"))?.into(),
        control,operation:op};
    let (entry,_)=checked_entry_revision(tx,home,&a,entry_id,initial_revision)?;
    if !(entry.state==State::Claimed || settlement && entry.state==State::Completed) || entry.claim_id.as_deref()!=Some(claim_id) {
        bail!("conversation requires the exact claimed source")
    }
    Ok(json!({"entry":entry,"frozen":frozen}))
}

/// Recording an already admitted outcome does not require a fresh inference grant.
/// Caller owns the admission receipt; this only CAS-settles that exact existing claim.
pub(super) fn settle_conversation_in(tx:&Transaction,context:&str,entry_id:&str,claim_id:&str,operation:&str,journal:&str,completed:bool)->Result<()> {
    let mut entry:Entry=serde_json::from_value(require(tx,&entry_key(context,entry_id))?)?;
    if entry.context_key!=context || entry.id!=entry_id || entry.claim_id.as_deref()!=Some(claim_id)
        || entry.operation_id!=operation || entry.journal_id!=journal || entry.state!=State::Claimed {
        bail!("scoped outcome has no exact original claim")
    }
    let revision=entry.revision;entry.revision+=1;
    entry.state=if completed {State::Completed}else{State::Uncertain};
    update(tx,&entry,revision)
}
fn prior(
    tx: &Transaction,
    a: &Authority,
    request: &str,
    command: &Value,
) -> Result<Option<String>> {
    load(tx, &command_key(&a.context.key, request))?
        .map(|old| {
            if old["request"] != *command {
                bail!("scoped inbox request identity conflict")
            }
            Ok(old["entry_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid inbox receipt"))?
                .to_string())
        })
        .transpose()
}
fn save_command(
    tx: &Transaction,
    a: &Authority,
    request: &str,
    command: &Value,
    entry: &Entry,
) -> Result<()> {
    insert(
        tx,
        &command_key(&a.context.key, request),
        &json!({"request":command,"entry_id":entry.id}),
    )
}
fn update(tx: &Transaction, entry: &Entry, expected: u64) -> Result<()> {
    if tx.execute(
        "UPDATE workbench_documents SET revision=?1,value=?2 WHERE key=?3 AND revision=?4",
        params![
            entry.revision,
            serde_json::to_string(entry)?,
            entry_key(&entry.context_key, &entry.id),
            expected
        ],
    )? != 1
    {
        bail!("scoped inbox revision conflict")
    }
    Ok(())
}
fn snapshot(a: &Authority) -> Value {
    json!({"context_key":a.context.key,"context_scope":a.context.context_scope,"origin":a.context.origin,
        "surface_id":a.context.surface_id,"thread_id":a.context.thread_id,
        "journal_id":a.journal_id,"session_id":a.operation.worker.session_id,"worker":a.operation.worker,
        "operation_id":a.operation.id,"operation_revision":a.operation.revision,"attempt":a.operation.attempt,"epoch":a.operation.epoch,
        "control_revision":a.control["revision"],"team_revision":a.context.team_revision,"audience_revision":a.context.audience_revision,
        "runtime_ready":false,"dispatch_allowed":false,"stage":"prepared_only"})
}
fn view(entry: &Entry, a: &Authority) -> Value {
    json!({"entry":entry,"authority":snapshot(a),"runtime_ready":false,"execution_authorized":false,"dispatch_allowed":false})
}

/// Read-only staging drain metadata; strips reply text and revalidates the source.
pub(super) fn pending_metadata_in(
    tx: &Transaction,
    home: &str,
    authority: &Authority,
    entry_id: &str,
) -> Result<Value> {
    let (entry, _) = checked_entry(tx, home, authority, entry_id)?;
    let mut metadata = serde_json::to_value(entry)?;
    metadata.as_object_mut().unwrap().remove("reply");
    Ok(metadata)
}

/// Exact, currently claimed source binding for server-owned staging tools.
/// Returns metadata only; checked_entry still revalidates the source fingerprint.
pub(super) fn claimed_in(
    tx: &Transaction,
    home: &str,
    context: &str,
    entry_id: &str,
    claim_id: &str,
) -> Result<Value> {
    let result = claim_status_in(tx, home, context, entry_id, claim_id)?;
    if result["entry"]["state"] != "claimed" {
        bail!("scoped tool requires the exact current source claim")
    }
    Ok(result)
}

/// Status-only source proof can survive settlement, but never grants another call.
pub(super) fn claim_status_in(
    tx: &Transaction,
    home: &str,
    context: &str,
    entry_id: &str,
    claim_id: &str,
) -> Result<Value> {
    ids(&[entry_id, claim_id])?;
    let a = authority_in(tx, home, context)?;
    let (entry, _) = checked_entry(tx, home, &a, entry_id)?;
    if entry.state == State::Pending || entry.claim_id.as_deref() != Some(claim_id) {
        bail!("scoped tool requires the exact current source claim")
    }
    Ok(view(&entry, &a))
}

fn claim_in(tx:&Transaction,home:&str,context:&str,input:Claim)->Result<Value> {
        ids(&[
            &input.request_id,
            &input.entry_id,
            &input.operation_id,
            &input.journal_id,
        ])?;
        let a = authority_in(&tx, home, context)?;
        if input.operation_id != a.operation.id || input.journal_id != a.journal_id {
            bail!("scoped inbox claimant binding mismatch")
        }
        let command = json!({"kind":"claim","input":input});
        if let Some(id) = prior(&tx, &a, &input.request_id, &command)? {
            let (entry, _) = checked_entry(&tx, home, &a, &id)?;
            return Ok(
                json!({"receipt":view(&entry,&a),"new_claim":false,"authority":snapshot(&a),"runtime_ready":false,"dispatch_allowed":false}),
            );
        }
        let (mut entry, source) = checked_entry(&tx, home, &a, &input.entry_id)?;
        if entry.state != State::Pending {
            bail!("scoped inbox input already claimed or settled; replay forbidden")
        }
        let revision = entry.revision;
        entry.revision += 1;
        entry.state = State::Claimed;
        entry.claim_id = Some(uuid::Uuid::new_v4().to_string());
        update(&tx, &entry, revision)?;
        save_command(&tx, &a, &input.request_id, &command, &entry)?;
        Ok(
            json!({"receipt":view(&entry,&a),"new_claim":true,"authority":snapshot(&a),"message":source["message"],"runtime_ready":false,"dispatch_allowed":false}),
        )
}

impl Store {
    pub(super) fn context_inbox_authority(&self, context: &str) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        Ok(snapshot(&authority_in(&tx, &self.node_id, context)?))
    }

    pub(super) fn enqueue_context_input(&self, context: &str, input: Enqueue) -> Result<Value> {
        ids(&[&input.request_id, &input.input_request_id])?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let a = authority_in(&tx, &self.node_id, context)?;
        let command = json!({"kind":"enqueue","input":input});
        if let Some(id) = prior(&tx, &a, &input.request_id, &command)? {
            return Ok(view(&checked_entry(&tx, &self.node_id, &a, &id)?.0, &a));
        }
        let source = exact_input(&tx, &self.node_id, &a, &input.input_request_id)?;
        let receipt = &source["receipt"];
        let source_id = receipt["source_message_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("source identity missing"))?;
        if load(&tx, &source_key(source_id))?.is_some() {
            bail!("scoped inbox source already enqueued")
        }
        let entry = Entry {
            id: uuid::Uuid::new_v4().to_string(),
            context_key: context.into(),
            input_request_id: input.input_request_id.clone(),
            source_message_id: source_id.into(),
            source_sequence: receipt["source_sequence"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("source sequence missing"))?,
            source_content_sha256: receipt["request"]["expected_content_sha256"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("source hash missing"))?
                .into(),
            operation_id: a.operation.id.clone(),
            operation_revision: a.operation.revision,
            operation_attempt: a.operation.attempt,
            operation_epoch: a.operation.epoch,
            control_revision: a.control["revision"].as_u64().unwrap(),
            journal_id: a.journal_id.clone(),
            worker: a.operation.worker.clone(),
            revision: 1,
            state: State::Pending,
            claim_id: None,
            reply: None,
        };
        insert(&tx, &entry_key(context, &entry.id), &entry)?;
        insert(
            &tx,
            &source_key(source_id),
            &json!({"context_key":context,"entry_id":entry.id}),
        )?;
        save_command(&tx, &a, &input.request_id, &command, &entry)?;
        tx.commit()?;
        Ok(view(&entry, &a))
    }

    pub(super) fn pending_context_inputs(&self, context: &str, limit: usize) -> Result<Value> {
        if limit == 0 || limit > 50 {
            bail!("invalid scoped inbox page")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let a = authority_in(&tx, &self.node_id, context)?;
        let prefix = format!("coordinator-context-inbox-v2:{context}:");
        let rows = {
            let mut q=tx.prepare("SELECT value FROM workbench_documents WHERE substr(key,1,length(?1))=?1 AND json_extract(value,'$.state')='pending' ORDER BY json_extract(value,'$.source_sequence'),key LIMIT ?2")?;
            let rows = q
                .query_map(params![prefix, limit + 1], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let more = rows.len() > limit;
        let mut items = vec![];
        for row in rows.into_iter().take(limit) {
            let row: Entry = serde_json::from_str(&row)?;
            items.push(view(&checked_entry(&tx, &self.node_id, &a, &row.id)?.0, &a));
        }
        Ok(
            json!({"items":items,"has_more":more,"authority":snapshot(&a),"runtime_ready":false,"dispatch_allowed":false}),
        )
    }

    pub(super) fn context_inbox_entry(&self, context: &str, id: &str) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let a = authority_in(&tx, &self.node_id, context)?;
        Ok(view(&checked_entry(&tx, &self.node_id, &a, id)?.0, &a))
    }

    /// A new claim reserves one local ledger entry, not runtime admission. A replayed
    /// claim never returns source text or permits another execution attempt.
    pub(super) fn claim_context_input(&self,context:&str,input:Claim)->Result<Value> {
        let mut db=self.db.lock();let tx=db.transaction()?;
        let value=claim_in(&tx,&self.node_id,context,input)?;tx.commit()?;Ok(value)
    }
    pub(super) fn claim_context_input_for_worker(&self,context:&str,session:&str,input:Claim)->Result<Value> {
        let mut db=self.db.lock();let tx=db.transaction()?;
        let authority=super::coordinator_context_host_binding::source_authority_in(&tx,&self.node_id,context,session)?;
        let mut value=claim_in(&tx,&self.node_id,context,input)?;
        value["authority"]=authority["authority"].clone();value["host_binding"]=authority["host_binding"].clone();
        tx.commit()?;Ok(value)
    }
    pub(super) fn context_source_for_worker(&self,context:&str,session:&str,entry:&str,claim:&str)->Result<Value> {
        let mut db=self.db.lock();let tx=db.transaction()?;
        let authority=super::coordinator_context_host_binding::source_authority_in(&tx,&self.node_id,context,session)?;
        let source=conversation_ingress_in(&tx,&self.node_id,context,authority["host_binding"]["binding_id"].as_str().unwrap(),entry,claim,super::model::now())?;
        let input=super::coordinator_context_input::read_in(&tx,&self.node_id,context,source["entry"]["input_request_id"].as_str().ok_or_else(||anyhow::anyhow!("source input missing"))?)?;
        Ok(json!({"authority":authority["authority"],"host_binding":authority["host_binding"],"entry":source["entry"],"message":input["message"],"source_validated":true,"dispatch_allowed":false}))
    }

    /// Settlement is bound to the original source. Uncertain is terminal here;
    /// no automatic retry, cross-scope publication, or recovery is implemented.
    pub(super) fn finish_context_input(&self, context: &str, input: Finish) -> Result<Value> {
        ids(&[
            &input.request_id,
            &input.entry_id,
            &input.claim_id,
            &input.operation_id,
            &input.journal_id,
        ])?;
        if match input.outcome {
            Outcome::Completed => !input
                .reply
                .as_ref()
                .is_some_and(|r| !r.trim().is_empty() && r.len() <= 65536 && !r.contains('\0')),
            Outcome::Uncertain => input.reply.is_some(),
        } {
            bail!("invalid scoped inbox outcome")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let a = authority_in(&tx, &self.node_id, context)?;
        if input.operation_id != a.operation.id || input.journal_id != a.journal_id {
            bail!("scoped inbox completion binding mismatch")
        }
        let command = json!({"kind":"finish","input":input});
        if let Some(id) = prior(&tx, &a, &input.request_id, &command)? {
            return Ok(view(&checked_entry(&tx, &self.node_id, &a, &id)?.0, &a));
        }
        let (mut entry, _) = checked_entry(&tx, &self.node_id, &a, &input.entry_id)?;
        if entry.state != State::Claimed
            || entry.claim_id.as_deref() != Some(input.claim_id.as_str())
        {
            bail!("scoped inbox outcome has no matching active claim")
        }
        let revision = entry.revision;
        entry.revision += 1;
        entry.state = if input.outcome == Outcome::Completed {
            State::Completed
        } else {
            State::Uncertain
        };
        entry.reply = input.reply;
        update(&tx, &entry, revision)?;
        save_command(&tx, &a, &input.request_id, &command, &entry)?;
        tx.commit()?;
        Ok(view(&entry, &a))
    }
}
