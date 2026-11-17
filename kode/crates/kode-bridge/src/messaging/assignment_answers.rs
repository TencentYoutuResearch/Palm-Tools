//! Answers preserve consumed human-message provenance and the frozen Worker authority.
use super::{
    assignment_clarification, assignment_resources, coordinator_input, coordinator_run, model::*,
    official_calls, operations::State, store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub request_id: String,
    pub question_request_id: String,
    pub source_message_id: String,
    pub conversation_id: String,
    pub operation_id: String,
    pub control_revision: u64,
    pub attempt: u64,
    pub epoch: u64,
}
fn key(id: &str, question: &str) -> String {
    format!("assignment-answer:{}", json!([id, question]))
}
/// Preserve confirmed human context independently of live delivery state and TTL.
/// Called inside Assignment preparation's transaction, before hashing its inputs.
pub(super) fn frozen_context(db: &rusqlite::Connection, assignment: &Value) -> Result<Vec<Value>> {
    let Some(answers) = assignment.get("clarification_answers") else {
        return Ok(Vec::new());
    };
    let answers = answers
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid Worker answer archive"))?;
    if answers.len() > 128 {
        bail!("Worker answer archive limit reached")
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut frozen = Vec::new();
    for receipt in answers {
        let question_id = receipt["question_request_id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| anyhow::anyhow!("invalid archived question identity"))?;
        if !seen.insert(question_id) {
            bail!("duplicate archived Worker answer")
        }
        let id = assignment["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Worker answer Assignment identity missing"))?;
        let saved: String = db.query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(id, question_id)],
            |r| r.get(0),
        )?;
        let saved: Value = serde_json::from_str(&saved)?;
        if &saved != receipt {
            bail!("Worker answer archive receipt mismatch")
        }
        let question: String = db.query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [format!(
                "assignment-clarification:{}",
                json!([id, question_id])
            )],
            |r| r.get(0),
        )?;
        let question: Value = serde_json::from_str(&question)?;
        let body: String = db.query_row(
            "SELECT body FROM messages WHERE id=?1",
            [receipt["message_id"].as_str()],
            |r| r.get(0),
        )?;
        let message: Message = serde_json::from_str(&body)?;
        let payload: Value = serde_json::from_str(&message.content)?;
        let human = match (
            receipt["provenance_version"].as_u64(),
            receipt["human_source"]["kind"].as_str(),
        ) {
            (Some(2), Some("collaboration_owner")) => {
                super::collaboration::clarification_answers::frozen_source(db, receipt)?
            }
            (Some(2), Some("coordinator_human")) | (None, None) => {
                let conversation = receipt["request"]["conversation_id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Worker answer conversation missing"))?;
                if receipt["provenance_version"] == 2
                    && receipt["human_source"]["conversation_id"] != conversation
                {
                    bail!("Worker answer source tag mismatch")
                }
                coordinator_input::read(
                    db,
                    conversation,
                    receipt["source_message_id"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Worker answer human source missing"))?,
                )?
                .ok_or_else(|| anyhow::anyhow!("Worker answer human provenance missing"))?
                    ["message"]
                    .clone()
            }
            _ => bail!("unsupported Worker answer provenance"),
        };
        if receipt["provenance_version"] == 2 {
            validate_target(
                &human,
                &json!({"run_id":assignment["run_id"],"assignment_id":assignment["id"],"question_request_id":question_id}),
            )?;
        }
        validate_frozen(assignment, receipt, &question, &message, &payload, &human)?;
        frozen.push(json!({"receipt":receipt,"question":question,"response":payload}));
    }
    Ok(frozen)
}

fn validate_frozen(
    assignment: &Value,
    receipt: &Value,
    question: &Value,
    message: &Message,
    payload: &Value,
    human: &Value,
) -> Result<()> {
    let operation = &assignment["dispatch"]["command"]["operation"];
    if receipt["snapshot"] != "assignment_answer_receipt.v1"
        || receipt["state"] != "queued"
        || receipt["completion_authorized"] != false
        || receipt["assignment_id"] != assignment["id"]
        || receipt["run_id"] != assignment["run_id"]
        || receipt["team_id"] != assignment["team_id"]
        || receipt["context_hash"] != assignment["context_hash"]
        || receipt["stage_attempt"] != assignment["stage_attempt"]
        || receipt["operation"] != *operation
        || receipt["worker"] != assignment["worker"]
        || receipt["source"] != serde_json::to_value(&message.source)?
        || receipt["worker"] != serde_json::to_value(&message.target)?
        || receipt["home_hub"] != message.source.node_id
        || receipt["message_id"] != message.id
        || receipt["content_hash"] != format!("{:x}", Sha256::digest(message.content.as_bytes()))
        || question["snapshot"] != "assignment_clarification_receipt.v1"
        || question["assignment_id"] != assignment["id"]
        || question["run_id"] != assignment["run_id"]
        || question["team_id"] != assignment["team_id"]
        || question["context_hash"] != assignment["context_hash"]
        || question["stage_attempt"] != assignment["stage_attempt"]
        || question["operation"] != *operation
        || question["worker"] != assignment["worker"]
        || question["home_hub"] != receipt["home_hub"]
        || question["request"]["request_id"] != receipt["question_request_id"]
        || payload["format"] != "kode.assignment.clarification-answer.v1"
        || payload["assignment_id"] != assignment["id"]
        || payload["run_id"] != assignment["run_id"]
        || payload["team_id"] != assignment["team_id"]
        || payload["context_hash"] != assignment["context_hash"]
        || payload["stage_attempt"] != assignment["stage_attempt"]
        || payload["worker"] != assignment["worker"]
        || payload["operation"] != *operation
        || payload["question_request_id"] != receipt["question_request_id"]
        || payload["questions"] != question["request"]["questions"]
        || payload["answer"]["source_message_id"] != receipt["source_message_id"]
        || human["id"] != receipt["source_message_id"]
        || human["team_id"] != assignment["team_id"]
        || human["actor"]["kind"] != "human"
        || human["content"].as_str().is_none()
        || payload["answer"]["content"] != human["content"]
    {
        bail!("frozen Worker clarification provenance mismatch")
    }
    Ok(())
}

pub(super) fn validate_target(human: &Value, expected: &Value) -> Result<()> {
    if human["actor"]["kind"] != "human"
        || human["actor"]["id"] != "local_owner"
        || human["clarification_target"] != *expected
    {
        bail!("Worker answer requires the owner's explicit exact question target")
    }
    Ok(())
}

/// All source adapters enter this transaction-bound gate. No authority is derived from answer text.
pub(super) fn queue_in(
    tx: &rusqlite::Transaction<'_>,
    home: &str,
    id: &str,
    question_id: &str,
    source_id: &str,
    request: Value,
    mut assignment: Value,
    mut run: Value,
    worker_op: super::operations::Operation,
    human: Value,
    human_source: Value,
) -> Result<Value> {
    let at = now();
    if assignment["state"] != "prepared"
        || assignment["creation"]["state"] != "created"
        || worker_op.state != State::Active
        || worker_op.lease_until.is_none_or(|t| t <= at)
        || !super::assignment_mandate::consumed(tx, &assignment, home)?
    {
        bail!("Worker answer requires its consumed active Assignment")
    }
    assignment_resources::assert_held(tx, &assignment)?;
    let used: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM workbench_documents WHERE key=?1)",
        [format!("assignment-answer-source:{}", json!(source_id))],
        |r| r.get(0),
    )?;
    if used {
        bail!("Worker answer source already used for a question")
    }
    let question = assignment_clarification::take_pending(&mut run, id, &question_id)?;
    if question["request"]["questions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|q| q["isSecret"] == true)
    {
        bail!("secret clarification requires an external configuration flow")
    }
    let body: String = tx.query_row(
        "SELECT body FROM official_calls WHERE id=?1",
        [question["request"]["call_id"].as_str()],
        |r| r.get(0),
    )?;
    let call: official_calls::Call = serde_json::from_str(&body)?;
    if call.state != "finished"
        || call.accounting_status != "estimated_pending_reconciliation"
        || call.request.operation_id != worker_op.id
        || call.request.attempt != worker_op.attempt
        || call.request.epoch != worker_op.epoch
    {
        bail!("Worker question model call requires finished reported usage")
    }
    validate_target(
        &human,
        &json!({"run_id":run["id"],"assignment_id":id,"question_request_id":question_id}),
    )?;
    if human["team_id"] != run["team_id"]
        || human["id"] != source_id
        || human["created_at"]
            .as_u64()
            .is_none_or(|t| t < question["recorded_at"].as_u64().unwrap())
    {
        bail!("Worker answer source scope or time mismatch")
    }
    let text = human["content"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Worker answer content missing"))?;
    if text.trim().is_empty() || text.len() > 16384 {
        bail!("Worker answer content exceeds bounds")
    }
    let payload = json!({"format":"kode.assignment.clarification-answer.v1","assignment_id":id,
            "question_request_id":question_id,"run_id":run["id"],"team_id":run["team_id"],
            "worker":worker_op.worker,"operation":assignment["dispatch"]["command"]["operation"],
            "context_hash":assignment["context_hash"],"stage_attempt":assignment["stage_attempt"],
            "questions":question["request"]["questions"],"answer":{"source_message_id":source_id,"content":text}});
    let content = serde_json::to_string(&payload)?;
    if content.len() > 65536 {
        bail!("Worker answer envelope exceeds bounds")
    }
    let message = Store::insert_in(
        &tx,
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            source: Address {
                node_id: home.to_string(),
                session_id: run["context"]["team"]["superagent_id"]
                    .as_str()
                    .unwrap()
                    .into(),
            },
            target: worker_op.worker.clone(),
            content: content.clone(),
            idempotency_key: format!("answer-{}", uuid::Uuid::new_v4()),
            direct_insert: false,
            in_reply_to: assignment["mandate"]["receipt"]["message_id"]
                .as_str()
                .map(str::to_owned),
            hop_count: 0,
            created_at: at,
            expires_at: at + 86400000,
            status: if worker_op.worker.node_id == home {
                Status::Received
            } else {
                Status::Queued
            },
            detail: None,
        },
    )?;
    let receipt = json!({"snapshot":"assignment_answer_receipt.v1","provenance_version":2,"human_source":human_source,"request":request,"assignment_id":id,
            "question_request_id":question_id,"source_message_id":source_id,
            "run_id":run["id"],"team_id":run["team_id"],"home_hub":home,"worker":worker_op.worker,
            "operation":payload["operation"],"context_hash":assignment["context_hash"],"stage_attempt":assignment["stage_attempt"],
            "message_id":message.id,"source":message.source,"content_hash":format!("{:x}",Sha256::digest(content.as_bytes())),
            "state":"queued","completion_authorized":false,"created_at":at});
    if assignment["clarification_answers"].is_null() {
        assignment["clarification_answers"] = json!([])
    }
    let answers = assignment["clarification_answers"].as_array_mut().unwrap();
    if answers.len() >= 128 {
        bail!("Worker answer archive limit reached")
    }
    answers.push(receipt.clone());
    assignment["revision"] = json!(assignment["revision"].as_u64().unwrap() + 1);
    run["revision"] = json!(run["revision"].as_u64().unwrap() + 1);
    run["updated_at"] = json!(at);
    run["waiting_reason"] = json!(if run["pending_clarification"].is_object() {
        "worker_clarification_required"
    } else {
        "worker_clarification_answer_queued"
    });
    tx.execute(
        "UPDATE work_assignments SET body=?2 WHERE id=?1",
        params![id, assignment.to_string()],
    )?;
    tx.execute(
        "UPDATE work_runs SET revision=?2,body=?3 WHERE id=?1",
        params![
            run["id"].as_str(),
            run["revision"].as_u64(),
            run.to_string()
        ],
    )?;
    tx.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![key(id, &question_id), receipt.to_string()],
    )?;
    tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![run["id"].as_str(),json!({"kind":"assignment_clarification_answer_queued","at":at,"actor":{"kind":"superagent","id":run["context"]["team"]["superagent_id"]},"receipt":receipt}).to_string()])?;
    tx.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![
            format!("assignment-answer-source:{}", json!(source_id)),
            receipt.to_string()
        ],
    )?;
    Ok(receipt)
}

impl Store {
    pub fn assignment_answer(&self, id: &str, question: &str) -> Result<Option<Value>> {
        if !valid_id(id) || !valid_id(question) {
            bail!("invalid Worker answer identity")
        }
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [key(id, question)],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub fn answer_assignment_clarification(&self, id: &str, input: Answer) -> Result<Value> {
        if ![
            id,
            &input.request_id,
            &input.question_request_id,
            &input.source_message_id,
            &input.conversation_id,
            &input.operation_id,
        ]
        .iter()
        .all(|s| valid_id(s))
            || input.control_revision == 0
            || input.attempt == 0
            || input.epoch == 0
        {
            bail!("invalid Worker answer scope")
        }
        let request = serde_json::to_value(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let prior: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [key(id, &input.question_request_id)],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(body) = prior {
            let prior: Value = serde_json::from_str(&body)?;
            if prior["request"] != request {
                bail!("Worker answer identity conflict")
            }
            return Ok(prior);
        }
        let body: String =
            tx.query_row("SELECT body FROM work_assignments WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
        let assignment: Value = serde_json::from_str(&body)?;
        let at = now();
        let (run, worker_op) = assignment_resources::authorized_context(&tx, id, &assignment, at)?;
        assignment_resources::assert_held(&tx, &assignment)?;
        if assignment["state"] != "prepared"
            || assignment["creation"]["state"] != "created"
            || worker_op.state != State::Active
            || worker_op.lease_until.is_none_or(|t| t <= at)
            || !super::assignment_mandate::consumed(&tx, &assignment, &self.node_id)?
        {
            bail!("Worker answer requires its consumed active Assignment")
        }
        coordinator_run::authorize(
            &tx,
            &self.node_id,
            &input.conversation_id,
            &coordinator_run::Start {
                request_id: input.request_id.clone(),
                source_message_id: input.source_message_id.clone(),
                operation_id: input.operation_id.clone(),
                control_revision: input.control_revision,
                attempt: input.attempt,
                epoch: input.epoch,
                binding_id: run["context"]["binding"]["id"].as_str().unwrap().into(),
                inputs: Default::default(),
                prior_run_id: None,
            },
        )?;
        if run["coordinator"]["conversation_id"] != input.conversation_id
            || run["coordinator"]["operation_id"] != input.operation_id
            || run["coordinator"]["control_revision"] != input.control_revision
            || run["coordinator"]["attempt"] != input.attempt
            || run["coordinator"]["epoch"] != input.epoch
        {
            bail!("Worker answer Coordinator scope changed")
        }
        let grant = super::operation_grant::read(&tx, &input.operation_id)?.unwrap();
        if !grant
            .scope
            .tools
            .iter()
            .any(|name| name == "kode_coordinator_answer_clarification")
        {
            bail!("Worker clarification answer tool not granted")
        }
        let human = coordinator_input::read(&tx, &input.conversation_id, &input.source_message_id)?
            .unwrap()["message"]
            .clone();
        if human["team_id"] != run["team_id"]
            || human["actor"]["kind"] != "human"
            || human["id"] == run["coordinator"]["source_message_id"]
            || human["created_at"].as_u64().is_none_or(|t| t < 1)
        {
            bail!("Worker answer requires a new human response to this question")
        }
        let expected = json!({"run_id":run["id"],"assignment_id":id,"question_request_id":input.question_request_id});
        validate_target(&human, &expected)?;
        let result = queue_in(
            &tx,
            &self.node_id,
            id,
            &input.question_request_id,
            &input.source_message_id,
            request,
            assignment,
            run,
            worker_op,
            human,
            json!({"kind":"coordinator_human","conversation_id":input.conversation_id}),
        )?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Value, Value, Value, Message, Value, Value) {
        let operation = json!({"id":"op","attempt":1,"epoch":1});
        let worker = json!({"node_id":"remote","session_id":"worker"});
        let assignment = json!({"id":"assignment","run_id":"run","team_id":"team",
            "context_hash":"context","stage_attempt":1,"worker":worker,
            "dispatch":{"command":{"operation":operation}}});
        let question = json!({"snapshot":"assignment_clarification_receipt.v1",
            "assignment_id":"assignment","run_id":"run","team_id":"team",
            "context_hash":"context","stage_attempt":1,"worker":worker,"operation":operation,
            "home_hub":"home","request":{"request_id":"question","questions":[{"id":"wording","question":"Which wording?"}]}});
        let human = json!({"id":"human","team_id":"team","actor":{"kind":"human"},"content":"Use implemented."});
        let payload = json!({"format":"kode.assignment.clarification-answer.v1",
            "assignment_id":"assignment","run_id":"run","team_id":"team",
            "context_hash":"context","stage_attempt":1,"worker":worker,"operation":operation,
            "question_request_id":"question","questions":question["request"]["questions"],
            "answer":{"source_message_id":"human","content":human["content"]}});
        let message = Message {
            id: "message".into(),
            source: Address {
                node_id: "home".into(),
                session_id: "superagent".into(),
            },
            target: serde_json::from_value(worker.clone()).unwrap(),
            content: payload.to_string(),
            idempotency_key: "answer".into(),
            direct_insert: false,
            in_reply_to: Some("mandate".into()),
            hop_count: 0,
            created_at: 1,
            expires_at: 2,
            status: Status::Expired,
            detail: None,
        };
        let receipt = json!({"snapshot":"assignment_answer_receipt.v1","state":"queued","completion_authorized":false,
            "assignment_id":"assignment","run_id":"run","team_id":"team","context_hash":"context",
            "stage_attempt":1,"operation":operation,"worker":worker,"source":message.source,
            "home_hub":"home","message_id":"message","question_request_id":"question",
            "source_message_id":"human","request":{"conversation_id":"conversation"},
            "content_hash":format!("{:x}",Sha256::digest(message.content.as_bytes()))});
        (assignment, receipt, question, message, payload, human)
    }

    #[test]
    fn explicit_owner_target_rejects_cross_run_cross_question_and_forged_actor() {
        let target = json!({"run_id":"run-a","assignment_id":"assignment-a","question_request_id":"question-a"});
        let human =
            json!({"actor":{"kind":"human","id":"local_owner"},"clarification_target":target});
        validate_target(&human, &target).unwrap();
        for field in ["run_id", "assignment_id", "question_request_id"] {
            let mut other = target.clone();
            other[field] = json!("other");
            assert!(validate_target(&human, &other).is_err());
        }
        let mut plain = human.clone();
        plain
            .as_object_mut()
            .unwrap()
            .remove("clarification_target");
        assert!(validate_target(&plain, &target).is_err());
        for actor in [
            json!({"kind":"human","id":"third_party"}),
            json!({"kind":"worker","id":"local_owner"}),
        ] {
            let mut forged = human.clone();
            forged["actor"] = actor;
            assert!(validate_target(&forged, &target).is_err());
        }
    }

    #[test]
    fn tagged_archive_answer_survives_restart_without_private_conversation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("answers.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE workbench_documents(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE collaboration_messages(id TEXT PRIMARY KEY,surface_id TEXT,thread_id TEXT,kind TEXT,body TEXT);").unwrap();
        let (mut assignment, mut receipt, question, message, _, mut human) = fixture();
        receipt["provenance_version"] = json!(2);
        receipt["human_source"] = json!({"kind":"collaboration_owner","task_id":"task","surface_id":"channel","thread_id":"thread","scope":{"workspace_id":"workspace"}});
        human["actor"]["id"] = json!("local_owner");
        human["task_id"] = json!("task");
        human["scope"] = receipt["human_source"]["scope"].clone();
        human["clarification_target"] =
            json!({"run_id":"run","assignment_id":"assignment","question_request_id":"question"});
        assignment["clarification_answers"] = json!([receipt]);
        db.execute(
            "INSERT INTO messages VALUES (?1,?2)",
            params![message.id, serde_json::to_string(&message).unwrap()],
        )
        .unwrap();
        db.execute("INSERT INTO collaboration_messages VALUES ('human','channel','thread','clarification_answer',?1)",[human.to_string()]).unwrap();
        for (k, v) in [
            (key("assignment", "question"), receipt.clone()),
            (
                format!(
                    "assignment-clarification:{}",
                    json!(["assignment", "question"])
                ),
                question,
            ),
        ] {
            db.execute(
                "INSERT INTO workbench_documents VALUES (?1,?2)",
                params![k, v.to_string()],
            )
            .unwrap();
        }
        let expected = frozen_context(&db, &assignment).unwrap();
        drop(db);
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(frozen_context(&db, &assignment).unwrap(), expected);
        // New receipts may never fall back to an untagged/private source.
        for changed in [
            Value::Null,
            json!({"kind":"coordinator_human","conversation_id":"conversation"}),
            json!({"kind":"collaboration_owner","task_id":"other","surface_id":"channel","thread_id":"thread","scope":{"workspace_id":"workspace"}}),
        ] {
            let mut broken = receipt.clone();
            broken["human_source"] = changed;
            assignment["clarification_answers"] = json!([broken]);
            db.execute(
                "UPDATE workbench_documents SET value=?2 WHERE key=?1",
                params![key("assignment", "question"), broken.to_string()],
            )
            .unwrap();
            assert!(frozen_context(&db, &assignment).is_err());
        }
    }

    #[test]
    fn frozen_answers_bind_scope_questions_and_original_human_text() {
        let (assignment, receipt, question, message, payload, human) = fixture();
        // Delivery expiry does not erase the confirmed requirement's historical context.
        validate_frozen(&assignment, &receipt, &question, &message, &payload, &human).unwrap();
        for field in [
            "assignment_id",
            "run_id",
            "team_id",
            "context_hash",
            "stage_attempt",
            "worker",
            "operation",
        ] {
            for target in 0..3 {
                let (mut changed_receipt, mut changed_question, mut changed_payload) =
                    (receipt.clone(), question.clone(), payload.clone());
                match target {
                    0 => changed_receipt[field] = json!("foreign"),
                    1 => changed_question[field] = json!("foreign"),
                    _ => changed_payload[field] = json!("foreign"),
                }
                assert!(
                    validate_frozen(
                        &assignment,
                        &changed_receipt,
                        &changed_question,
                        &message,
                        &changed_payload,
                        &human
                    )
                    .is_err(),
                    "{field} in source {target}"
                );
            }
        }
        let mut changed = human.clone();
        changed["content"] = json!("Changed requirement");
        assert!(validate_frozen(
            &assignment,
            &receipt,
            &question,
            &message,
            &payload,
            &changed
        )
        .is_err());
        changed = payload.clone();
        changed["questions"] = json!([]);
        assert!(
            validate_frozen(&assignment, &receipt, &question, &message, &changed, &human).is_err()
        );
        let mut changed_message = message.clone();
        changed_message.content.push(' ');
        assert!(validate_frozen(
            &assignment,
            &receipt,
            &question,
            &changed_message,
            &payload,
            &human
        )
        .is_err());
    }

    #[test]
    fn freeze_reads_immutable_receipts_and_preserves_legacy_assignments() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE workbench_documents(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE conversation_messages(conversation_id TEXT,id TEXT,actor TEXT,body TEXT);").unwrap();
        db.execute_batch(super::super::collaboration::discussion_dispatch::SCHEMA)
            .unwrap();
        let (mut assignment, receipt, question, message, _, human) = fixture();
        assert!(frozen_context(&db, &assignment).unwrap().is_empty());
        assignment["clarification_answers"] = json!([receipt]);
        db.execute(
            "INSERT INTO messages VALUES (?1,?2)",
            params![message.id, serde_json::to_string(&message).unwrap()],
        )
        .unwrap();
        db.execute("INSERT INTO conversation_messages VALUES ('conversation','human','human:local_owner',?1)",[human.to_string()]).unwrap();
        for (key, value) in [
            (key("assignment", "question"), receipt.clone()),
            (
                format!(
                    "assignment-clarification:{}",
                    json!(["assignment", "question"])
                ),
                question.clone(),
            ),
            (format!("coordinator-input:{}", json!("human")), json!({})),
        ] {
            db.execute(
                "INSERT INTO workbench_documents VALUES (?1,?2)",
                params![key, value.to_string()],
            )
            .unwrap();
        }
        let frozen = frozen_context(&db, &assignment).unwrap();
        assert_eq!(frozen[0]["receipt"], receipt);
        assert_eq!(frozen[0]["question"], question);
        assert_eq!(frozen[0]["response"]["answer"]["content"], human["content"]);
        assert_eq!(frozen_context(&db, &assignment).unwrap(), frozen);
        assignment["clarification_answers"][0]["source_message_id"] = json!("other");
        assert!(frozen_context(&db, &assignment).is_err());
        assignment["clarification_answers"] = json!([receipt.clone(), receipt]);
        assert!(frozen_context(&db, &assignment).is_err());
        assignment["clarification_answers"] = Value::Null;
        assert!(frozen_context(&db, &assignment).is_err());
    }
}
