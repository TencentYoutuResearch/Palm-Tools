//! Home-owned Worker clarification observations. Questions grant no execution or completion authority.
use super::{
    assignment_resources,
    model::{now, valid_id},
    official_calls,
    operations::State,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<Choice>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "isOther", alias = "is_other")]
    pub is_other: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "isSecret", alias = "is_secret")]
    pub is_secret: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub request_id: String,
    pub call_id: String,
    pub command: Value,
    pub questions: Vec<Question>,
}
fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}
impl Record {
    fn validate(&self) -> Result<()> {
        if !valid_id(&self.request_id)
            || !valid_id(&self.call_id)
            || self.questions.is_empty()
            || self.questions.len() > 8
            || serde_json::to_vec(&self.questions)?.len() > 32768
            || serde_json::to_vec(self)?.len() > 131072
        {
            bail!("invalid Worker clarification bounds")
        }
        let mut ids = BTreeSet::new();
        for q in &self.questions {
            if !text(&q.id, 128)
                || !ids.insert(&q.id)
                || !text(&q.question, 4096)
                || q.header
                    .as_ref()
                    .is_some_and(|s| s.len() > 256 || s.contains('\0'))
                || q.options.as_ref().is_some_and(|options| {
                    options.len() > 8
                        || options.iter().any(|o| {
                            !text(&o.label, 256)
                                || o.description
                                    .as_ref()
                                    .is_some_and(|s| s.len() > 1024 || s.contains('\0'))
                        })
                })
            {
                bail!("invalid Worker clarification question")
            }
        }
        Ok(())
    }
}
fn key(assignment: &str, request: &str) -> String {
    format!("assignment-clarification:{}", json!([assignment, request]))
}
// The primary projection is retained for existing consumers. The list is authoritative
// for concurrent branches, and historical immutable receipts remain independently readable.
pub(super) fn pending(run: &Value) -> Vec<Value> {
    run["clarifications"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            run["pending_clarification"]
                .as_object()
                .map(|_| vec![run["pending_clarification"].clone()])
                .unwrap_or_default()
        })
}
fn set_pending(run: &mut Value, questions: Vec<Value>) {
    let fields = run.as_object_mut().expect("WorkRun object");
    if let Some(first) = questions.first() {
        fields.insert("pending_clarification".into(), first.clone());
        fields.insert("clarifications".into(), json!(questions));
    } else {
        fields.remove("pending_clarification");
        fields.remove("clarifications");
    }
}
pub(super) fn clear_pending(run: &mut Value, stage: Option<&str>) -> Vec<Value> {
    let (removed, retained): (Vec<_>, Vec<_>) = pending(run)
        .into_iter()
        .partition(|q| stage.is_none_or(|id| q["stage_id"] == id));
    set_pending(run, retained);
    removed
}
pub(super) fn take_pending(run: &mut Value, assignment: &str, request: &str) -> Result<Value> {
    let mut questions = pending(run);
    let index = questions
        .iter()
        .position(|q| q["assignment_id"] == assignment && q["request"]["request_id"] == request)
        .ok_or_else(|| anyhow::anyhow!("Worker clarification is no longer pending"))?;
    let question = questions.remove(index);
    set_pending(run, questions);
    Ok(question)
}
fn append_pending(run: &mut Value, receipt: Value) -> Result<()> {
    let mut questions = pending(run);
    if questions.len() >= 128 {
        bail!("Worker clarification pending limit reached")
    }
    if questions
        .iter()
        .any(|q| q["request"]["call_id"] == receipt["request"]["call_id"])
    {
        bail!("Worker clarification model call already recorded")
    }
    questions.push(receipt);
    set_pending(run, questions);
    Ok(())
}
impl Store {
    pub fn assignment_clarification(&self, id: &str, request: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(request) {
            bail!("invalid Worker clarification identity")
        }
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [key(id, request)],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub(super) fn record_assignment_clarification(
        &self,
        executor: &str,
        id: &str,
        input: Record,
    ) -> Result<Value> {
        input.validate()?;
        if !valid_id(id) || !valid_id(executor) {
            bail!("invalid Worker clarification scope")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let assignment: Value = serde_json::from_str(&body)?;
        if assignment["worker"]["node_id"] != executor
            || assignment["dispatch"]["command"] != input.command
        {
            bail!("Worker clarification execution identity mismatch")
        }
        let prior: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [key(id, &input.request_id)],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            let saved: Value = serde_json::from_str(&prior)?;
            if saved["request"] != request {
                bail!("Worker clarification identity conflict")
            }
            return Ok(saved);
        }
        let at = now();
        let (mut run, op) = assignment_resources::authorized_context(&tx, id, &assignment, at)?;
        assignment_resources::assert_held(&tx, &assignment)?;
        if assignment["state"] != "prepared"
            || assignment["creation"]["state"] != "created"
            || op.state != State::Active
            || op.worker.node_id != executor
            || op.lease_until.is_none_or(|until| until <= at)
            || !super::assignment_mandate::consumed(&tx, &assignment, &self.node_id)?
        {
            bail!("Worker clarification requires its consumed active Assignment")
        }
        let call: String = tx.query_row(
            "SELECT body FROM official_calls WHERE id=?1",
            [&input.call_id],
            |r| r.get(0),
        )?;
        let call: official_calls::Call = serde_json::from_str(&call)?;
        if call.request.operation_id != op.id
            || call.request.attempt != op.attempt
            || call.request.epoch != op.epoch
            || call.request.worker_session != op.worker.session_id
            || call.state != "started"
        {
            bail!("Worker clarification model call identity mismatch")
        }
        let revision = run["revision"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("invalid WorkRun revision"))?
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("WorkRun revision exhausted"))?;
        let receipt = json!({"snapshot":"assignment_clarification_receipt.v1","request":request,"assignment_id":id,"run_id":run["id"],"team_id":run["team_id"],
            "worker":op.worker,"operation":input.command["operation"],"stage_id":assignment["stage_id"],
            "stage_attempt":assignment["stage_attempt"],"context_hash":assignment["context_hash"],
            "run_revision":revision,"home_hub":self.node_id,"state":"pending","completion_authorized":false,"recorded_at":at});
        run["revision"] = json!(revision);
        run["updated_at"] = json!(at);
        append_pending(&mut run, receipt.clone())?;
        run["waiting_reason"] = json!("worker_clarification_required");
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(id, &input.request_id), serde_json::to_string(&receipt)?],
        )?;
        tx.execute(
            "UPDATE work_runs SET revision=?2,body=?3 WHERE id=?1",
            params![run["id"].as_str(), revision, serde_json::to_string(&run)?],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![run["id"].as_str(),serde_json::to_string(&json!({"kind":"assignment_clarification_requested","revision":revision,"at":at,"actor":{"kind":"host","id":executor},"receipt":receipt}))?])?;
        tx.commit()?;
        Ok(receipt)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Record {
        serde_json::from_value(json!({"request_id":"question","call_id":"call","command":{},"questions":[{"id":"scope","question":"Which scope?"}]})).unwrap()
    }
    #[test]
    fn parallel_questions_preserve_order_and_stage_scoped_cleanup() {
        let q = |id: &str, stage: &str| json!({"stage_id":stage,"request":{"call_id":id}});
        let mut run = json!({"pending_clarification":q("old", "a")});
        append_pending(&mut run, q("second", "b")).unwrap();
        append_pending(&mut run, q("third", "a")).unwrap();
        let before = run.clone();
        assert!(append_pending(&mut run, q("second", "c")).is_err());
        assert_eq!(run, before);
        assert_eq!(clear_pending(&mut run, Some("a")).len(), 2);
        assert_eq!(run["pending_clarification"], q("second", "b"));
        assert_eq!(pending(&run).len(), 1);
        assert_eq!(clear_pending(&mut run, None), vec![q("second", "b")]);
        assert!(run["pending_clarification"].is_null());
        assert!(run["clarifications"].is_null());
    }
    #[test]
    fn pending_question_bound_does_not_mutate_on_rejection() {
        let mut run = json!({});
        for i in 0..128 {
            append_pending(&mut run, json!({"request":{"call_id":format!("call-{i}")}})).unwrap();
        }
        let before = run.clone();
        assert!(append_pending(&mut run, json!({"request":{"call_id":"overflow"}})).is_err());
        assert_eq!(run, before);
    }
    #[test]
    fn questions_are_bounded_and_cannot_carry_extra_authority() {
        let mut input = request();
        input.validate().unwrap();
        input.command = json!({"frozen_context":"x".repeat(40000)});
        input.validate().unwrap();
        input.questions.push(input.questions[0].clone());
        assert!(input.validate().is_err());
        input = request();
        input.questions[0].question = "x".repeat(4097);
        assert!(input.validate().is_err());
        assert!(serde_json::from_value::<Record>(json!({"request_id":"q","call_id":"c","command":{},"questions":[{"id":"q","question":"Scope?","permission":"bypass"}]})).is_err());
    }
}
