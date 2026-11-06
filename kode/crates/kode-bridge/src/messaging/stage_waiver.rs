//! Frozen permission and exact evidence scope for owner waivers. No passed verdict is synthesized.
use super::workflows::{EvidenceRule, Pack, Stage};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    /// Permission to deliver with an explicit waiver, not permission for an Agent to waive.
    pub allow_delivery: bool,
}

pub(super) fn validate(pack: &Pack, stage: &Stage) -> Result<()> {
    if stage.waiver.is_none() { return Ok(()); }
    // A waiver can omit a judgment about an existing artifact, never manufacture an artifact
    // or a generic report that another stage consumes as factual input.
    if stage.produces.iter().any(|output| !matches!(pack.evidence_rules.get(output),
        Some(EvidenceRule::Review { .. } | EvidenceRule::Verification { .. }))) {
        bail!("waiver policy requires review or verification evidence outputs");
    }
    Ok(())
}

/// Bind a decision to exact selected evidence and identities. The caller must independently
/// verify stored evidence, activation, drainage and authority in the same transaction.
/// Run revision is checked by the command, not included here: unrelated branch progress
/// must not invalidate a decision whose artifact, context and attempt remain unchanged.
pub(super) fn scope(run: &Value, pack: &Pack, stage_id: &str) -> Result<Value> {
    let stage = pack.stages.iter().find(|s| s.id == stage_id)
        .ok_or_else(|| anyhow::anyhow!("unknown waiver stage"))?;
    let policy = stage.waiver.as_ref().ok_or_else(|| anyhow::anyhow!("stage waiver not permitted"))?;
    validate(pack, stage)?;
    let states = run["stages"].as_array().ok_or_else(|| anyhow::anyhow!("missing stage states"))?;
    let state = states.iter().find(|s| s["stage_id"] == stage_id)
        .ok_or_else(|| anyhow::anyhow!("missing waiver stage state"))?;
    let mut artifacts = BTreeMap::new();
    for output in &stage.produces {
        let artifact = match &pack.evidence_rules[output] {
            EvidenceRule::Review { artifact_output } | EvidenceRule::Verification { artifact_output, .. } => artifact_output,
            _ => bail!("unsupported waiver evidence"),
        };
        let producer = pack.stages.iter().find(|s| s.produces.contains(artifact))
            .ok_or_else(|| anyhow::anyhow!("waiver artifact producer unavailable"))?;
        let source = states.iter().find(|s| s["stage_id"] == producer.id)
            .ok_or_else(|| anyhow::anyhow!("waiver artifact state unavailable"))?;
        let evidence = &source["evidence"];
        let sequence = evidence["outputs"][artifact].as_u64()
            .filter(|s| *s > 0 && *s <= i64::MAX as u64)
            .ok_or_else(|| anyhow::anyhow!("waiver requires exact artifact evidence"))?;
        if source["state"] != "passed" || source["assignment_id"].as_str().is_none()
            || evidence["assignment_id"] != source["assignment_id"]
            || evidence["stage_attempt"] != source["attempt"]
            || evidence["context_hash"] != run["context_hash"]
            || evidence["authorization_hash"] != run["authorization"]["snapshot_hash"] {
            bail!("waiver artifact evidence is stale or incomplete");
        }
        artifacts.insert(artifact.clone(), json!({"sequence":sequence,"stage_id":producer.id,
            "stage_attempt":source["attempt"],"assignment_id":source["assignment_id"]}));
    }
    if run["context_hash"].as_str().is_none() || run["authorization"]["snapshot_hash"].as_str().is_none()
        || run["id"].as_str().is_none() || state["attempt"].as_u64().is_none() {
        bail!("waiver context unavailable");
    }
    let scope = json!({"run_id":run["id"],"stage_id":stage_id,"stage_attempt":state["attempt"],
        "assignment_id":state["assignment_id"],"selected_evidence":state["evidence"],
        "context_hash":run["context_hash"],"authorization_hash":run["authorization"]["snapshot_hash"],
        "workflow":{"id":pack.id,"version":pack.version},"policy":policy,"artifacts":artifacts,
        "outputs":stage.produces});
    let hash = format!("{:x}", Sha256::digest(format!("kode.stage.waiver.scope.v1\n{}", scope).as_bytes()));
    Ok(json!({"scope":scope,"scope_hash":hash}))
}

/// Read-only owner preview. The eventual decision must repeat these checks transactionally.
impl super::store::Store {
    pub fn stage_waiver_plan(&self, id: &str, stage_id: &str) -> Result<Value> {
        if !super::model::valid_id(id) || !super::model::valid_id(stage_id) {
            bail!("invalid waiver identity");
        }
        let db = self.db.lock();
        let run = super::work_assignments::read_run(&db, id)?;
        plan_in(&db, &run, stage_id, super::model::now())
    }
}

pub(super) fn plan_in(db: &rusqlite::Connection, run: &Value, stage_id: &str, at: u64) -> Result<Value> {
    if !matches!(run["state"].as_str(), Some("queued" | "running" | "waiting_resource" | "waiting_user"))
        || run["completion_authorized"] != false {
        bail!("waiver unavailable for closed or cancelling run");
    }
    let authority = super::team_activation::authorized(db,
        run["team_id"].as_str().ok_or_else(|| anyhow::anyhow!("missing waiver team"))?,
        run["team_revision"].as_u64().ok_or_else(|| anyhow::anyhow!("missing waiver team version"))?, at)?;
    if authority.is_none_or(|value| value["snapshot_hash"] != run["authorization"]["snapshot_hash"]) {
        bail!("waiver authority unavailable");
    }
    let pack: Pack = serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
    let scope = scope(run, &pack, stage_id)?;
    let states = run["stages"].as_array().unwrap();
    let state = states.iter().find(|s| s["stage_id"] == stage_id).unwrap();
    if !matches!(state["state"].as_str(), Some("pending" | "ready" | "rejected")) {
        bail!("waiver stage is already resolved or executing");
    }
    let unsettled: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM work_assignments WHERE run_id=?1 AND state NOT IN ('completed','abandoned')) OR EXISTS(SELECT 1 FROM assignment_resource_holds h JOIN work_assignments a ON a.id=h.assignment_id WHERE a.run_id=?1 AND h.state!='released')",
        [run["id"].as_str()], |r| r.get(0))?;
    if unsettled { bail!("waiver requires all current execution to be drained"); }
    // A preview never claims an in-flight stage can be skipped. Physical stop, released
    // reservations and finalized accounting remain prerequisites of the owner decision.
    if let Some(assignment_id) = state["assignment_id"].as_str() {
        let body: String = db.query_row("SELECT body FROM work_assignments WHERE id=?1", [assignment_id], |r| r.get(0))?;
        let assignment: Value = serde_json::from_str(&body)?;
        if assignment["state"] != "completed" || assignment["resources"]["state"] != "released"
            || assignment["accounting"]["receipt"]["reservation"]["finalized"] != true {
            bail!("waiver requires drained execution and finalized accounting");
        }
    }
    for artifact in scope["scope"]["artifacts"].as_object().unwrap().values() {
        let producer = artifact["stage_id"].as_str().unwrap();
        let source = states.iter().find(|s| s["stage_id"] == producer).unwrap();
        let selected: BTreeMap<String, u64> = serde_json::from_value(source["evidence"]["outputs"].clone())?;
        if super::stage_evidence::check_frozen(db, run, &pack, producer, &selected, at)?["evidence_matches"] != true {
            bail!("waiver artifact no longer matches frozen evidence");
        }
    }
    Ok(json!({"run_id":run["id"],"run_revision":run["revision"],"stage_id":stage_id,
        "scope":scope["scope"],"scope_hash":scope["scope_hash"],"completion_authorized":false}))
}

/// A dependency can be satisfied by evidence or an explicit, still-current owner waiver.
pub(super) fn dependency_satisfied(db: &rusqlite::Connection, run: &Value, pack: &Pack, id: &str, at: u64) -> Result<bool> {
    let state = run["stages"].as_array().and_then(|rows| rows.iter().find(|s| s["stage_id"] == id));
    match state.and_then(|s| s["state"].as_str()) {
        Some("passed") => Ok(true),
        Some("waived") => { require_current(db, run, pack, id, at)?; Ok(true) },
        _ => Ok(false),
    }
}

/// A stored waiver satisfies policy only while its exact scope and immutable receipt agree.
/// Callers still check current activation and completion/accounting gates.
pub(super) fn require_current(db: &rusqlite::Connection, run: &Value, pack: &Pack, stage_id: &str, at: u64) -> Result<Value> {
    let stage = run["stages"].as_array().and_then(|rows| rows.iter().find(|s| s["stage_id"] == stage_id))
        .ok_or_else(|| anyhow::anyhow!("missing waived stage"))?;
    let decision = &stage["waiver"];
    let current = scope(run, pack, stage_id)?;
    if stage["state"] != "waived" || current["scope"]["policy"]["allow_delivery"] != true
        || decision["scope_hash"] != current["scope_hash"] || decision["scope"] != current["scope"]
        || decision["actor"] != json!({"kind":"human","id":"local_owner"})
        || decision["reason"].as_str().is_none_or(|reason| reason.trim().is_empty()) {
        bail!("waiver no longer matches current evidence or delivery policy");
    }
    let request_id = decision["request_id"].as_str().ok_or_else(|| anyhow::anyhow!("waiver receipt missing"))?;
    let saved: String = db.query_row("SELECT result FROM work_run_commands WHERE run_id=?1 AND request_id=?2",
        rusqlite::params![run["id"].as_str(), request_id], |r| r.get(0))?;
    let saved: Value = serde_json::from_str(&saved)?;
    if saved["stages"].as_array().and_then(|rows| rows.iter().find(|s| s["stage_id"] == stage_id))
        .is_none_or(|s| s["state"] != "waived" || s["waiver"] != *decision) {
        bail!("waiver receipt mismatch");
    }
    for artifact in current["scope"]["artifacts"].as_object().unwrap().values() {
        let producer = artifact["stage_id"].as_str().unwrap();
        let source = run["stages"].as_array().unwrap().iter().find(|s| s["stage_id"] == producer).unwrap();
        let selected: BTreeMap<String, u64> = serde_json::from_value(source["evidence"]["outputs"].clone())?;
        if super::stage_evidence::check_frozen(db, run, pack, producer, &selected, at)?["evidence_matches"] != true {
            bail!("waiver artifact no longer matches frozen evidence");
        }
    }
    Ok(decision.clone())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub request_id: String,
    pub expected_revision: u64,
    pub scope_hash: String,
    pub reason: String,
}

impl super::store::Store {
    pub fn stage_waiver_receipt(&self, id: &str, stage_id: &str, request_id: &str) -> Result<Value> {
        use rusqlite::OptionalExtension;
        if ![id, stage_id, request_id].iter().all(|value| super::model::valid_id(value)) {
            bail!("invalid waiver receipt identity");
        }
        let row: Option<(String, String)> = self.db.lock().query_row(
            "SELECT request,result FROM work_run_commands WHERE run_id=?1 AND request_id=?2",
            rusqlite::params![id, request_id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let Some((request, result)) = row else { return Ok(json!({"receipt":null})); };
        let request: Value = serde_json::from_str(&request)?;
        if request["action"] != "waive_stage" || request["stage_id"] != stage_id {
            bail!("waiver receipt identity conflict");
        }
        Ok(json!({"receipt":{"request":request,"result":serde_json::from_str::<Value>(&result)?}}))
    }

    pub fn waive_stage(&self, id: &str, stage_id: &str, input: Decision) -> Result<Value> {
        if !super::model::valid_id(id) || !super::model::valid_id(stage_id)
            || !super::model::valid_id(&input.request_id)
            || input.expected_revision == 0 || input.expected_revision >= i64::MAX as u64
            || input.scope_hash.len() != 64 || !input.scope_hash.bytes().all(|b| b.is_ascii_hexdigit())
            || input.reason.trim().is_empty() || input.reason.len() > 2048 || input.reason.contains('\0') {
            bail!("invalid stage waiver decision");
        }
        let request = json!({"action":"waive_stage","stage_id":stage_id,"input":input});
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        // Exact historical receipt wins even after subsequent run or policy changes.
        if let Some(saved) = super::work_assignments::retry(&tx, id, &input.request_id, &request)? {
            return Ok(saved);
        }
        let mut run = super::work_assignments::read_run(&tx, id)?;
        if run["revision"] != input.expected_revision { bail!("work run revision conflict"); }
        let at = super::model::now();
        let preview = plan_in(&tx, &run, stage_id, at)?;
        if preview["scope_hash"] != input.scope_hash { bail!("waiver scope changed"); }
        let decision = json!({"request_id":input.request_id,"scope_hash":input.scope_hash,
            "scope":preview["scope"],"reason":input.reason,"at":at,
            "actor":{"kind":"human","id":"local_owner"}});
        let stage = run["stages"].as_array_mut().unwrap().iter_mut()
            .find(|s| s["stage_id"] == stage_id).unwrap();
        stage["state"] = json!("waived");
        stage["waiver"] = decision.clone();
        // Never synthesize passed evidence or authorize delivery in the decision command.
        // Finalization must independently consume and revalidate the explicit waiver.
        let questions = super::assignment_clarification::clear_pending(&mut run, Some(stage_id));
        if let Some(first) = questions.first() {
            let stage = run["stages"].as_array_mut().unwrap().iter_mut().find(|s| s["stage_id"] == stage_id).unwrap();
            stage["waiver"]["superseded_clarification"] = first.clone();
            stage["waiver"]["superseded_clarifications"] = json!(questions);
        }
        let allow_delivery = preview["scope"]["policy"]["allow_delivery"] == true;
        run["state"] = json!(if allow_delivery { "queued" } else { "waiting_user" });
        run["waiting_reason"] = json!(if allow_delivery {
            "waiver_progression_pending"
        } else { "waiver_delivery_disallowed" });
        run["revision"] = json!(input.expected_revision + 1);
        run["updated_at"] = json!(at);
        tx.execute("UPDATE work_runs SET revision=?2,state=?3,body=?4 WHERE id=?1",
            rusqlite::params![id, input.expected_revision + 1, run["state"].as_str(), run.to_string()])?;
        tx.execute("INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
            rusqlite::params![id, input.request_id, request.to_string(), run.to_string()])?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",
            rusqlite::params![id, json!({"kind":"stage_waived","stage_id":stage_id,"revision":run["revision"],
                "decision":decision,"completion_authorized":false,"at":at}).to_string()])?;
        tx.commit()?;
        Ok(run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Pack, Value) {
        let pack = serde_json::from_value(json!({"id":"flow","version":"1","inputs":["request"],
            "stages":[{"id":"build","role":"author","requires":["request"],"produces":["artifact"],"independent_from":[]},
                {"id":"check","role":"reviewer","requires":["build"],"produces":["review"],"independent_from":["build"],"waiver":{"allow_delivery":false}}],
            "completion_stages":["check"],"evidence_rules":{"artifact":{"kind":"artifact","repository_binding":"code"},"review":{"kind":"review","artifact_output":"artifact"}}})).unwrap();
        let run = json!({"id":"run","revision":4,"context_hash":"context","authorization":{"snapshot_hash":"authority"},
            "stages":[{"stage_id":"build","state":"passed","attempt":1,"assignment_id":"author","evidence":{"assignment_id":"author","stage_attempt":1,"context_hash":"context","authorization_hash":"authority","outputs":{"artifact":8}}},
                {"stage_id":"check","state":"pending","attempt":0,"assignment_id":null}]});
        (pack, run)
    }
    #[test]
    fn explicit_policy_cannot_waive_artifact_creation_or_invent_evidence() {
        let (mut pack, mut run) = fixture();
        assert!(super::super::workflows::validate(&pack).is_ok());
        pack.stages[0].waiver = Some(Policy { allow_delivery: true });
        assert!(super::super::workflows::validate(&pack).is_err());
        pack.stages[0].waiver = None;
        run["stages"][0]["evidence"]["outputs"]["artifact"] = Value::Null;
        assert!(scope(&run, &pack, "check").is_err());
        run = fixture().1;
        run["stages"][0]["state"] = json!("waived");
        assert!(scope(&run, &pack, "check").is_err());
        pack.stages[1].waiver = None;
        assert!(scope(&fixture().1, &pack, "check").is_err());
    }
    #[test]
    fn scope_invalidates_changed_artifact_attempt_context_and_policy_not_unrelated_revision() {
        let (mut pack, run) = fixture();
        let original = scope(&run, &pack, "check").unwrap();
        let mut later = run.clone(); later["revision"] = json!(99);
        assert_eq!(scope(&later, &pack, "check").unwrap(), original);
        later["stages"][0]["evidence"]["outputs"]["artifact"] = json!(9);
        assert_ne!(scope(&later, &pack, "check").unwrap()["scope_hash"], original["scope_hash"]);
        later = run.clone(); later["stages"][1]["attempt"] = json!(1);
        assert_ne!(scope(&later, &pack, "check").unwrap()["scope_hash"], original["scope_hash"]);
        later = run.clone(); later["context_hash"] = json!("changed");
        assert!(scope(&later, &pack, "check").is_err());
        pack.stages[1].waiver.as_mut().unwrap().allow_delivery = true;
        assert_ne!(scope(&run, &pack, "check").unwrap()["scope_hash"], original["scope_hash"]);
    }
}
