//! Atomic owner-authored root + context + exact input reference. No HTTP route,
//! runtime, legacy inbox delivery, or historical transcript import is enabled here.
use super::storage;
use crate::messaging::{
    coordinator_context_input as input_refs, coordinator_context_registry as registry,
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::messaging) struct Create {
    pub request_id: String,
    pub surface_id: String,
    pub expected_surface_revision: u64,
    pub team_id: String,
    pub team_revision: u64,
    pub audience_revision: u64,
    pub content: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    origin_kind: String,
    request_sha256: String,
    context_key: String,
    source_message_id: String,
    input_request_id: String,
}

fn result(context: &registry::Record, receipt: &Receipt) -> Value {
    json!({"context_key":context.key,"context_scope":context.context_scope,
        "surface_id":context.surface_id,"thread_id":context.thread_id,
        "source_message_id":receipt.source_message_id,"input_request_id":receipt.input_request_id,
        "delivery_state":"stored_only","execution_authorized":false,"runtime_ready":false,
        "readiness_reason":"scoped_runtime_incomplete"})
}

impl Store {
    /// Future callers must authenticate the local owner. This exact new root is
    /// explicitly authorized by Create; that authority never extends to old roots.
    pub(in crate::messaging) fn create_scoped_thread(&self, input: Create) -> Result<Value> {
        if ![&input.request_id, &input.surface_id, &input.team_id]
            .iter()
            .all(|id| valid_id(id))
            || !storage::text(&input.content, 65536)
            || input.expected_surface_revision == 0
            || input.team_revision == 0
            || input.audience_revision == 0
        {
            bail!("invalid scoped thread create request")
        }
        let request_sha256 = storage::digest(&serde_json::to_string(&input)?);
        let receipt_key = format!(
            "coordinator-thread-create-v2:{}",
            json!([self.node_id, input.request_id])
        );
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let surface = storage::surface(&tx, &self.node_id, &input.surface_id, true)?;
        if surface.audience_revision != input.audience_revision {
            bail!("scoped thread audience changed")
        }
        storage::check_team(
            &tx,
            &surface,
            &input.team_id,
            Some(input.team_revision),
            None,
        )?;
        let old: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&receipt_key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let receipt: Receipt = serde_json::from_str(&old)?;
            if receipt.request_sha256 != request_sha256 || receipt.origin_kind != "atomic_new_root"
            {
                bail!("scoped thread request identity conflict")
            }
            let context = registry::read_in(&tx, &self.node_id, &receipt.context_key)?;
            if context.surface_id != input.surface_id
                || context.thread_id != receipt.source_message_id
                || context.context_scope.team_id != input.team_id
                || context.team_revision != input.team_revision
                || context.audience_revision != input.audience_revision
            {
                bail!("scoped thread receipt origin mismatch")
            }
            let source =
                input_refs::read_in(&tx, &self.node_id, &context.key, &receipt.input_request_id)?;
            if source["receipt"]["source_message_id"] != receipt.source_message_id
                || source["message"]["content"] != input.content
            {
                bail!("scoped thread exact root changed")
            }
            return Ok(result(&context, &receipt));
        }
        if surface.revision != input.expected_surface_revision {
            bail!("scoped thread surface revision changed")
        }
        let root = uuid::Uuid::new_v4().to_string();
        storage::insert_message(
            &tx,
            &surface.id,
            &root,
            "discussion",
            json!({
            "id":root,"surface_id":surface.id,"thread_id":root,"scope":surface.scope,
            "actor":{"kind":"human","id":"local_owner"},"kind":"discussion","content":input.content,
            "mentions":[{"team_id":input.team_id,"team_revision":input.team_revision,"worker_id":null}],
            "created_at":now(),"delivery_state":"stored_only","execution_authorized":false,
            "delivery_reason":"isolated_context_required",
            "context_readiness":{"state":"not_ready","reason":"isolated_context_required",
                "isolation":"unavailable","legacy_shared_session_reused":false}}),
        )?;
        let internal_request = format!("thread-create-{}", storage::digest(&receipt_key));
        let context = registry::register_in(
            &tx,
            &self.node_id,
            registry::Register {
                request_id: internal_request.clone(),
                surface_id: surface.id,
                thread_id: root.clone(),
                team_id: input.team_id,
                team_revision: input.team_revision,
                audience_revision: input.audience_revision,
            },
        )?;
        // Registration's watermark includes this just-created root. The owner Create
        // request explicitly authorizes exactly this root, not any preexisting message.
        input_refs::record_in(
            &tx,
            &self.node_id,
            &context.key,
            input_refs::RecordInput {
                request_id: internal_request.clone(),
                source_message_id: root.clone(),
                expected_content_sha256: storage::digest(&input.content),
                explicitly_continue_stored: true,
            },
        )?;
        let receipt = Receipt {
            origin_kind: "atomic_new_root".into(),
            request_sha256,
            context_key: context.key.clone(),
            source_message_id: root,
            input_request_id: internal_request,
        };
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![receipt_key, serde_json::to_string(&receipt)?],
        )?;
        let response = result(&context, &receipt);
        tx.commit()?;
        Ok(response)
    }
}
