//! Fixed, Home-scoped trace sources. Every stream has a monotonic SQLite cursor.
use anyhow::{bail, Result};
pub(super) const VIEWS: &[&str] = &[
    "work_events",
    "assignments",
    "operations",
    "operation_events",
    "model_calls",
    "model_events",
    "messages",
    "communication_events",
    "conversation",
    "archives",
    "verification_archives",
    "team_history",
];
fn operations() -> &'static str {
    "SELECT operation_id FROM work_assignments WHERE run_id=?1
     UNION SELECT json_extract(body,'$.coordinator.operation_id') FROM work_runs WHERE id=?1
     UNION SELECT json_extract(body,'$.transfer.previous.operation_id') FROM work_run_events WHERE run_id=?1 AND json_extract(body,'$.kind')='coordinator_run_transferred'
     UNION SELECT json_extract(body,'$.transfer.coordinator.operation_id') FROM work_run_events WHERE run_id=?1 AND json_extract(body,'$.kind')='coordinator_run_transferred'"
}
fn operation_links(column: &str) -> String {
    format!("json_object('operation_id',{column},'scope',CASE WHEN EXISTS(SELECT 1 FROM work_assignments a WHERE a.run_id=?1 AND a.operation_id={column}) THEN 'worker_assignment' ELSE 'shared_coordinator_operation' END)")
}
pub(super) fn select(view: &str) -> Result<String> {
    let ops = operations();
    Ok(match view {
        "work_events" => "SELECT seq AS cursor,body,'{\"scope\":\"work_run\"}' AS links FROM work_run_events WHERE run_id=?1".into(),
        "assignments" => "SELECT rowid AS cursor,body,'{\"scope\":\"worker_assignment\"}' AS links FROM work_assignments WHERE run_id=?1".into(),
        "operations" => format!("SELECT o.rowid AS cursor,o.body,{} AS links FROM operations o WHERE o.id IN ({ops})",operation_links("o.id")),
        "operation_events" => format!("SELECT e.seq AS cursor,e.body,{} AS links FROM operation_events e WHERE e.operation_id IN ({ops})",operation_links("e.operation_id")),
        "model_calls" => format!("SELECT c.rowid AS cursor,c.body,{} AS links FROM official_calls c WHERE c.operation_id IN ({ops})",operation_links("c.operation_id")),
        "model_events" => format!("SELECT e.rowid AS cursor,e.body,json_set({},'$.call_id',e.call_id) AS links FROM official_call_events e JOIN official_calls c ON c.id=e.call_id WHERE c.operation_id IN ({ops})",operation_links("c.operation_id")),
        "messages" => format!("SELECT m.rowid AS cursor,m.id AS message_id,m.body,json_object('scope',CASE WHEN EXISTS(SELECT 1 FROM work_assignments a WHERE a.run_id=?1 AND ((m.source_node=json_extract(a.body,'$.worker.node_id') AND m.source_session=json_extract(a.body,'$.worker.session_id')) OR (m.target_node=json_extract(a.body,'$.worker.node_id') AND m.target_session=json_extract(a.body,'$.worker.session_id')))) THEN 'worker_assignment' ELSE 'shared_coordinator_operation' END) AS links FROM messages m WHERE m.rowid IN (SELECT sent.rowid FROM operations o JOIN messages sent ON sent.source_node=json_extract(o.body,'$.worker.node_id') AND sent.source_session=json_extract(o.body,'$.worker.session_id') WHERE o.id IN ({ops}) UNION SELECT received.rowid FROM operations o JOIN messages received INDEXED BY message_target ON received.target_node=json_extract(o.body,'$.worker.node_id') AND received.target_session=json_extract(o.body,'$.worker.session_id') WHERE o.id IN ({ops}))"),
        "communication_events" => format!("SELECT e.seq AS cursor,json_object('kind',e.kind,'historical',e.historical,'event',json(e.body)) AS body,json_set(m.links,'$.message_id',m.message_id) AS links FROM ({}) m CROSS JOIN lifecycle_events e INDEXED BY lifecycle_message ON e.message_id=m.message_id",select("messages")?),
        "conversation" => "SELECT c.sequence AS cursor,c.body,'{\"scope\":\"shared_human_request\"}' AS links FROM conversation_messages c WHERE c.sequence IN (SELECT sequence FROM conversation_messages WHERE id=(SELECT json_extract(body,'$.coordinator.source_message_id') FROM work_runs WHERE id=?1) AND conversation_id=(SELECT json_extract(body,'$.coordinator.conversation_id') FROM work_runs WHERE id=?1) UNION SELECT sequence FROM conversation_messages INDEXED BY conversation_reply_trace WHERE conversation_id=(SELECT json_extract(body,'$.coordinator.conversation_id') FROM work_runs WHERE id=?1) AND json_extract(body,'$.in_reply_to')=(SELECT json_extract(body,'$.coordinator.source_message_id') FROM work_runs WHERE id=?1))".into(),
        "archives" => format!("SELECT e.seq AS cursor,json_object('sequence',e.seq,'hash',a.hash,'bytes',a.bytes,'complete',COALESCE(a.complete,0),'availability',CASE WHEN a.complete=1 THEN 'home_archived' ELSE 'missing_or_pending' END,'payload_included',json('false')) AS body,'{{\"scope\":\"home_archive_reference\"}}' AS links FROM operation_events e LEFT JOIN artifact_archives a ON a.sequence=e.seq WHERE e.operation_id IN ({ops}) AND json_extract(e.body,'$.kind')='artifact_evidence' AND json_extract(e.body,'$.evidence.payload.kind')='artifact'"),
        "verification_archives" => format!("SELECT e.seq AS cursor,json_object('sequence',e.seq,'record_hash',json_extract(d.value,'$.record_hash'),'record_bytes',length(CAST(json_extract(d.value,'$.result_json') AS BLOB)),'availability',CASE WHEN d.key IS NULL THEN 'missing_or_pending' ELSE 'home_archived' END,'payload_included',json('false')) AS body,'{{\"scope\":\"home_archive_reference\"}}' AS links FROM operation_events e LEFT JOIN workbench_documents d ON d.key='verification-record:'||e.seq WHERE e.operation_id IN ({ops}) AND json_extract(e.body,'$.kind')='artifact_evidence' AND json_extract(e.body,'$.evidence.payload.kind')='verification'"),
        "team_history" => "SELECT seq AS cursor,body,'{\"scope\":\"shared_team_history\"}' AS links FROM team_events WHERE team_id=(SELECT team_id FROM work_runs WHERE id=?1)".into(),
        _ => bail!("unknown work run trace view"),
    })
}
