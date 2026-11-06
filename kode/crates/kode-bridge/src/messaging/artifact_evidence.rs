//! Structured Host observations. Receipt acceptance is never a WorkRun completion verdict.
use super::{model::valid_id, operations::Operation, store::Store};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub repository_id: String,
    pub base_revision: String,
    pub tree_hash: String,
    pub patch_hash: String,
    pub artifact_hashes: BTreeMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Passed,
    Failed,
    Inconclusive,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finding {
    pub id: String,
    pub blocking: bool,
    pub evidence_ref: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Payload {
    Artifact {
        snapshot: Snapshot,
    },
    Review {
        artifact_sequence: u64,
        snapshot_hash: String,
        verdict: Verdict,
        findings: Vec<Finding>,
    },
    Verification {
        artifact_sequence: u64,
        snapshot_hash: String,
        verdict: Verdict,
        environment_hash: String,
        command_id: String,
        command_revision: String,
        scenario_ids: Vec<String>,
        exit_code: Option<i32>,
        log_ref: String,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub id: String,
    pub operation_id: String,
    pub attempt: u64,
    pub epoch: u64,
    pub payload: Payload,
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl Evidence {
    fn validate(&self) -> Result<()> {
        if !valid_id(&self.id)
            || !valid_id(&self.operation_id)
            || self.attempt == 0
            || self.epoch == 0
            || self.attempt > i64::MAX as u64
            || self.epoch > i64::MAX as u64
            || serde_json::to_vec(self)?.len() > 65536
        {
            bail!("invalid artifact evidence bounds");
        }
        match &self.payload {
            Payload::Artifact { snapshot: s } => {
                if !valid_id(&s.repository_id)
                    || !valid_id(&s.base_revision)
                    || !hash(&s.tree_hash)
                    || !hash(&s.patch_hash)
                    || s.artifact_hashes.len() > 64
                    || s.artifact_hashes
                        .iter()
                        .any(|(k, v)| !valid_id(k) || !hash(v))
                {
                    bail!("invalid artifact snapshot");
                }
            }
            Payload::Review {
                artifact_sequence,
                snapshot_hash,
                verdict,
                findings,
            } => {
                if *artifact_sequence == 0
                    || *artifact_sequence > i64::MAX as u64
                    || !hash(snapshot_hash)
                    || findings.len() > 128
                    || findings
                        .iter()
                        .any(|f| !valid_id(&f.id) || !valid_id(&f.evidence_ref))
                    || findings
                        .iter()
                        .map(|f| &f.id)
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != findings.len()
                    || (*verdict == Verdict::Passed && findings.iter().any(|f| f.blocking))
                {
                    bail!("invalid review evidence");
                }
            }
            Payload::Verification {
                artifact_sequence,
                snapshot_hash,
                verdict,
                environment_hash,
                command_id,
                command_revision,
                scenario_ids,
                exit_code,
                log_ref,
            } => {
                if *artifact_sequence == 0
                    || *artifact_sequence > i64::MAX as u64
                    || !hash(snapshot_hash)
                    || !hash(environment_hash)
                    || !valid_id(command_id)
                    || !valid_id(command_revision)
                    || !valid_id(log_ref)
                    || scenario_ids.is_empty()
                    || scenario_ids.len() > 128
                    || scenario_ids.iter().any(|s| !valid_id(s))
                    || scenario_ids
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != scenario_ids.len()
                    || (*verdict == Verdict::Passed && *exit_code != Some(0))
                {
                    bail!("invalid verification evidence");
                }
            }
        }
        Ok(())
    }
}
impl Store {
    pub fn record_artifact_evidence(&self, input: Evidence) -> Result<Value> {
        input.validate()?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let old:Option<(u64,String)>=tx.query_row("SELECT seq,body FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='artifact_evidence' AND json_extract(body,'$.evidence.id')=?2 LIMIT 1",
            params![input.operation_id,input.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((sequence, body)) = old {
            let event: Value = serde_json::from_str(&body)?;
            let prior: Evidence = serde_json::from_value(event["evidence"].clone())?;
            if prior != input {
                bail!("artifact evidence identity conflict");
            }
            return Ok(
                json!({"sequence":sequence,"record":event,"duplicate":true,"completion_authorized":false}),
            );
        }
        let body: String = tx.query_row(
            "SELECT body FROM operations WHERE id=?1",
            [&input.operation_id],
            |r| r.get(0),
        )?;
        let operation: Operation = serde_json::from_str(&body)?;
        let admitted:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.operation.attempt')=?2 AND json_extract(body,'$.operation.epoch')=?3 AND json_extract(body,'$.operation.state')='active')",
            params![input.operation_id,input.attempt,input.epoch],|r|r.get(0))?;
        if !admitted {
            bail!("artifact evidence lacks an admitted attempt");
        }
        let assignment: Option<String> = tx
            .query_row(
                "SELECT body FROM work_assignments WHERE operation_id=?1",
                [&input.operation_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(body) = assignment {
            let assignment: Value = serde_json::from_str(&body)?;
            let consumed = super::assignment_mandate::consumed(&tx, &assignment, &self.node_id)?;
            if !consumed {
                bail!("assignment artifact requires consumed mandate")
            }
        }
        let snapshot_hash = match &input.payload {
            Payload::Artifact { snapshot } => format!(
                "{:x}",
                Sha256::digest(
                    format!(
                        "kode.artifact.snapshot.v1\n{}",
                        serde_json::to_string(snapshot)?
                    )
                    .as_bytes()
                )
            ),
            Payload::Review {
                artifact_sequence,
                snapshot_hash,
                ..
            }
            | Payload::Verification {
                artifact_sequence,
                snapshot_hash,
                ..
            } => {
                let source:Option<String>=tx.query_row("SELECT body FROM operation_events WHERE seq=?1 AND json_extract(body,'$.kind')='artifact_evidence'",[artifact_sequence],|r|r.get(0)).optional()?;
                let source: Value = serde_json::from_str(
                    &source.ok_or_else(|| anyhow::anyhow!("unknown artifact evidence"))?,
                )?;
                if source["evidence"]["payload"]["kind"] != "artifact"
                    || source["snapshot_hash"] != *snapshot_hash
                    || source["owner"] != operation.owner
                {
                    bail!("artifact evidence source mismatch");
                }
                if matches!(&input.payload, Payload::Review { .. })
                    && (source["evidence"]["operation_id"] == operation.id
                        || (source["producer"]["node_id"] == operation.worker.node_id
                            && source["producer"]["session_id"] == operation.worker.session_id))
                {
                    bail!("review requires independent assignment and session context");
                }
                snapshot_hash.clone()
            }
        };
        // Late observations are retained. The future WorkRun gate must match its frozen
        // assignment, current snapshot/attempt, policy and trusted evidence provenance.
        let event = json!({"kind":"artifact_evidence","evidence":input,"snapshot_hash":snapshot_hash,
            "owner":operation.owner,"producer":operation.worker,"provenance":"host_observation"});
        tx.execute(
            "INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",
            params![input.operation_id, serde_json::to_string(&event)?],
        )?;
        let sequence = tx.last_insert_rowid();
        tx.commit()?;
        Ok(
            json!({"sequence":sequence,"record":event,"duplicate":false,"completion_authorized":false}),
        )
    }
}
