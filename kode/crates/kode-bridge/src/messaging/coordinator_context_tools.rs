//! Server-owned tool grants and atomic local staging receipts. No HTTP, runtime
//! admission, model-created grants, UI publication, or outbox consumer exists here.
use super::{
    coordinator_context_inbox as inbox, coordinator_context_retrieval as summaries,
    model::valid_id, store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) const IMPLEMENTATION: &str = "kode-context-stage-tools-v1";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Target {
    ReadApprovedSummary { approval_request_id: String },
    PublishReply,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Issue {
    pub request_id: String,
    pub entry_id: String,
    pub claim_id: String,
    pub target: Target,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Invocation {
    pub request_id: String,
    pub session_id: String,
    pub journal_id: String,
    pub source_receipt_id: String,
    pub tool_call_seq: u64,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Stage {
    pub grant_id: String,
    pub invocation: Invocation,
    pub schema_hash: String,
    pub implementation_id: String,
    pub args: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    grant_id: String,
    context_key: String,
    issue: Issue,
    authority: Value,
    source: Value,
    action: String,
    target: Value,
    schema: Value,
    schema_hash: String,
    implementation_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    receipt_id: String,
    context_key: String,
    request: Stage,
    canonical_payload_sha256: String,
    result: Value,
}

/// Canonical JSON: recursively sort object keys lexically (contract keys are ASCII),
/// preserve array order, compact JSON strings/numbers. Schemas contain integers only.
pub(super) fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical(&map[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => value.to_string(),
    }
}
pub(super) fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical(value).as_bytes()))
}
fn action(target: &Target) -> &'static str {
    match target {
        Target::ReadApprovedSummary { .. } => "read_approved_summary",
        Target::PublishReply => "publish_reply",
    }
}
pub(super) fn schema(target: &Target) -> Value {
    json!({"type":"object","properties":if matches!(target,Target::PublishReply){json!({"text":{"type":"string","minLength":1,"maxLength":65536}})}else{json!({})},
        "required":if matches!(target,Target::PublishReply){json!(["text"])}else{json!([])},"additionalProperties":false})
}
pub(super) fn request_id(invocation: &Invocation) -> String {
    format!(
        "tool:{}",
        hash(&json!([
            1,
            invocation.session_id,
            invocation.journal_id,
            invocation.source_receipt_id,
            invocation.tool_call_seq
        ]))
    )
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
    load(db, key)?.ok_or_else(|| anyhow::anyhow!("scoped tool ledger record missing"))
}
fn insert(db: &Connection, key: &str, value: &impl Serialize) -> Result<()> {
    db.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}
fn grant_key(id: &str) -> String {
    format!("coordinator-context-tool-grant-v2:{}", json!(id))
}
fn receipt_key(context: &str, request: &str) -> String {
    format!(
        "coordinator-context-tool-receipt-v2:{}",
        json!([context, request])
    )
}
fn outbox_key(id: &str) -> String {
    format!("coordinator-context-tool-outbox-v2:{}", json!(id))
}
fn target_in(
    tx: &Transaction,
    home: &str,
    context: &str,
    source: &Value,
    target: &Target,
) -> Result<Value> {
    match target {
        Target::ReadApprovedSummary {
            approval_request_id,
        } => {
            let summary = summaries::read_in(tx, home, context, approval_request_id)?;
            Ok(
                json!({"context_key":context,"approval_request_id":approval_request_id,
                "summary_sha256":summary["summary_sha256"],"source_reference":summary["source_reference"]}),
            )
        }
        Target::PublishReply => {
            let authority = &source["authority"];
            let body: String = tx.query_row(
                "SELECT body FROM collaboration_surfaces WHERE id=?1",
                [authority["surface_id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("source surface missing"))?],
                |r| r.get(0),
            )?;
            let surface: Value = serde_json::from_str(&body)?;
            let recipients = surface["team_ids"]
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 64)
                .ok_or_else(|| anyhow::anyhow!("reply audience missing"))?;
            if !recipients.iter().all(|v| v.as_str().is_some_and(valid_id)) {
                bail!("reply audience invalid")
            }
            Ok(
                json!({"context_key":context,"surface_id":authority["surface_id"],"thread_id":authority["thread_id"],
                "source_message_id":source["entry"]["source_message_id"],"team_ids":recipients,
                "audience_revision":authority["audience_revision"]}),
            )
        }
    }
}
enum Access {
    Stage,
    Status,
}
fn source_identity(source: &Value) -> Value {
    let mut entry = source["entry"].clone();
    if let Some(object) = entry.as_object_mut() {
        for field in ["state", "revision", "reply"] {
            object.remove(field);
        }
    }
    entry
}
fn checked_grant(
    tx: &Transaction,
    home: &str,
    context: &str,
    id: &str,
    access: Access,
) -> Result<Grant> {
    if !valid_id(id) {
        bail!("invalid server grant identity")
    }
    let grant: Grant = serde_json::from_value(require(tx, &grant_key(id))?)?;
    if grant.grant_id != id
        || grant.context_key != context
        || grant.implementation_id != IMPLEMENTATION
        || grant.action != action(&grant.issue.target)
        || grant.schema != schema(&grant.issue.target)
        || grant.schema_hash != hash(&grant.schema)
    {
        bail!("server scoped grant contract changed")
    }
    let current = match access {
        Access::Stage => inbox::claimed_in(
            tx,
            home,
            context,
            &grant.issue.entry_id,
            &grant.issue.claim_id,
        )?,
        Access::Status => inbox::claim_status_in(
            tx,
            home,
            context,
            &grant.issue.entry_id,
            &grant.issue.claim_id,
        )?,
    };
    if current["authority"] != grant.authority || source_identity(&current) != grant.source {
        bail!("server scoped grant source or authority changed")
    }
    if target_in(tx, home, context, &current, &grant.issue.target)? != grant.target {
        bail!("server scoped grant target changed")
    }
    Ok(grant)
}
fn check_stage(grant: &Grant, input: &Stage) -> Result<()> {
    let inv = &input.invocation;
    if input.grant_id != grant.grant_id
        || input.implementation_id != IMPLEMENTATION
        || input.schema_hash != grant.schema_hash
        || inv.session_id != grant.authority["session_id"]
        || inv.journal_id != grant.authority["journal_id"]
        || inv.source_receipt_id != grant.issue.entry_id
        || inv.tool_name != grant.action
        || inv.tool_call_seq == 0
        || inv.tool_call_seq > 9_007_199_254_740_991
        || !valid_id(&inv.tool_call_id)
        || inv.request_id != request_id(inv)
        || inv.arguments_sha256 != hash(&input.args)
    {
        bail!("scoped tool invocation provenance mismatch")
    }
    let object = input
        .args
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("scoped tool args must be an object"))?;
    match grant.issue.target {
        Target::ReadApprovedSummary { .. } => {
            if !object.is_empty() {
                bail!("summary tool accepts no model authority fields")
            }
        }
        Target::PublishReply => {
            if object.len() != 1
                || !object.get("text").and_then(Value::as_str).is_some_and(|s| {
                    !s.trim().is_empty() && !s.contains('\0') && s.chars().count() <= 65536
                })
            {
                bail!("reply tool accepts only bounded text")
            }
        }
    }
    Ok(())
}
fn grant_view(grant: &Grant) -> Value {
    json!({"grant":grant,"runtime_ready":false,"dispatch_allowed":false,"stage":"prepared_only"})
}
fn status_in(
    tx: &Transaction,
    home: &str,
    context: &str,
    grant_id: &str,
    request: &str,
) -> Result<Value> {
    let grant = checked_grant(tx, home, context, grant_id, Access::Status)?;
    let receipt: Receipt = serde_json::from_value(require(tx, &receipt_key(context, request))?)?;
    if receipt.context_key != context
        || receipt.request.invocation.request_id != request
        || receipt.canonical_payload_sha256 != hash(&serde_json::to_value(&receipt.request)?)
    {
        bail!("scoped tool receipt identity changed")
    }
    check_stage(&grant, &receipt.request)?;
    if require(
        tx,
        &format!("coordinator-context-tool-used-v2:{}", json!(grant_id)),
    )? != json!({"receipt_id":receipt.receipt_id,"request_id":request})
    {
        bail!("scoped tool receipt use fence changed")
    }
    if let Target::PublishReply = grant.issue.target {
        let outbox = require(tx, &outbox_key(&receipt.receipt_id))?;
        if outbox["target"] != grant.target
            || outbox["text"] != receipt.request.args["text"]
            || outbox["context_key"] != context
            || outbox["grant_id"] != grant_id
            || outbox["request_id"] != request
            || outbox["state"] != "staging_outbox"
        {
            bail!("scoped tool outbox binding changed")
        }
        if receipt.result
            != json!({"outbox_id":receipt.receipt_id,"target":grant.target,"state":"staging_outbox"})
        {
            bail!("scoped tool staged reply result changed")
        }
    } else if let Target::ReadApprovedSummary {
        approval_request_id,
    } = &grant.issue.target
    {
        if receipt.result != summaries::read_in(tx, home, context, approval_request_id)? {
            bail!("approved summary result changed")
        }
    }
    Ok(
        json!({"receipt_id":receipt.receipt_id,"request_id":request,"grant_id":grant_id,
        "status":if matches!(grant.issue.target,Target::PublishReply){"staging_outbox"}else{"staged_summary"},
        "data":receipt.result,"provenance":{"authority":grant.authority,"source":grant.source,"action":grant.action,
            "target":grant.target,"schema_hash":grant.schema_hash,"implementation_id":grant.implementation_id,"invocation":receipt.request.invocation},
        "runtime_ready":false,"dispatch_allowed":false,"execution_authorized":false}),
    )
}

impl Store {
    /// Trusted server/Host setup only. Never expose this as a model tool or accept a
    /// JS-authored manifest as proof of authorization. The ID is generated here.
    pub(super) fn issue_context_tool_grant(&self, context: &str, input: Issue) -> Result<Value> {
        if ![&input.request_id, &input.entry_id, &input.claim_id]
            .iter()
            .all(|s| valid_id(s))
        {
            bail!("invalid scoped tool grant request")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let source = inbox::claimed_in(
            &tx,
            &self.node_id,
            context,
            &input.entry_id,
            &input.claim_id,
        )?;
        let target = target_in(&tx, &self.node_id, context, &source, &input.target)?;
        let command_key = format!(
            "coordinator-context-tool-issue-v2:{}",
            json!([context, input.request_id])
        );
        if let Some(old) = load(&tx, &command_key)? {
            if old["request"] != serde_json::to_value(&input)? {
                bail!("scoped tool grant request identity conflict")
            }
            let id = old["grant_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("server grant receipt missing"))?;
            return Ok(grant_view(&checked_grant(
                &tx,
                &self.node_id,
                context,
                id,
                Access::Stage,
            )?));
        }
        let parameters = schema(&input.target);
        let grant = Grant {
            grant_id: uuid::Uuid::new_v4().to_string(),
            context_key: context.into(),
            action: action(&input.target).into(),
            issue: input,
            authority: source["authority"].clone(),
            source: source_identity(&source),
            target,
            schema_hash: hash(&parameters),
            schema: parameters,
            implementation_id: IMPLEMENTATION.into(),
        };
        insert(&tx, &grant_key(&grant.grant_id), &grant)?;
        insert(
            &tx,
            &command_key,
            &json!({"request":grant.issue,"grant_id":grant.grant_id}),
        )?;
        tx.commit()?;
        Ok(grant_view(&grant))
    }

    /// The Host must obtain invocation from an owned, flushed journal tool/call
    /// event. Model args contain only {} or {text}; no model-supplied IDs are trusted.
    /// This endpoint is not routed and cannot run a tool against external systems.
    pub(super) fn stage_context_tool(&self, context: &str, input: Stage) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let grant = checked_grant(&tx, &self.node_id, context, &input.grant_id, Access::Stage)?;
        check_stage(&grant, &input)?;
        let request = &input.invocation.request_id;
        let payload_hash = hash(&serde_json::to_value(&input)?);
        if let Some(old) = load(&tx, &receipt_key(context, request))? {
            if old["canonical_payload_sha256"] != payload_hash {
                bail!("scoped tool request payload conflict")
            }
            status_in(&tx, &self.node_id, context, &input.grant_id, request)?;
            return Ok(
                json!({"status":"already_recorded","request_id":request,"grant_id":input.grant_id,
                "status_read_required":true,"runtime_ready":false,"dispatch_allowed":false}),
            );
        }
        let use_key = format!("coordinator-context-tool-used-v2:{}", json!(grant.grant_id));
        if load(&tx, &use_key)?.is_some() {
            bail!("scoped tool grant already consumed; read status")
        }
        let receipt_id = uuid::Uuid::new_v4().to_string();
        let result = match &grant.issue.target {
            Target::ReadApprovedSummary {
                approval_request_id,
            } => summaries::read_in(&tx, &self.node_id, context, approval_request_id)?,
            Target::PublishReply => {
                let fence = format!(
                    "coordinator-context-tool-reply-source-v2:{}",
                    json!([context, grant.issue.entry_id, grant.issue.claim_id])
                );
                if load(&tx, &fence)?.is_some() {
                    bail!("source claim already has a staged reply")
                }
                insert(
                    &tx,
                    &fence,
                    &json!({"receipt_id":receipt_id,"grant_id":grant.grant_id}),
                )?;
                insert(
                    &tx,
                    &outbox_key(&receipt_id),
                    &json!({"state":"staging_outbox","context_key":context,
                    "grant_id":grant.grant_id,"request_id":request,"target":grant.target,"text":input.args["text"],
                    "entry_id":grant.issue.entry_id,"claim_id":grant.issue.claim_id,
                    "runtime_ready":false,"delivered":false}),
                )?;
                json!({"outbox_id":receipt_id,"target":grant.target,"state":"staging_outbox"})
            }
        };
        let receipt = Receipt {
            receipt_id: receipt_id.clone(),
            context_key: context.into(),
            request: input.clone(),
            canonical_payload_sha256: payload_hash,
            result,
        };
        insert(&tx, &receipt_key(context, request), &receipt)?;
        insert(
            &tx,
            &use_key,
            &json!({"receipt_id":receipt_id,"request_id":request}),
        )?;
        let result = status_in(&tx, &self.node_id, context, &input.grant_id, request)?;
        tx.commit()?;
        Ok(result)
    }

    /// Response loss is resolved only by this read. It does not enqueue or publish.
    pub(super) fn context_tool_status(
        &self,
        context: &str,
        grant_id: &str,
        request_id: &str,
    ) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        status_in(&tx, &self.node_id, context, grant_id, request_id)
    }
}
