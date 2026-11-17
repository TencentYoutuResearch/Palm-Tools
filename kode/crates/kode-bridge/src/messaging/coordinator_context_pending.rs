//! Read-only Prepared staging drain inspection. Not production close permission.
//! Unknown states and mismatched ownership never mean empty. No legacy rows change.
use super::{coordinator_context_inbox as inbox, store::Store};
use anyhow::{bail, Result};
use rusqlite::Transaction;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Default, Serialize, PartialEq)]
pub(super) struct Pending {
    pub pending: u64,
    pub claimed: u64,
    pub uncertain: u64,
    pub completed: u64,
    pub unconsumed_tool_outbox: u64,
}
impl Pending {
    /// Ledger drain only. Never a model, tool, lease or accounting authorization.
    pub fn is_drained(&self) -> bool {
        self.pending == 0
            && self.claimed == 0
            && self.uncertain == 0
            && self.unconsumed_tool_outbox == 0
    }
}

pub(super) fn read_in(
    tx: &Transaction,
    home: &str,
    context: &str,
    operation: &str,
    journal: &str,
) -> Result<Pending> {
    let a = inbox::authority_in(tx, home, context)?;
    if a.operation.id != operation || a.journal_id != journal {
        bail!("scoped pending operation or journal mismatch")
    }
    let mut result = Pending::default();
    let prefix = format!("coordinator-context-inbox-v2:{context}:");
    let mut q = tx.prepare(
        "SELECT key FROM workbench_documents WHERE substr(key,1,length(?1))=?1 ORDER BY key",
    )?;
    let keys = q.query_map([&prefix], |r| r.get::<_, String>(0))?;
    for key in keys {
        let key = key?;
        let entry = inbox::pending_metadata_in(tx, home, &a, &key[prefix.len()..])?;
        match entry["state"].as_str() {
            Some("pending") => result.pending += 1,
            Some("claimed") => result.claimed += 1,
            Some("uncertain") => result.uncertain += 1,
            Some("completed") => result.completed += 1,
            _ => bail!("unknown scoped inbox state"),
        }
    }
    // Project away reply text: this inspector returns counts, never private content.
    let mut q = tx.prepare("SELECT json_remove(value,'$.text') FROM workbench_documents WHERE substr(key,1,length(?1))=?1 AND json_extract(value,'$.context_key')=?2")?;
    let rows = q.query_map(
        rusqlite::params!["coordinator-context-tool-outbox-v2:", context],
        |r| r.get::<_, String>(0),
    )?;
    for raw in rows {
        let row: Value = serde_json::from_str(&raw?)?;
        if row["state"] != "staging_outbox"
            || row["delivered"] != false
            || row["runtime_ready"] != false
            || row["target"]["context_key"] != context
            || row["target"]["surface_id"] != a.context.surface_id
            || row["target"]["thread_id"] != a.context.thread_id
            || row["target"]["audience_revision"] != a.context.audience_revision
        {
            bail!("unknown or mismatched scoped tool outbox")
        }
        let id = row["entry_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("outbox source missing"))?;
        let entry = inbox::pending_metadata_in(tx, home, &a, id)?;
        if entry["state"] == "pending"
            || entry["claim_id"].is_null()
            || entry["claim_id"] != row["claim_id"]
            || entry["source_message_id"] != row["target"]["source_message_id"]
        {
            bail!("scoped outbox claim mismatch")
        }
        result.unconsumed_tool_outbox += 1;
    }
    Ok(result)
}

impl Store {
    pub(super) fn context_pending(
        &self,
        context: &str,
        operation: &str,
        journal: &str,
    ) -> Result<Pending> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        read_in(&tx, &self.node_id, context, operation, journal)
    }
}
