//! Tool-free, exact-input call proof. Hashes record trusted Host observations;
//! only current server binding, grant, lease and source ownership authorize a call.
use super::{
    coordinator_context_inbox as inbox, coordinator_control, model::valid_id,
    official_calls::Begin, operations::Operation,
};
use anyhow::{bail, Result};
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proof {
    pub schema_version: u64,
    pub profile_id: String,
    pub host_binding_id: String,
    pub context_key: String,
    pub session_id: String,
    pub journal_id: String,
    pub entry_id: String,
    pub claim_id: String,
    pub source_message_id: String,
    pub source_content_sha256: String,
    pub request_sha256: String,
    pub tools_sha256: String,
    pub manifest_sha256: String,
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn source_fence_key(context:&str,entry:&str)->String {
    format!("coordinator-context-call-source-v2:{}",json!([context,entry]))
}
/// Called inside the original official_calls transaction. Fence insertion rolls
/// back with all accounting/admission failures and with the call insertion itself.
pub(super) fn prepare_in(tx: &Transaction, op: &Operation, request: &Begin, at: u64) -> Result<()> {
    let binding = coordinator_control::operation_binding(tx, &op.id)?;
    let scoped = binding
        .as_ref()
        .is_some_and(|b| b.get("context_scope").is_some());
    let proof = request
        .prompt_provenance
        .as_ref()
        .and_then(|p| p.scoped_call.as_ref());
    if !scoped {
        if proof.is_some() {
            bail!("scoped call proof requires scoped operation")
        }
        return Ok(());
    }
    let proof =
        proof.ok_or_else(|| anyhow::anyhow!("scoped conversation call provenance not ready"))?;
    if proof.schema_version != 1
        || proof.profile_id != "conversation_reply_v1"
        || ![
            &proof.host_binding_id,
            &proof.session_id,
            &proof.journal_id,
            &proof.entry_id,
            &proof.claim_id,
            &proof.source_message_id,
        ]
        .iter()
        .all(|id| valid_id(id))
        || ![
            &proof.context_key,
            &proof.source_content_sha256,
            &proof.request_sha256,
            &proof.tools_sha256,
            &proof.manifest_sha256,
        ]
        .iter()
        .all(|h| hash(h))
        || proof.tools_sha256 != format!("{:x}", Sha256::digest(b"[]"))
    {
        bail!("invalid conversation call proof or nonempty tool catalog")
    }
    let control = binding.unwrap();
    if control["context_key"] != proof.context_key
        || control["journal_id"] != proof.journal_id
        || op.worker.session_id != proof.session_id
        || request.worker_session != proof.session_id
    {
        bail!("conversation call control identity mismatch")
    }
    let source = inbox::conversation_claim_in(
        tx,
        &op.worker.node_id,
        &proof.context_key,
        &proof.host_binding_id,
        &proof.entry_id,
        &proof.claim_id,
        at,
    )?;
    let frozen = &source["frozen"];
    if source["entry"]["source_message_id"] != proof.source_message_id
        || source["entry"]["source_content_sha256"] != proof.source_content_sha256
        || source["entry"]["operation_id"] != op.id
        || frozen["manifest_sha256"] != proof.manifest_sha256
        || frozen["manifest"] != json!({"profile":"conversation_reply_v1","version":1,"tools":[]})
        || frozen["execution_target"]["provider_id"] != request.provider
        || frozen["execution_target"]["model_id"] != request.model
    {
        bail!("conversation call differs from frozen source or model")
    }
    let prompt = request.prompt_provenance.as_ref().unwrap();
    if prompt
        .instruction
        .as_ref()
        .is_none_or(|i| i.role != "coordinator")
        || prompt.system_messages == 0
    {
        bail!("conversation system prompt provenance missing")
    }
    let fence = source_fence_key(&proof.context_key,&proof.entry_id);
    let native_attempt:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM workbench_documents WHERE key=?1)",
        [format!("coordinator-context-native-attempt-v2:{}",json!([op.id,op.attempt,op.epoch]))],|r|r.get(0))?;
    if native_attempt {bail!("conversation attempt already belongs to native execution")}
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM workbench_documents WHERE key=?1)",
        [&fence],
        |r| r.get(0),
    )?;
    if exists {
        bail!("conversation source already has a call; reconcile instead of replay")
    }
    tx.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![fence,
        json!({"call_id":request.call_id,"operation_id":op.id,"attempt":op.attempt,"epoch":op.epoch,
            "proof":proof,"state":"call_admitted"}).to_string()],
    )?;
    Ok(())
}
