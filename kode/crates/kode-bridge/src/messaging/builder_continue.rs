//! Explicit human confirmation and continuation commit together, using existing answer/input receipts.
use super::{builder_answers::Answer, builder_input::Input, model::valid_id, store::Store};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirm {
    pub draft_id: String,
    pub attempt: u64,
    pub epoch: u64,
    pub answer: Answer,
}
impl Store {
    pub fn continue_builder_answers(&self, id: &str, input: Confirm) -> Result<Value> {
        if !valid_id(id) || !valid_id(&input.draft_id) || input.attempt == 0 || input.epoch == 0 {
            bail!("invalid Builder answer continuation")
        }
        let message_request = format!(
            "answer-{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                input.draft_id,
                input.answer.request_id
            ]))?)
        );
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let draft = self.answer_builder_draft_in(&tx, &input.draft_id, input.answer)?;
        let message=self.enqueue_builder_input_in(&tx,id,Input{
            request_id:message_request,draft_id:input.draft_id,attempt:input.attempt,epoch:input.epoch,
            content:format!("The owner confirmed answers in Builder draft revision {}. Read the current draft, reuse its confirmed answers, and continue the interview with at most three unresolved questions or a reviewable proposal. This confirmation does not activate a team or expand permissions.",draft["revision"]),
        })?;
        tx.commit()?;
        Ok(json!({"draft":draft,"input":message}))
    }
}
