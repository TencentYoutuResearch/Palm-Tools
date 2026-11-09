//! Human Builder messages reuse the durable inbox; text never changes answers or grants.
use super::{builder_authority, model::*, operations::State, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub request_id: String,
    pub draft_id: String,
    pub attempt: u64,
    pub epoch: u64,
    pub content: String,
}
fn key(operation: &str, request: &str) -> String {
    format!("builder-input:{}", json!([operation, request]))
}
fn read(db: &Connection, operation: &str, request: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(operation, request)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|b| Ok(serde_json::from_str(&b)?)).transpose()
}
impl Store {
    pub fn builder_input(&self, operation: &str, request: &str) -> Result<Option<Value>> {
        if !valid_id(operation) || !valid_id(request) {
            bail!("invalid Builder input identity")
        }
        read(&self.db.lock(), operation, request)
    }
    pub fn enqueue_builder_input(&self, id: &str, input: Input) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = self.enqueue_builder_input_in(&tx, id, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub(super) fn enqueue_builder_input_in(
        &self,
        tx: &rusqlite::Transaction,
        id: &str,
        input: Input,
    ) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || !valid_id(&input.draft_id)
            || input.attempt == 0
            || input.epoch == 0
            || input.content.trim().is_empty()
            || input.content.len() > 16384
            || input.content.contains('\0')
        {
            bail!("invalid Builder input")
        }
        let request = serde_json::to_value(&input)?;
        if let Some(prior) = read(&tx, id, &input.request_id)? {
            if prior["request"] != request {
                bail!("Builder input identity conflict")
            }
            return Ok(prior);
        }
        super::builder_close::ensure_open(&tx, id, input.attempt)?;
        let op = builder_authority::operation(&tx, id)?;
        let at = now();
        if op.state != State::Active
            || op.attempt != input.attempt
            || op.epoch != input.epoch
            || op.worker.node_id != self.node_id
            || op.lease_until.is_none_or(|until| until <= at)
            || !op.budget_required
            || !op.grant_required
        {
            bail!("Builder input requires active authorized local operation")
        }
        super::operation_budget::admit(&tx, &op, at)?;
        super::operation_grant::admit(&tx, &op, at)?;
        if op.resource_required && !super::resource_admission::admit(&tx, &op, at)?.allowed {
            bail!("Builder input resource unavailable")
        }
        let fixed = builder_authority::scope(&tx, id, op.attempt)?
            .ok_or_else(|| anyhow::anyhow!("Builder scope missing"))?;
        let body: String = tx.query_row(
            "SELECT body FROM builder_draft_revisions WHERE id=?1 ORDER BY revision DESC LIMIT 1",
            [&input.draft_id],
            |r| r.get(0),
        )?;
        let draft: Value = serde_json::from_str(&body)?;
        if fixed["request"]["draft_id"] != input.draft_id
            || fixed["request"]["epoch"] != input.epoch
            || draft["status"] != "draft"
            || fixed["workspaces"] != draft["interview"]["workspace_refs"]
        {
            bail!("Builder input draft scope changed")
        }
        let registered: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
            [&op.worker.session_id],
            |r| r.get(0),
        )?;
        if !registered {
            bail!("Builder input session is not registered")
        }
        let content = serde_json::to_string(
            &json!({"format":"kode.builder.input.v1","operation_id":id,"request_id":input.request_id}),
        )?;
        let message = Self::insert_in(
            &tx,
            Message {
                id: uuid::Uuid::new_v4().to_string(),
                source: Address {
                    node_id: self.node_id.clone(),
                    session_id: format!("builder-owner-{id}"),
                },
                target: op.worker.clone(),
                content,
                idempotency_key: format!("builder-input-{}", uuid::Uuid::new_v4()),
                in_reply_to: None,
                hop_count: 0,
                created_at: at,
                expires_at: at + 86400000,
                status: Status::Received,
                detail: None,
            },
        )?;
        let result = json!({"request":request,"receipt":{"operation_id":id,"message_id":message.id,"worker":op.worker,"home_hub":self.node_id,"actor":{"kind":"human","id":"local_owner"},"state":"queued","created_at":at}});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(id, &input.request_id), serde_json::to_string(&result)?],
        )?;
        Ok(result)
    }
}
