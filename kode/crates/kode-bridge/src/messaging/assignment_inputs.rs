//! Freeze upstream evidence identities at preparation; this is not derived-root execution authority.
use super::{
    stage_evidence,
    workflows::{EvidenceRule, Pack},
};
use anyhow::{bail, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn freeze(db: &Connection, run: &Value, stage_id: &str, at: u64) -> Result<Value> {
    let pack: Pack = serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
    let stage = pack
        .stages
        .iter()
        .find(|s| s.id == stage_id)
        .ok_or_else(|| anyhow::anyhow!("unknown stage input target"))?;
    let mut pending = stage.requires.clone();
    let mut visited = BTreeSet::new();
    let mut external = BTreeMap::new();
    let mut sources = BTreeMap::new();
    let mut waivers = BTreeMap::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        if pack.inputs.contains(&id) {
            if run["inputs"][&id].is_null() {
                bail!("stage external input missing")
            }
            external.insert(id.clone(), run["inputs"][&id].clone());
            continue;
        }
        let producer = pack
            .stages
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| anyhow::anyhow!("stage input producer missing"))?;
        let state = run["stages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["stage_id"] == id)
            .ok_or_else(|| anyhow::anyhow!("stage input state missing"))?;
        if state["state"] == "waived" {
            let decision = super::stage_waiver::require_current(db, run, &pack, &id, at)?;
            let mut producer_identity = Value::Null;
            if let Some(assignment_id) = state["assignment_id"].as_str() {
                let body: String = db.query_row("SELECT body FROM work_assignments WHERE id=?1", [assignment_id], |r| r.get(0))?;
                let prior: Value = serde_json::from_str(&body)?;
                producer_identity = json!({"assignment_id":assignment_id,"worker":prior["worker"],"operation":prior["bundle"]["operation"]});
            }
            waivers.insert(id.clone(), json!({"decision":decision,"producer":producer_identity}));
            pending.extend(producer.requires.clone());
            continue;
        }
        if state["state"] != "passed" || state["evidence"].is_null() {
            bail!("stage input producer has not passed")
        }
        let body: String = db.query_row(
            "SELECT body FROM work_assignments WHERE id=?1",
            [state["assignment_id"].as_str()],
            |r| r.get(0),
        )?;
        let assignment: Value = serde_json::from_str(&body)?;
        if assignment["state"] != "completed"
            || assignment["run_id"] != run["id"]
            || assignment["stage_id"] != id
            || assignment["stage_attempt"] != state["attempt"]
            || state["evidence"]["assignment_id"] != assignment["id"]
            || assignment["context_hash"] != run["context_hash"]
            || assignment["authorization_hash"] != run["authorization"]["snapshot_hash"]
        {
            bail!("stage input Assignment binding mismatch")
        }
        let selected: BTreeMap<String, u64> =
            serde_json::from_value(state["evidence"]["outputs"].clone())?;
        if selected.len() != producer.produces.len()
            || producer.produces.iter().any(|o| !selected.contains_key(o))
            || stage_evidence::check_frozen(db, run, &pack, &id, &selected, at)?["evidence_matches"]
                != true
        {
            bail!("stage input frozen evidence mismatch")
        }
        let mut outputs = BTreeMap::new();
        for (output, sequence) in selected {
            let mut evidence = json!({"sequence":sequence});
            if let Some(EvidenceRule::Artifact { repository_binding }) =
                pack.evidence_rules.get(&output)
            {
                let (hash, bytes, complete): (String, u64, bool) = db.query_row(
                    "SELECT hash,bytes,complete FROM artifact_archives WHERE sequence=?1",
                    [sequence],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                if !complete {
                    bail!("stage input artifact archive incomplete")
                }
                let body: String = db.query_row(
                    "SELECT body FROM operation_events WHERE seq=?1",
                    [sequence],
                    |r| r.get(0),
                )?;
                let observation: Value = serde_json::from_str(&body)?;
                evidence["artifact"] = json!({"repository_binding":repository_binding,
                    "snapshot_hash":observation["snapshot_hash"],"archive_hash":hash,"bytes":bytes});
            }
            outputs.insert(output, evidence);
        }
        let mut source = json!({"assignment_id":assignment["id"],"stage_attempt":state["attempt"],
            "worker":assignment["worker"],"operation":assignment["bundle"]["operation"],"outputs":outputs});
        let clarifications = super::assignment_answers::frozen_context(db, &assignment)?;
        if !clarifications.is_empty() {
            source["clarifications"] = json!(clarifications);
        }
        sources.insert(id, source);
        pending.extend(producer.requires.clone());
    }
    let mut binding = json!({"format":"kode.assignment.inputs.v1","run_id":run["id"],"run_revision":run["revision"],
        "stage_id":stage_id,"context_hash":run["context_hash"],"authorization_hash":run["authorization"]["snapshot_hash"],
        "external":external,"sources":sources});
    if !waivers.is_empty() { binding["waivers"] = json!(waivers); }
    if let Some(feedback) = run["reworks"]
        .as_array()
        .and_then(|rows| rows.iter().rev().find(|row| row["target"] == stage_id))
    {
        binding["rework"] = feedback.clone();
    }
    let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&binding)?));
    Ok(json!({"binding":binding,"hash":hash,"execution_authorized":false}))
}
