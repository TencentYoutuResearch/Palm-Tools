//! Match stored observations to a workflow and explicit binding context. Read-only;
//! WorkRun must supply its own frozen context before using this as a completion gate.
use super::{
    artifact_evidence::{Evidence, Payload, Verdict},
    model::{now, valid_id},
    operations::{Operation, State},
    store::Store,
    teams::WorkflowRef,
    workflows::{EvidenceRule, Pack},
};
use anyhow::{bail, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    operation_id: String,
    attempt: u64,
    epoch: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    id: String,
    revision: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    workflow: WorkflowRef,
    stage_id: String,
    assignments: BTreeMap<String, Assignment>,
    outputs: BTreeMap<String, u64>,
    repositories: BTreeMap<String, String>,
    commands: BTreeMap<String, Command>,
    environments: BTreeMap<String, String>,
}
fn observation(
    db: &Connection,
    pack: &Pack,
    input: &Check,
    output: &str,
    owner: &str,
    at: u64,
) -> Result<Option<(u64, Evidence, Value)>> {
    let Some(sequence) = input.outputs.get(output) else {
        return Ok(None);
    };
    let Some(stage) = pack
        .stages
        .iter()
        .find(|s| s.produces.iter().any(|p| p == output))
    else {
        return Ok(None);
    };
    let Some(assignment) = input.assignments.get(&stage.id) else {
        return Ok(None);
    };
    let body: Option<String> = db
        .query_row(
            "SELECT body FROM operations WHERE id=?1",
            [&assignment.operation_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(body) = body else {
        return Ok(None);
    };
    let operation: Operation = serde_json::from_str(&body)?;
    if operation.owner != owner
        || operation.attempt != assignment.attempt
        || operation.epoch != assignment.epoch
        || !matches!(operation.state, State::Active | State::Reported)
        || (operation.state == State::Active
            && operation.lease_until.is_none_or(|until| until <= at))
    {
        return Ok(None);
    }
    let body:Option<String>=db.query_row("SELECT body FROM operation_events WHERE seq=?1 AND json_extract(body,'$.kind')='artifact_evidence'",[sequence],|r|r.get(0)).optional()?;
    let Some(body) = body else {
        return Ok(None);
    };
    let event: Value = serde_json::from_str(&body)?;
    let evidence: Evidence = serde_json::from_value(event["evidence"].clone())?;
    if evidence.operation_id != assignment.operation_id
        || evidence.attempt != assignment.attempt
        || evidence.epoch != assignment.epoch
        || event["owner"] != owner
    {
        return Ok(None);
    }
    Ok(Some((*sequence, evidence, event)))
}
fn artifact_binding_matches(pack: &Pack, input: &Check, output: &str, payload: &Payload) -> bool {
    match (pack.evidence_rules.get(output), payload) {
        (Some(EvidenceRule::Artifact { repository_binding }), Payload::Artifact { snapshot }) => {
            input.repositories.get(repository_binding) == Some(&snapshot.repository_id)
        }
        _ => false,
    }
}
impl Store {
    pub fn check_workflow_evidence(&self, input: Check) -> Result<Value> {
        let stored = self
            .workflow(&input.workflow.id, &input.workflow.version)?
            .ok_or_else(|| anyhow::anyhow!("unknown workflow version"))?;
        if stored["hash"] != input.workflow.hash {
            bail!("workflow hash mismatch");
        }
        let pack: Pack = serde_json::from_value(stored["pack"].clone())?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = check_in(&tx, &pack, &input, now())?;
        tx.commit()?;
        Ok(result)
    }
}
pub(super) fn check_in(db: &Connection, pack: &Pack, input: &Check, at: u64) -> Result<Value> {
    check_outcome(db, pack, input, at, false)
}
pub(super) fn check_outcome(
    db: &Connection,
    pack: &Pack,
    input: &Check,
    at: u64,
    allow_rejected: bool,
) -> Result<Value> {
    if !valid_id(&input.stage_id)
        || [
            &input.assignments.len(),
            &input.outputs.len(),
            &input.repositories.len(),
            &input.commands.len(),
            &input.environments.len(),
        ]
        .iter()
        .any(|v| **v > 128)
        || input
            .outputs
            .values()
            .any(|seq| *seq == 0 || *seq > i64::MAX as u64)
    {
        bail!("invalid workflow evidence check bounds");
    }
    if pack.evidence_rules.is_empty() {
        bail!("workflow lacks evidence rules");
    }
    let stage = pack
        .stages
        .iter()
        .find(|s| s.id == input.stage_id)
        .ok_or_else(|| anyhow::anyhow!("unknown workflow stage"))?;
    let assignment = input
        .assignments
        .get(&stage.id)
        .ok_or_else(|| anyhow::anyhow!("stage assignment required"))?;
    let body: String = db.query_row(
        "SELECT body FROM operations WHERE id=?1",
        [&assignment.operation_id],
        |r| r.get(0),
    )?;
    let operation: Operation = serde_json::from_str(&body)?;
    let mut issues = Vec::new();
    let mut failed = false;
    for output in &stage.produces {
        let Some((_, evidence, _)) = observation(db, pack, input, output, &operation.owner, at)?
        else {
            issues.push(json!({"output":output,"code":"missing_or_stale_assignment_evidence"}));
            continue;
        };
        let rule = &pack.evidence_rules[output];
        let matches = match (rule, &evidence.payload) {
            (EvidenceRule::Artifact { repository_binding }, Payload::Artifact { snapshot }) => {
                input.repositories.get(repository_binding) == Some(&snapshot.repository_id)
            }
            (
                EvidenceRule::Review { artifact_output },
                Payload::Review {
                    artifact_sequence,
                    snapshot_hash,
                    verdict,
                    findings,
                },
            ) => {
                let source = observation(db, pack, input, artifact_output, &operation.owner, at)?;
                failed |= *verdict == Verdict::Failed;
                ((*verdict == Verdict::Passed && !findings.iter().any(|f| f.blocking))
                    || (allow_rejected && *verdict == Verdict::Failed))
                    && source.is_some_and(|(seq, source, event)| {
                        artifact_binding_matches(&pack, &input, artifact_output, &source.payload)
                            && seq == *artifact_sequence
                            && event["snapshot_hash"] == *snapshot_hash
                            && source.operation_id != evidence.operation_id
                            && (event["producer"]["node_id"] != operation.worker.node_id
                                || event["producer"]["session_id"] != operation.worker.session_id)
                    })
            }
            (
                EvidenceRule::Verification {
                    artifact_output,
                    command_binding,
                    environment_binding,
                    required_scenarios,
                },
                Payload::Verification {
                    artifact_sequence,
                    snapshot_hash,
                    verdict,
                    environment_hash,
                    command_id,
                    command_revision,
                    scenario_ids,
                    exit_code,
                    ..
                },
            ) => {
                let source = observation(db, pack, input, artifact_output, &operation.owner, at)?;
                failed |= *verdict == Verdict::Failed;
                ((*verdict == Verdict::Passed && *exit_code == Some(0))
                    || (allow_rejected
                        && *verdict == Verdict::Failed
                        && exit_code.is_some_and(|code| code != 0)))
                    && input
                        .commands
                        .get(command_binding)
                        .is_some_and(|c| c.id == *command_id && c.revision == *command_revision)
                    && input.environments.get(environment_binding) == Some(environment_hash)
                    && required_scenarios
                        .iter()
                        .all(|id| scenario_ids.contains(id))
                    && source.is_some_and(|(seq, source, event)| {
                        artifact_binding_matches(&pack, &input, artifact_output, &source.payload)
                            && seq == *artifact_sequence
                            && event["snapshot_hash"] == *snapshot_hash
                    })
            }
            // Report schemas need an actual registered validator; never accept free text here.
            _ => false,
        };
        if !matches {
            issues.push(json!({"output":output,"code":"evidence_rule_mismatch"}));
        }
    }
    Ok(
        json!({"schema_version":1,"stage_id":stage.id,"workflow":input.workflow,"evidence_matches":issues.is_empty(),"rejection_matches":allow_rejected && failed && issues.is_empty(),"issues":issues,
            "completion_authorized":false,"binding_context":"caller_supplied_preflight","pending_checks":["frozen_workrun_context","dependencies","current_artifact_selection","trusted_verification_execution","report_schemas","delivery_policy"]}),
    )
}
