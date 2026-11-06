//! Home gates normal reporting on consumed answers and finished calls with exact input provenance.
use super::{assignment_clarification, model::valid_id, prompt_provenance::Provenance};
use anyhow::{bail, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnswerProof {
    pub question_request_id: String,
    pub message_id: String,
    pub content_hash: String,
}
pub(super) fn expected(assignment: &Value) -> Result<Vec<AnswerProof>> {
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
    let mut proofs = Vec::new();
    for receipt in answers {
        let proof: AnswerProof = serde_json::from_value(serde_json::json!({
            "question_request_id":receipt["question_request_id"],
            "message_id":receipt["message_id"],"content_hash":receipt["content_hash"]}))?;
        if !valid_id(&proof.question_request_id)
            || !valid_id(&proof.message_id)
            || proof.content_hash.len() != 64
            || !proof
                .content_hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !seen.insert(proof.question_request_id.clone())
        {
            bail!("invalid Worker answer provenance identity")
        }
        proofs.push(proof);
    }
    Ok(proofs)
}
pub(super) fn validate_call(
    db: &Connection,
    operation: &str,
    proof: Option<&Provenance>,
) -> Result<()> {
    let body: Option<String> = db
        .query_row(
            "SELECT body FROM work_assignments WHERE operation_id=?1",
            [operation],
            |r| r.get(0),
        )
        .optional()?;
    let Some(body) = body else { return Ok(()) };
    let assignment: Value = serde_json::from_str(&body)?;
    let answers = expected(&assignment)?;
    if !answers.is_empty()
        && proof
            .and_then(|p| p.instruction.as_ref())
            .is_none_or(|input| {
                input.role != "worker"
                    || input.assignment_id.as_deref() != assignment["id"].as_str()
                    || input.answers != answers
            })
    {
        bail!("Worker answer prompt provenance required")
    }
    Ok(())
}
/// None keeps pre-clarification Assignment reads byte-compatible.
pub(super) fn progress(db: &Connection, assignment: &Value, home: &str) -> Result<Option<bool>> {
    let answers = expected(assignment)?;
    let body: String = db.query_row(
        "SELECT body FROM work_runs WHERE id=?1",
        [assignment["run_id"].as_str()],
        |r| r.get(0),
    )?;
    let run: Value = serde_json::from_str(&body)?;
    if assignment_clarification::pending(&run)
        .iter()
        .any(|row| row["assignment_id"] == assignment["id"])
    {
        return Ok(Some(false));
    }
    if answers.is_empty() {
        return Ok(None);
    }
    for answer in &answers {
        if !super::assignment_mandate::consumed_delivery(db, assignment, home, &answer.message_id)?
        {
            return Ok(Some(false));
        }
    }
    let operation = &assignment["dispatch"]["command"]["operation"];
    let mut query = db.prepare(
        "SELECT body FROM official_calls WHERE operation_id=?1 AND attempt=?2 AND state='finished'",
    )?;
    let rows = query.query_map(
        rusqlite::params![operation["id"].as_str(), operation["attempt"].as_u64()],
        |r| r.get::<_, String>(0),
    )?;
    for row in rows {
        let call: super::official_calls::Call = serde_json::from_str(&row?)?;
        if call.request.epoch != operation["epoch"].as_u64().unwrap_or(0)
            || call.request.worker_session
                != assignment["worker"]["session_id"].as_str().unwrap_or("")
            || call.state != "finished"
            || call.accounting_status != "estimated_pending_reconciliation"
        {
            continue;
        }
        if call
            .request
            .prompt_provenance
            .as_ref()
            .and_then(|p| p.instruction.as_ref())
            .is_some_and(|input| {
                input.role == "worker"
                    && input.assignment_id.as_deref() == assignment["id"].as_str()
                    && input.answers == answers
            })
        {
            return Ok(Some(true));
        }
    }
    Ok(Some(false))
}
pub(super) fn require_resolved(db: &Connection, assignment: &Value, home: &str) -> Result<()> {
    if progress(db, assignment, home)? == Some(false) {
        bail!("Worker clarification requires consumed answer and finished model input provenance")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;

    #[test]
    fn answer_readiness_requires_consumption_exact_finished_call_and_current_epoch() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE work_runs(id TEXT,body TEXT); CREATE TABLE work_assignments(operation_id TEXT,body TEXT); CREATE TABLE official_calls(operation_id TEXT,attempt INTEGER,state TEXT,body TEXT); CREATE TABLE runtime_deliveries(message_id TEXT,body TEXT); CREATE TABLE delivery_mirrors(message_id TEXT,body TEXT); CREATE TABLE messages(id TEXT,body TEXT);").unwrap();
        let mut run = json!({"id":"run"});
        db.execute("INSERT INTO work_runs VALUES ('run',?1)", [run.to_string()])
            .unwrap();
        let mut assignment = json!({"id":"assignment","run_id":"run","worker":{"node_id":"home","session_id":"worker"},"dispatch":{"command":{"operation":{"id":"op","attempt":1,"epoch":2}}}});
        assert_eq!(progress(&db, &assignment, "home").unwrap(), None);
        let answers = json!([{"question_request_id":"question","message_id":"message","content_hash":"a".repeat(64)}]);
        assignment["clarification_answers"] = answers.clone();
        db.execute(
            "INSERT INTO work_assignments VALUES ('op',?1)",
            [assignment.to_string()],
        )
        .unwrap();
        assert_eq!(progress(&db, &assignment, "home").unwrap(), Some(false));
        assert!(validate_call(&db, "op", None).is_err());
        let mut provenance: Provenance = serde_json::from_value(json!({"schema_version":1,"source":"official_prepared_input","system_sha256":"b".repeat(64),"system_messages":0,"instruction":{"role":"worker","version":"kode.assignment.mandate.v1","sha256":"c".repeat(64),"assignment_id":"assignment","answers":answers}})).unwrap();
        validate_call(&db, "op", Some(&provenance)).unwrap();
        provenance.instruction.as_mut().unwrap().answers.clear();
        assert!(validate_call(&db, "op", Some(&provenance)).is_err());
        provenance.instruction.as_mut().unwrap().answers = expected(&assignment).unwrap();
        let mut call = json!({"request":{"call_id":"call","operation_id":"op","attempt":1,"epoch":2,"worker_session":"worker","provider":"fixture","model":"fixture","prompt_provenance":provenance},"sequence":2,"state":"finished","started_at":1,"last":null,"accounting_status":"estimated_pending_reconciliation"});
        db.execute(
            "INSERT INTO official_calls VALUES ('op',1,'finished',?1)",
            [call.to_string()],
        )
        .unwrap();
        assert_eq!(progress(&db, &assignment, "home").unwrap(), Some(false));
        let message = json!({"id":"message","source":{"node_id":"home","session_id":"superagent"},"target":assignment["worker"],"content":"answer","idempotency_key":"answer","in_reply_to":null,"created_at":1,"expires_at":2,"status":"accepted","detail":null});
        db.execute(
            "INSERT INTO messages VALUES ('message',?1)",
            [message.to_string()],
        )
        .unwrap();
        let mut delivery = json!({"message_id":"message","session_id":"worker","input_id":"input","phase":"queued","event_seq":null,"observed_at":1});
        db.execute(
            "INSERT INTO runtime_deliveries VALUES ('message',?1)",
            [delivery.to_string()],
        )
        .unwrap();
        assert_eq!(progress(&db, &assignment, "home").unwrap(), Some(false));
        delivery["phase"] = json!("consumed");
        delivery["event_seq"] = json!(1);
        db.execute(
            "UPDATE runtime_deliveries SET body=?1",
            [delivery.to_string()],
        )
        .unwrap();
        assert_eq!(progress(&db, &assignment, "home").unwrap(), Some(true));
        for (pointer, value) in [
            ("/request/epoch", json!(1)),
            ("/request/prompt_provenance/instruction/answers", json!([])),
            ("/state", json!("started")),
            ("/accounting_status", json!("usage_unresolved")),
        ] {
            let mut changed = call.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            db.execute("UPDATE official_calls SET body=?1", [changed.to_string()])
                .unwrap();
            assert_eq!(
                progress(&db, &assignment, "home").unwrap(),
                Some(false),
                "{pointer}"
            );
        }
        db.execute("UPDATE official_calls SET body=?1", [call.to_string()])
            .unwrap();
        run["pending_clarification"] = json!({"assignment_id":"assignment"});
        db.execute("UPDATE work_runs SET body=?1", [run.to_string()])
            .unwrap();
        assert!(require_resolved(&db, &assignment, "home").is_err());
        run.as_object_mut().unwrap().remove("pending_clarification");
        db.execute("UPDATE work_runs SET body=?1", [run.to_string()])
            .unwrap();
        // A remote Worker must use authenticated Home mirrors, never the local delivery table.
        assignment["worker"]["node_id"] = json!("remote");
        assert_eq!(progress(&db, &assignment, "home").unwrap(), Some(false));
        let mut remote_message = message.clone();
        remote_message["target"] = assignment["worker"].clone();
        db.execute("UPDATE messages SET body=?1", [remote_message.to_string()])
            .unwrap();
        db.execute(
            "INSERT INTO delivery_mirrors VALUES (?1,?2)",
            params!["message", delivery.to_string()],
        )
        .unwrap();
        assert_eq!(progress(&db, &assignment, "home").unwrap(), Some(true));
        call["request"]["prompt_provenance"]["instruction"]["answers"][0]["message_id"] =
            json!("other");
        db.execute("UPDATE official_calls SET body=?1", [call.to_string()])
            .unwrap();
        assert!(require_resolved(&db, &assignment, "home").is_err());
    }
}
