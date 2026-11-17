use super::*;
use crate::messaging::coordinator_context_input::RecordInput;
use sha2::{Digest, Sha256};

fn input(s: &Store, id: &str, explicit: bool) -> RecordInput {
    let raw: String =
        s.db.lock()
            .query_row(
                "SELECT body FROM collaboration_messages WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
    let row: serde_json::Value = serde_json::from_str(&raw).unwrap();
    RecordInput {
        request_id: "input-request".into(),
        source_message_id: id.into(),
        expected_content_sha256: format!(
            "{:x}",
            Sha256::digest(row["content"].as_str().unwrap().as_bytes())
        ),
        explicitly_continue_stored: explicit,
    }
}
fn mark_gated(s: &Store, id: &str) {
    let db = s.db.lock();
    let raw: String = db
        .query_row(
            "SELECT body FROM collaboration_messages WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    let mut row: serde_json::Value = serde_json::from_str(&raw).unwrap();
    row["delivery_reason"] = serde_json::json!("isolated_context_required");
    db.execute(
        "UPDATE collaboration_messages SET body=?1 WHERE id=?2",
        rusqlite::params![row.to_string(), id],
    )
    .unwrap();
}

#[test]
fn historical_input_requires_exact_explicit_never_delivered_reference() {
    let (_root, s, register) = fixture("private", Kind::Dm);
    let context = s.register_coordinator_context(register.clone()).unwrap();
    assert!(s
        .record_context_input(&context.key, input(&s, &register.thread_id, false))
        .is_err());
    assert!(s
        .record_context_input(&context.key, input(&s, &register.thread_id, true))
        .is_err());
    mark_gated(&s, &register.thread_id);
    let request = input(&s, &register.thread_id, true);
    let receipt = s
        .record_context_input(&context.key, request.clone())
        .unwrap();
    assert_eq!(receipt["runtime_ready"], false);
    assert_eq!(receipt["execution_authorized"], false);
    assert_eq!(
        s.record_context_input(&context.key, request.clone())
            .unwrap(),
        receipt
    );
    let mut other = request.clone();
    other.request_id = "another-request".into();
    assert!(s.record_context_input(&context.key, other).is_err());
    let read = s.context_input(&context.key, &request.request_id).unwrap();
    assert_eq!(read["message"]["id"], register.thread_id);
    assert!(read["message"]["thread_context"].is_null());
    assert!(!receipt
        .to_string()
        .contains(read["message"]["content"].as_str().unwrap()));
    let db = s.db.lock();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM collaboration_coordinator_inputs",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM runtime_deliveries", [], |r| r
            .get::<_, u64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn new_input_after_cutoff_never_loads_private_root_or_other_threads() {
    let (_root, s, register) = fixture("private", Kind::Dm);
    let context = s.register_coordinator_context(register.clone()).unwrap();
    let fresh = s
        .send_collaboration_message(
            "private",
            Send {
                interactive_selection: None,
                request_id: "fresh".into(),
                expected_revision: 1,
                thread_id: Some(register.thread_id.clone()),
                content: "NEW_INPUT_CANARY".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    let request = input(&s, fresh["id"].as_str().unwrap(), false);
    s.record_context_input(&context.key, request.clone())
        .unwrap();
    let read = s.context_input(&context.key, &request.request_id).unwrap();
    assert_eq!(read["message"]["content"], "NEW_INPUT_CANARY");
    assert!(read["message"]["thread_context"].is_null());
    let other = s
        .send_collaboration_message(
            "private",
            Send {
                interactive_selection: None,
                request_id: "other".into(),
                expected_revision: 1,
                thread_id: None,
                content: "OTHER_THREAD_CANARY".into(),
                mentions: vec![],
            },
        )
        .unwrap();
    assert!(s
        .record_context_input(
            &context.key,
            input(&s, other["id"].as_str().unwrap(), false)
        )
        .is_err());
    assert!(!read.to_string().contains("OTHER_THREAD_CANARY"));
}

#[test]
fn delivery_evidence_content_change_and_revocation_fail_closed() {
    let (_root, s, register) = fixture("private", Kind::Dm);
    let context = s.register_coordinator_context(register.clone()).unwrap();
    mark_gated(&s, &register.thread_id);
    let request = input(&s, &register.thread_id, true);
    {
        let db = s.db.lock();
        db.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,'{}')",
            [format!(
                "coordinator-input:{}",
                serde_json::json!(register.thread_id)
            )],
        )
        .unwrap();
    }
    assert!(s
        .record_context_input(&context.key, request.clone())
        .unwrap_err()
        .to_string()
        .contains("prior or uncertain"));
    s.db.lock()
        .execute(
            "DELETE FROM workbench_documents WHERE key LIKE 'coordinator-input:%'",
            [],
        )
        .unwrap();
    s.record_context_input(&context.key, request.clone())
        .unwrap();
    {
        let db = s.db.lock();
        let raw: String = db
            .query_row(
                "SELECT body FROM collaboration_messages WHERE id=?1",
                [&register.thread_id],
                |r| r.get(0),
            )
            .unwrap();
        let mut row: serde_json::Value = serde_json::from_str(&raw).unwrap();
        row["content"] = serde_json::json!("Changed after reference");
        db.execute(
            "UPDATE collaboration_messages SET body=?1 WHERE id=?2",
            rusqlite::params![row.to_string(), register.thread_id],
        )
        .unwrap();
    }
    assert!(s
        .context_input(&context.key, &request.request_id)
        .unwrap_err()
        .to_string()
        .contains("content changed"));
    s.db.lock()
        .execute(
            "UPDATE collaboration_surfaces SET enabled=0 WHERE id='private'",
            [],
        )
        .unwrap();
    assert!(s.context_input(&context.key, &request.request_id).is_err());
}
