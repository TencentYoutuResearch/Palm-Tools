//! Host-reported hashes of prepared input, not proof of provider-side interpretation.
use anyhow::{bail, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub schema_version: u64,
    pub source: String,
    pub system_sha256: String,
    pub system_messages: u64,
    pub instruction: Option<Instruction>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Instruction {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<super::assignment_answer_progress::AnswerProof>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<super::workflow_dependencies::Manifest>,
    pub role: String,
    pub version: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mandate_sha256: Option<String>,
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
pub(super) fn validate(db: &Connection, operation: &str, proof: &Provenance) -> Result<()> {
    if proof.schema_version != 1
        || proof.source != "official_prepared_input"
        || !hash(&proof.system_sha256)
        || proof.system_messages > 4096
    {
        bail!("invalid prepared prompt provenance")
    }
    let Some(input) = &proof.instruction else {
        return Ok(());
    };
    if !hash(&input.sha256) || !super::model::valid_id(&input.version) {
        bail!("invalid prompt instruction identity")
    }
    match input.role.as_str() {
        "worker" => {
            let Some(id) = input.assignment_id.as_deref() else {
                bail!("missing prompt assignment")
            };
            if input.version != "kode.assignment.mandate.v1" || !super::model::valid_id(id) {
                bail!("invalid prompt assignment identity")
            }
            let body: String = db.query_row(
                "SELECT body FROM work_assignments WHERE id=?1 AND operation_id=?2",
                params![id, operation],
                |r| r.get(0),
            )?;
            let assignment: serde_json::Value = serde_json::from_str(&body)?;
            let receipt = &assignment["mandate"]["receipt"];
            if input.answers != super::assignment_answer_progress::expected(&assignment)? {
                bail!("prompt Worker answer provenance mismatch")
            }
            if input.dependencies != super::workflow_dependencies::operation_manifest(db, operation)? {
                bail!("prompt workflow dependency provenance mismatch")
            }
            if input.message_id.as_deref().is_none()
                || input.mandate_sha256.as_deref().is_none()
                || input.message_id.as_deref() != receipt["message_id"].as_str()
                || input.mandate_sha256.as_deref() != receipt["mandate_hash"].as_str()
            {
                bail!("prompt mandate provenance mismatch")
            }
        }
        "builder" | "coordinator" => {
            if proof.system_messages == 0
                || input.sha256 != proof.system_sha256
                || input.assignment_id.is_some()
                || input.message_id.is_some()
                || input.mandate_sha256.is_some()
                || !input.dependencies.is_empty()
                || !input.answers.is_empty()
            {
                bail!("invalid system prompt provenance")
            }
        }
        _ => bail!("invalid prompt role"),
    }
    Ok(())
}
