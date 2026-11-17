//! Durable, owner-requested context identities. Registration does not start a runtime,
//! authorize history reuse, or make a context ready. No HTTP entry point exists yet.
use super::{
    collaboration::context_access::{self, Origin},
    coordinator_context_scope::ContextScope,
    model::valid_id,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Register {
    pub request_id: String,
    pub surface_id: String,
    pub thread_id: String,
    pub team_id: String,
    pub team_revision: u64,
    pub audience_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub context_scope: ContextScope,
    pub key: String,
    pub surface_id: String,
    pub thread_id: String,
    pub audience_revision: u64,
    pub team_revision: u64,
    pub origin: Origin,
    pub request_id: String,
    /// Registration watermark, not authorization to import older discussion content.
    pub start_sequence: u64,
}

fn document_key(key: &str) -> String {
    format!("coordinator-context-v2:{key}")
}
fn receipt_key(home: &str, request: &str) -> String {
    format!(
        "coordinator-context-request-v2:{}",
        serde_json::json!([home, request])
    )
}
fn read_raw(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?)
}
fn insert(db: &Connection, key: &str, value: &impl Serialize) -> Result<()> {
    db.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}

/// Revalidates the persisted origin on every use. A caller must use its authoritative
/// local home, never a home supplied by a session or copied from an untrusted scope.
pub(super) fn read_in(db: &Connection, home: &str, key: &str) -> Result<Record> {
    if key.len() != 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("invalid context registry key")
    }
    let row: Record = serde_json::from_str(
        &read_raw(db, &document_key(key))?
            .ok_or_else(|| anyhow::anyhow!("context not registered"))?,
    )?;
    if row.key != key
        || row.context_scope.key()? != key
        || row.context_scope.home_hub != home
        || !valid_id(&row.request_id)
    {
        bail!("context registry identity mismatch")
    }
    let (scope, origin) = context_access::resolve(
        db,
        home,
        &row.surface_id,
        &row.thread_id,
        &row.context_scope.team_id,
        row.team_revision,
        row.audience_revision,
    )?;
    if scope != row.context_scope || origin != row.origin {
        bail!("context origin changed")
    }
    Ok(row)
}

/// Registers only inside the caller's atomic owner transaction.
pub(super) fn register_in(tx: &Transaction, home: &str, input: Register) -> Result<Record> {
    if ![
        &input.request_id,
        &input.surface_id,
        &input.thread_id,
        &input.team_id,
    ]
    .iter()
    .all(|id| valid_id(id))
    {
        bail!("invalid context registration request")
    }
    let (scope, origin) = context_access::resolve(
        tx,
        home,
        &input.surface_id,
        &input.thread_id,
        &input.team_id,
        input.team_revision,
        input.audience_revision,
    )?;
    let key = scope.key()?;
    let receipt = receipt_key(home, &input.request_id);
    if let Some(old) = read_raw(tx, &receipt)? {
        if serde_json::from_str::<Register>(&old)? != input {
            bail!("context request identity conflict")
        }
        return read_in(tx, home, &key);
    }
    if read_raw(tx, &document_key(&key))?.is_some() {
        bail!("context scope already registered by another request")
    }
    let start_sequence = tx.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM collaboration_messages",
        [],
        |r| r.get(0),
    )?;
    let row = Record {
        context_scope: scope,
        key,
        origin,
        surface_id: input.surface_id.clone(),
        thread_id: input.thread_id.clone(),
        team_revision: input.team_revision,
        audience_revision: input.audience_revision,
        request_id: input.request_id.clone(),
        start_sequence,
    };
    insert(tx, &document_key(&row.key), &row)?;
    insert(tx, &receipt, &input)?;
    Ok(row)
}

impl Store {
    /// Internal owner-only entry point. Future routes must authenticate the local owner;
    /// neither a session token nor an arbitrary context_scope can authorize registration.
    pub(super) fn register_coordinator_context(&self, input: Register) -> Result<Record> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let row = register_in(&tx, &self.node_id, input)?;
        tx.commit()?;
        Ok(row)
    }

    pub(super) fn coordinator_context(&self, key: &str) -> Result<Record> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        read_in(&tx, &self.node_id, key)
    }
}
