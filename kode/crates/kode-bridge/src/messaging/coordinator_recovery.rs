//! Read-only recovery prerequisites, shared with transactional control replacement.
use super::{
    builder_authority, coordinator_control, model::valid_id, operations::State, store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
pub(super) fn assess(db: &Connection, control: &Value) -> Result<Value> {
    let id = control["request"]["operation_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invalid Coordinator control"))?;
    let attempt = control["request"]["attempt"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("invalid Coordinator attempt"))?;
    let op = builder_authority::operation(db, id)?;
    let finalized:bool=db.query_row("SELECT COALESCE(json_extract(r.body,'$.finalized'),0) AND COALESCE(json_extract(r.body,'$.held'),1)=0 FROM operation_budget_bindings b JOIN budget_reservations r ON r.id=b.reservation_id WHERE b.operation_id=?1 AND b.attempt=?2",params![id,attempt],|r|r.get(0))?;
    let mut unresolved_tools = 0u64;
    let mut sequences = Vec::new();
    let mut q=db.prepare("SELECT seq FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='tool_evidence' AND json_extract(body,'$.evidence.attempt')=?2 AND json_extract(body,'$.evidence.status')='uncertain' ORDER BY seq")?;
    for sequence in q.query_map(params![id, attempt], |r| r.get::<_, u64>(0))? {
        let sequence = sequence?;
        if super::tool_resolution::read(db, id, sequence)?.is_none() {
            unresolved_tools += 1;
            if sequences.len() < 32 {
                sequences.push(sequence);
            }
        }
    }
    let unresolved_calls:u64=db.query_row("SELECT COUNT(*) FROM official_calls WHERE operation_id=?1 AND attempt=?2 AND (state!='finished' OR COALESCE(json_extract(body,'$.accounting_status'),'')!='estimated_pending_reconciliation')",params![id,attempt],|r|r.get(0))?;
    let stopped = matches!(op.state, State::Reported | State::Stopped);
    let mut blockers = Vec::new();
    if !stopped {
        blockers.push("execution_stop_unconfirmed");
    }
    if !finalized {
        blockers.push("budget_not_finalized");
    }
    if unresolved_calls > 0 {
        blockers.push("call_accounting_unresolved");
    }
    if unresolved_tools > 0 {
        blockers.push("tool_outcome_unresolved");
    }
    Ok(
        json!({"control_revision":control["revision"],"operation_id":id,"attempt":attempt,"epoch":control["request"]["epoch"],
        "operation_state":op.state,"stop_confirmed":stopped,"budget_finalized":finalized,"unresolved_calls":unresolved_calls,
        "unresolved_tools":unresolved_tools,"tool_evidence_sequences":sequences,"tool_evidence_truncated":unresolved_tools>32,
        "replacement_prerequisites_satisfied":blockers.is_empty(),"blockers":blockers,"resume_authorized":false}),
    )
}
impl Store {
    pub fn coordinator_recovery(&self, team: &str) -> Result<Value> {
        if !valid_id(team) {
            bail!("invalid Coordinator team")
        }
        let db = self.db.lock();
        let Some(control) = coordinator_control::current_in(&db, team)? else {
            return Ok(
                json!({"team_id":team,"home_hub":self.node_id,"control":null,"recovery":null,"resume_authorized":false}),
            );
        };
        let mut assessment = assess(&db, &control)?;
        let pending:u64=db.query_row("SELECT COUNT(*) FROM work_runs r WHERE r.team_id=?1 AND json_extract(r.body,'$.coordinator.operation_id')=?2 AND (r.state NOT IN ('completed','failed','cancelled') OR NOT EXISTS(SELECT 1 FROM workbench_documents d JOIN runtime_deliveries delivery ON delivery.message_id=json_extract(d.value,'$.receipt.message_id') AND delivery.phase=2 WHERE d.key='coordinator-update:'||json_array(r.id,r.revision)))",params![team,control["request"]["operation_id"].as_str()],|r|r.get(0))?;
        assessment["pending_work_count"] = json!(pending);
        Ok(
            json!({"team_id":team,"home_hub":self.node_id,"control":control,"recovery":assessment,"resume_authorized":false}),
        )
    }
}
