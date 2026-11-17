//! Exact owner-approved summary sharing, not ambient cross-thread history access.
//! No HTTP/model tool can create approvals here. Callers must authenticate the owner.
use super::{
    coordinator_context_registry as registry, coordinator_context_scope::ContextScope,
    model::valid_id, store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ApproveSummary {
    pub request_id: String,
    pub source_context_key: String,
    pub target_context_key: String,
    pub source_message_id: String,
    pub expected_source_content_sha256: String,
    pub expected_target_audience_revision: u64,
    pub summary: String,
    pub summary_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    request: ApproveSummary,
    source_scope: ContextScope,
    target_scope: ContextScope,
    source_sequence: u64,
}

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn key(home: &str, request: &str) -> String {
    format!("coordinator-context-summary-v2:{}", json!([home, request]))
}
fn load(db: &Connection, home: &str, request: &str) -> Result<Option<Approval>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(home, request)],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn validate(
    db: &Connection,
    home: &str,
    input: &ApproveSummary,
) -> Result<(registry::Record, registry::Record, u64)> {
    if !valid_id(&input.request_id)
        || !valid_id(&input.source_message_id)
        || !hex(&input.expected_source_content_sha256)
        || !hex(&input.summary_sha256)
        || input.summary.trim().is_empty()
        || input.summary.len() > 16384
        || input.summary.contains('\0')
        || input.source_context_key == input.target_context_key
        || digest(&input.summary) != input.summary_sha256
        || input.expected_target_audience_revision == 0
    {
        bail!("invalid exact summary approval")
    }
    let source = registry::read_in(db, home, &input.source_context_key)?;
    let target = registry::read_in(db, home, &input.target_context_key)?;
    if target.audience_revision != input.expected_target_audience_revision {
        bail!("summary destination audience changed")
    }
    let (seq,body):(u64,String)=db.query_row(
        "SELECT seq,body FROM collaboration_messages WHERE id=?1 AND surface_id=?2 AND thread_id=?3 AND kind='discussion'",
        params![input.source_message_id,source.surface_id,source.thread_id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let row: Value = serde_json::from_str(&body)?;
    let content = row["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("summary source unavailable"))?;
    if row["id"] != input.source_message_id
        || row["surface_id"] != source.surface_id
        || row["thread_id"] != source.thread_id
        || row["kind"] != "discussion"
        || row["scope"] != serde_json::to_value(&source.origin)?
        || row["actor"] != json!({"kind":"human","id":"local_owner"})
        || digest(content) != input.expected_source_content_sha256
    {
        bail!("summary source identity or content changed")
    }
    Ok((source, target, seq))
}
fn presentation(approval: &Approval) -> Value {
    let input = &approval.request;
    json!({"approval_request_id":input.request_id,"target_context_key":input.target_context_key,
        "summary":input.summary,"summary_sha256":input.summary_sha256,
        "source_reference":{"context_key":input.source_context_key,"message_id":input.source_message_id},
        "execution_authorized":false,"runtime_ready":false})
}
fn checked(db: &Connection, home: &str, target: &str, request: &str) -> Result<Value> {
    if !valid_id(request) {
        bail!("invalid summary approval identity")
    }
    let approval = load(db, home, request)?
        .ok_or_else(|| anyhow::anyhow!("exact summary approval required"))?;
    if approval.request.target_context_key != target || approval.request.request_id != request {
        bail!("summary approval destination mismatch")
    }
    let (source, destination, seq) = validate(db, home, &approval.request)?;
    if source.context_scope != approval.source_scope
        || destination.context_scope != approval.target_scope
        || seq != approval.source_sequence
    {
        bail!("summary approval origin changed")
    }
    Ok(presentation(&approval))
}

/// Pure same-transaction read for server-owned tools; no approval creation.
pub(super) fn read_in(db: &Connection, home: &str, target: &str, request: &str) -> Result<Value> {
    checked(db, home, target, request)
}

impl Store {
    /// Only an explicit owner approval may call this. A future model tool may read
    /// approved summaries but must never create them or select a broader recipient.
    pub(super) fn approve_context_summary(&self, input: ApproveSummary) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let (source, target, seq) = validate(&tx, &self.node_id, &input)?;
        if let Some(old) = load(&tx, &self.node_id, &input.request_id)? {
            if old.request != input {
                bail!("summary approval request identity conflict")
            }
            return checked(
                &tx,
                &self.node_id,
                &input.target_context_key,
                &input.request_id,
            );
        }
        let approval = Approval {
            request: input,
            source_scope: source.context_scope,
            target_scope: target.context_scope,
            source_sequence: seq,
        };
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![
                key(&self.node_id, &approval.request.request_id),
                serde_json::to_string(&approval)?
            ],
        )?;
        tx.commit()?;
        Ok(presentation(&approval))
    }

    /// Returns the one approved summary plus opaque source reference, never source
    /// messages, other summaries, thread scrollback, or implicit execution authority.
    /// A future model-facing adapter must derive target_context_key from its trusted
    /// session binding, never accept an arbitrary destination supplied by the model.
    pub(super) fn approved_context_summary(
        &self,
        target_context_key: &str,
        request_id: &str,
    ) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        checked(&tx, &self.node_id, target_context_key, request_id)
    }
}
