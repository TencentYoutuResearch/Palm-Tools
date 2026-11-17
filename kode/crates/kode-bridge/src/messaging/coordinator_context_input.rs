//! Exact owner-input references for future scoped inboxes. No transcript is copied,
//! no runtime delivery is created, and no historical message is replayed automatically.
use super::{coordinator_context_registry as registry, model::valid_id, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecordInput {
    pub request_id: String,
    pub source_message_id: String,
    pub expected_content_sha256: String,
    /// An exact owner action for one stored, never-delivered input, not blanket history access.
    pub explicitly_continue_stored: bool,
}

fn source_key(id: &str) -> String {
    format!("coordinator-context-source-v2:{}", json!(id))
}
fn receipt_key(context: &str, request: &str) -> String {
    format!("coordinator-context-input-v2:{}", json!([context, request]))
}
fn load(db: &Connection, key: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn source(
    db: &Connection,
    context: &registry::Record,
    request: &RecordInput,
) -> Result<(u64, Value)> {
    let (seq,body):(u64,String)=db.query_row("SELECT seq,body FROM collaboration_messages WHERE id=?1 AND surface_id=?2 AND thread_id=?3 AND kind='discussion'",
        params![request.source_message_id,context.surface_id,context.thread_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let row: Value = serde_json::from_str(&body)?;
    let content = row["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("context source content unavailable"))?;
    if row["id"] != request.source_message_id
        || row["surface_id"] != context.surface_id
        || row["thread_id"] != context.thread_id
        || row["actor"] != json!({"kind":"human","id":"local_owner"})
        || row["kind"] != "discussion"
        || row["execution_authorized"] != false
        || row["scope"] != serde_json::to_value(&context.origin)?
        || format!("{:x}", Sha256::digest(content.as_bytes())) != request.expected_content_sha256
    {
        bail!("context source identity or content changed")
    }
    // A receipt may represent a completed or uncertain effect. Neither is replay permission.
    let prior:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM collaboration_coordinator_inputs WHERE id=?1) OR EXISTS(SELECT 1 FROM workbench_documents WHERE key=?2)",
        params![request.source_message_id,format!("coordinator-input:{}",json!(request.source_message_id))],|r|r.get(0))?;
    if prior || !row["discussion_route"].is_null() || row["delivery_state"] != "stored_only" {
        bail!("context source has prior or uncertain delivery")
    }
    if seq <= context.start_sequence
        && (!request.explicitly_continue_stored
            || row["delivery_reason"] != "isolated_context_required")
    {
        bail!("stored context input requires exact owner continuation")
    }
    Ok((seq, row))
}

impl Store {
    /// Future owner-only endpoint must authenticate before calling. This records only
    /// references and a fingerprint; it is not an execution mandate or model admission.
    pub(super) fn record_context_input(
        &self,
        context_key: &str,
        input: RecordInput,
    ) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = record_in(&tx, &self.node_id, context_key, input)?;
        tx.commit()?;
        Ok(result)
    }

    /// Returns only the exact referenced current input, never thread scrollback.
    pub(super) fn context_input(&self, context_key: &str, request_id: &str) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        read_in(&tx, &self.node_id, context_key, request_id)
    }
}

/// Internal same-transaction input reference insertion; never runtime admission.
pub(super) fn record_in(
    tx: &rusqlite::Transaction,
    home: &str,
    context_key: &str,
    input: RecordInput,
) -> Result<Value> {
    if !valid_id(&input.request_id)
        || !valid_id(&input.source_message_id)
        || input.expected_content_sha256.len() != 64
        || !input
            .expected_content_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("invalid context input reference")
    }
    let context = registry::read_in(&tx, home, context_key)?;
    let (seq, _) = source(&tx, &context, &input)?;
    let request = serde_json::to_value(&input)?;
    let key = receipt_key(context_key, &input.request_id);
    if let Some(old) = load(&tx, &key)? {
        if old["request"] != request {
            bail!("context input request identity conflict")
        }
        return Ok(old);
    }
    if load(&tx, &source_key(&input.source_message_id))?.is_some() {
        bail!("context source already bound")
    }
    let result = json!({"context_key":context_key,"context_scope":context.context_scope,
            "source_message_id":input.source_message_id,"source_sequence":seq,"request":request,
            "delivery_state":"stored_only","execution_authorized":false,"runtime_ready":false,
            "readiness_reason":"scoped_runtime_incomplete"});
    for key in [key, source_key(&input.source_message_id)] {
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key, result.to_string()],
        )?;
    }
    Ok(result)
}

/// Revalidate scope and exact source in a callers existing transaction.
pub(super) fn read_in(
    tx: &Connection,
    home: &str,
    context_key: &str,
    request_id: &str,
) -> Result<Value> {
    let context = registry::read_in(&tx, home, context_key)?;
    let receipt = load(&tx, &receipt_key(context_key, request_id))?
        .ok_or_else(|| anyhow::anyhow!("context input missing"))?;
    if receipt["context_key"] != context_key
        || receipt["context_scope"] != serde_json::to_value(&context.context_scope)?
    {
        bail!("context input binding changed")
    }
    let request: RecordInput = serde_json::from_value(receipt["request"].clone())?;
    if request.request_id != request_id {
        bail!("context input receipt mismatch")
    }
    let (_, message) = source(&tx, &context, &request)?;
    Ok(json!({"receipt":receipt,"message":message}))
}
