//! Bind one durable conversation message to one existing inbox delivery. No implicit replay/rebinding.
use super::{builder_authority, coordinator_control, model::*, operations::State, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dispatch {
    pub operation_id: String,
    pub control_revision: u64,
    pub attempt: u64,
    pub epoch: u64,
}
fn key(message: &str) -> String {
    format!("coordinator-input:{}", json!(message))
}
fn source(db: &Connection, conversation: &str, message: &str) -> Result<Value> {
    let body:String=db.query_row("SELECT body FROM conversation_messages WHERE conversation_id=?1 AND id=?2 AND actor='human:local_owner'",params![conversation,message],|r|r.get(0))?;
    Ok(serde_json::from_str(&body)?)
}
pub(super) fn read(db: &Connection, conversation: &str, message: &str) -> Result<Option<Value>> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(message)],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| {
        let mut row: Value = serde_json::from_str(&s)?;
        row["message"] = source(db, conversation, message)?;
        Ok(row)
    })
    .transpose()
}
impl Store {
    pub fn coordinator_input(&self, conversation: &str, message: &str) -> Result<Option<Value>> {
        if !valid_id(conversation) || !valid_id(message) {
            bail!("invalid Coordinator input identity")
        }
        read(&self.db.lock(), conversation, message)
    }
    pub fn dispatch_coordinator_input(
        &self,
        conversation: &str,
        message: &str,
        input: Dispatch,
    ) -> Result<Value> {
        if ![conversation, message, &input.operation_id]
            .iter()
            .all(|v| valid_id(v))
            || input.control_revision == 0
            || input.attempt == 0
            || input.epoch == 0
        {
            bail!("invalid Coordinator input")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        if let Some(prior) = read(&tx, conversation, message)? {
            if prior["request"] != request {
                bail!("Coordinator input already bound to a different control")
            };
            return Ok(prior);
        }
        super::coordinator_close::ensure_open(&tx, &input.operation_id, input.attempt)?;
        let human = source(&tx, conversation, message)?;
        let team = human["team_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid conversation team"))?;
        let control = coordinator_control::current_in(&tx, team)?
            .ok_or_else(|| anyhow::anyhow!("Coordinator control missing"))?;
        if control["revision"] != input.control_revision
            || control["request"]["operation_id"] != input.operation_id
            || control["request"]["attempt"] != input.attempt
            || control["request"]["epoch"] != input.epoch
            || control["conversation_id"] != conversation
            || control["request"]["team_revision"] != human["team_revision"]
            || control["request"]["activation_revision"] != human["activation_revision"]
        {
            bail!("Coordinator input control or activation mismatch")
        }
        let op = builder_authority::operation(&tx, &input.operation_id)?;
        let at = now();
        if op.state != State::Active
            || op.attempt != input.attempt
            || op.epoch != input.epoch
            || op.worker.node_id != self.node_id
            || op.lease_until.is_none_or(|t| t <= at)
        {
            bail!("Coordinator input requires active local lease")
        }
        super::operation_grant::admit(&tx, &op, at)?;
        super::operation_budget::admit(&tx, &op, at)?;
        if !super::resource_admission::admit(&tx, &op, at)?.allowed {
            bail!("Coordinator resource unavailable")
        }
        let registered: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
            [&op.worker.session_id],
            |r| r.get(0),
        )?;
        if !registered {
            bail!("Coordinator session not registered")
        }
        let source_session = format!("coordinator-owner-{:x}", Sha256::digest(team.as_bytes()));
        let delivery = Self::insert_in(
            &tx,
            Message {
                id: uuid::Uuid::new_v4().to_string(),
                source: Address {
                    node_id: self.node_id.clone(),
                    session_id: source_session,
                },
                target: op.worker.clone(),
                content: serde_json::to_string(
                    &json!({"format":"kode.coordinator.input.v1","conversation_id":conversation,"source_message_id":message,"operation_id":op.id}),
                )?,
                idempotency_key: format!("coordinator-input-{}", uuid::Uuid::new_v4()),
                in_reply_to: None,
                hop_count: 0,
                created_at: at,
                expires_at: at + 86400000,
                status: Status::Received,
                detail: None,
            },
        )?;
        let mut result = json!({"request":request,"receipt":{"source_message_id":message,"conversation_id":conversation,"team_id":team,"operation_id":op.id,"message_id":delivery.id,"worker":op.worker,"home_hub":self.node_id,"actor":{"kind":"human","id":"local_owner"},"state":"queued","created_at":at}});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(message), serde_json::to_string(&result)?],
        )?;
        tx.execute(
            "INSERT INTO team_events(team_id,body) VALUES (?1,?2)",
            params![
                team,
                serde_json::to_string(
                    &json!({"kind":"coordinator_input_queued","receipt":result["receipt"]})
                )?
            ],
        )?;
        result["message"] = human;
        tx.commit()?;
        Ok(result)
    }
}
