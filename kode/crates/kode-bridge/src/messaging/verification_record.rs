//! Immutable owner-uploaded command logs bound to actual verification observations and frozen project definitions.
use super::{
    store::Store,
    workflows::{EvidenceRule, Pack},
};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Upload {
    pub result_json: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    stream: String,
    data: String,
}
fn key(sequence: u64) -> String {
    format!("verification-record:{sequence}")
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn strings(value: &Value) -> Result<Vec<String>> {
    let mut v: Vec<String> = serde_json::from_value(value.clone())?;
    v.sort();
    Ok(v)
}
fn validate(db: &Connection, sequence: u64, raw: &str) -> Result<Value> {
    if sequence == 0 || sequence > i64::MAX as u64 || raw.len() > 3 * 1024 * 1024 {
        bail!("verification record bounds")
    }
    let result: Value = serde_json::from_str(raw)?;
    let body: String = db.query_row(
        "SELECT body FROM operation_events WHERE seq=?1",
        [sequence],
        |r| r.get(0),
    )?;
    let event: Value = serde_json::from_str(&body)?;
    let evidence = &event["evidence"];
    let payload = &evidence["payload"];
    if event["kind"] != "artifact_evidence"
        || payload["kind"] != "verification"
        || result["completion_authorized"] != false
        || result["request_id"] != evidence["id"]
        || result["operation"]["id"] != evidence["operation_id"]
        || result["operation"]["attempt"] != evidence["attempt"]
        || result["operation"]["epoch"] != evidence["epoch"]
        || result["source_sequence"] != payload["artifact_sequence"]
        || result["snapshot_hash"] != payload["snapshot_hash"]
        || result["log_ref"] != payload["log_ref"]
        || result["observed"]["exit_code"] != payload["exit_code"]
    {
        bail!("verification record observation mismatch")
    }
    let body: String = db.query_row(
        "SELECT body FROM work_assignments WHERE operation_id=?1",
        [evidence["operation_id"].as_str()],
        |r| r.get(0),
    )?;
    let assignment: Value = serde_json::from_str(&body)?;
    if result["operation"] != assignment["dispatch"]["command"]["operation"]
        || event["producer"] != assignment["worker"]
        || result["source_sequence"] != assignment["input_workspace"]["receipt"]["sequence"]
        || result["snapshot_hash"] != assignment["execution_workspace"]["receipt"]["snapshot_hash"]
    {
        bail!("verification record Assignment mismatch")
    }
    let body: String = db.query_row(
        "SELECT body FROM work_runs WHERE id=?1",
        [assignment["run_id"].as_str()],
        |r| r.get(0),
    )?;
    let run: Value = serde_json::from_str(&body)?;
    let pack: Pack = serde_json::from_value(run["context"]["binding"]["workflow"]["pack"].clone())?;
    let stage = pack
        .stages
        .iter()
        .find(|s| s.id == assignment["stage_id"])
        .ok_or_else(|| anyhow::anyhow!("verification stage missing"))?;
    let project = &run["context"]["binding"]["project"]["config"]["spec"];
    let command = &result["command"];
    let scope = &assignment["execution_workspace"]["receipt"]["scope"];
    if !strings(&scope["tools"])?.contains(&command["tool_id"].as_str().unwrap_or("").to_owned())
        || strings(&command["capabilities"])?.iter().any(|c| {
            !strings(&scope["capabilities"])
                .unwrap_or_default()
                .contains(c)
        })
        || (command["network"] == true && scope["network"] != true)
    {
        bail!("verification record scope mismatch")
    }
    let mut matches = false;
    for output in &stage.produces {
        if let Some(EvidenceRule::Verification {
            artifact_output,
            command_binding,
            environment_binding,
            required_scenarios,
        }) = pack.evidence_rules.get(output)
        {
            let fixed = &project["commands"][command_binding];
            let environment = &project["environments"][environment_binding];
            let source = assignment["inputs"]["binding"]["sources"]
                .as_object()
                .unwrap()
                .values()
                .find_map(|s| s["outputs"].get(artifact_output));
            matches |= command["id"] == fixed["id"]
                && command["revision"] == fixed["revision"]
                && command["definition_hash"] == fixed["definition_hash"]
                && command["runner_id"] == fixed["runner_id"]
                && command["environment_hash"] == environment["configuration_hash"]
                && command["environment_hash"] == payload["environment_hash"]
                && command["id"] == payload["command_id"]
                && command["revision"] == payload["command_revision"]
                && strings(&command["scenario_ids"])? == strings(&fixed["scenario_ids"])?
                && command
                    .get("exclusive_resources")
                    .map(strings)
                    .transpose()?
                    .unwrap_or_default()
                    == fixed
                        .get("exclusive_resources")
                        .map(strings)
                        .transpose()?
                        .unwrap_or_default()
                && strings(&command["scenario_ids"])? == strings(&payload["scenario_ids"])?
                && required_scenarios.iter().all(|s| {
                    strings(&command["scenario_ids"])
                        .unwrap_or_default()
                        .contains(s)
                })
                && source.is_some_and(|s| {
                    s["sequence"] == result["source_sequence"]
                        && s["artifact"]["snapshot_hash"] == result["snapshot_hash"]
                });
        }
    }
    if !matches {
        bail!("verification record frozen command mismatch")
    }
    let observed = &result["observed"];
    let chunks: Vec<Chunk> = serde_json::from_value(observed["output"].clone())?;
    if chunks.len() > 4096 {
        bail!("verification log chunk bounds")
    }
    let mut bytes = 0usize;
    for chunk in &chunks {
        if !matches!(chunk.stream.as_str(), "stdout" | "stderr") {
            bail!("verification log stream")
        }
        let data = STANDARD.decode(&chunk.data)?;
        if STANDARD.encode(&data) != chunk.data {
            bail!("verification log encoding")
        }
        bytes = bytes
            .checked_add(data.len())
            .ok_or_else(|| anyhow::anyhow!("verification log bounds"))?;
        if bytes > 1024 * 1024 {
            bail!("verification log bounds")
        }
    }
    if observed["output_bytes"] != bytes
        || result["log_hash"] != digest(&serde_json::to_vec(&chunks)?)
    {
        bail!("verification log digest mismatch")
    }
    let passed = observed["process_group_empty"] == true
        && observed["reason"] == "exited"
        && observed["exit_code"] == 0
        && observed["exit_signal"].is_null()
        && observed["spawn_error"].is_null()
        && observed["signal_failures"]
            .as_array()
            .is_some_and(|a| a.is_empty());
    let verdict = if passed {
        "passed"
    } else if observed["exit_code"].is_null() {
        "inconclusive"
    } else {
        "failed"
    };
    if observed["passed"] != passed
        || payload["verdict"] != verdict
        || observed["signal_scope"] != "process_group"
    {
        bail!("verification process outcome mismatch")
    }
    Ok(result)
}
pub(super) fn require_complete(db: &Connection, sequence: u64, assignment: &Value) -> Result<()> {
    require_outcome(db, sequence, assignment, false)
}
pub(super) fn require_outcome(
    db: &Connection,
    sequence: u64,
    assignment: &Value,
    rejected: bool,
) -> Result<()> {
    let body: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(sequence)],
            |r| r.get(0),
        )
        .optional()?;
    let saved: Value = serde_json::from_str(
        &body.ok_or_else(|| anyhow::anyhow!("verification command record archive required"))?,
    )?;
    let raw = saved["result_json"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("verification record corrupt"))?;
    if saved["record_hash"] != digest(raw.as_bytes()) {
        bail!("verification record integrity mismatch")
    }
    let result = validate(db, sequence, raw)?;
    if (!rejected && result["observed"]["passed"] != true)
        || result["operation"] != assignment["dispatch"]["command"]["operation"]
    {
        bail!("verification command did not pass")
    }
    let returned: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM operation_events WHERE operation_id=?1 AND json_extract(body,'$.kind')='tool_evidence' AND json_extract(body,'$.evidence.call_id')=?2 AND json_extract(body,'$.evidence.attempt')=?3 AND json_extract(body,'$.evidence.epoch')=?4 AND json_extract(body,'$.evidence.tool')=?5 AND json_extract(body,'$.evidence.status')='returned')",
        params![result["operation"]["id"].as_str(),result["request_id"].as_str(),result["operation"]["attempt"].as_u64(),result["operation"]["epoch"].as_u64(),result["command"]["tool_id"].as_str()],|r|r.get(0))?;
    if !returned {
        bail!("verification trusted tool return evidence required")
    }
    Ok(())
}
impl Store {
    pub fn verification_record(&self, sequence: u64) -> Result<Value> {
        let db = self.db.lock();
        let body: String = db.query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key(sequence)],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&body)?)
    }
    pub fn archive_verification_record(&self, sequence: u64, input: Upload) -> Result<Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [key(sequence)],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(body) = previous {
            let saved: Value = serde_json::from_str(&body)?;
            if saved["result_json"] != input.result_json {
                bail!("verification record identity conflict")
            }
            return Ok(saved);
        }
        let result = validate(&tx, sequence, &input.result_json)?;
        let receipt = json!({"sequence":sequence,"record_hash":digest(input.result_json.as_bytes()),"result_json":input.result_json,"completion_authorized":false});
        tx.execute(
            "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
            params![key(sequence), serde_json::to_string(&receipt)?],
        )?;
        tx.execute("INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",params![result["operation"]["id"].as_str(),serde_json::to_string(&json!({"kind":"verification_record_archived","sequence":sequence,"record_hash":receipt["record_hash"]}))?])?;
        tx.commit()?;
        Ok(receipt)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    pub record_hash: String,
    pub bytes: usize,
    pub offset: usize,
    pub data: String,
}
fn remote_source(db: &Connection, operation: &str, attempt: u64, sequence: u64) -> Result<()> {
    let body: String = db.query_row(
        "SELECT body FROM operation_events WHERE seq=?1 AND operation_id=?2",
        params![sequence, operation],
        |r| r.get(0),
    )?;
    let event: Value = serde_json::from_str(&body)?;
    let body: String = db.query_row(
        "SELECT body FROM work_assignments WHERE operation_id=?1",
        [operation],
        |r| r.get(0),
    )?;
    let assignment: Value = serde_json::from_str(&body)?;
    if event["kind"] != "artifact_evidence"
        || event["evidence"]["payload"]["kind"] != "verification"
        || event["evidence"]["attempt"] != attempt
        || event["producer"] != assignment["worker"]
        || assignment["dispatch"]["command"]["operation"]["attempt"] != attempt
    {
        bail!("foreign verification archive source")
    }
    Ok(())
}
impl Store {
    pub(super) fn remote_verification_segment(
        &self,
        operation: &str,
        attempt: u64,
        sequence: u64,
        input: Segment,
    ) -> Result<Value> {
        const SEGMENT: usize = 32 * 1024;
        if input.bytes == 0
            || input.bytes > 3 * 1024 * 1024
            || input.offset >= input.bytes
            || input.offset % SEGMENT != 0
            || input.record_hash.len() != 64
            || !input
                .record_hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            bail!("verification segment bounds")
        }
        let data = STANDARD.decode(&input.data)?;
        if STANDARD.encode(&data) != input.data
            || data.len() != SEGMENT.min(input.bytes - input.offset)
        {
            bail!("verification segment encoding or size")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        remote_source(&tx, operation, attempt, sequence)?;
        let staging = format!("verification-upload:{sequence}");
        let previous: Option<String> = tx
            .query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [&staging],
                |r| r.get(0),
            )
            .optional()?;
        let mut bytes = Vec::new();
        if let Some(raw) = previous {
            let saved: Value = serde_json::from_str(&raw)?;
            if saved["record_hash"] != input.record_hash || saved["bytes"] != input.bytes {
                bail!("verification segment identity conflict")
            }
            bytes = STANDARD.decode(
                saved["data"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("verification staging corrupt"))?,
            )?;
        }
        if input.offset < bytes.len() {
            if bytes.get(input.offset..input.offset + data.len()) != Some(data.as_slice()) {
                bail!("verification segment replay conflict")
            }
        } else {
            if input.offset != bytes.len() {
                bail!("verification segment gap")
            }
            bytes.extend_from_slice(&data);
            let saved = json!({"record_hash":input.record_hash,"bytes":input.bytes,"data":STANDARD.encode(&bytes)});
            tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=revision+1",params![staging,serde_json::to_string(&saved)?])?;
        }
        tx.commit()?;
        Ok(
            json!({"sequence":sequence,"record_hash":input.record_hash,"bytes":input.bytes,"offset":input.offset,"segment_bytes":data.len(),"completion_authorized":false}),
        )
    }
    pub(super) fn complete_remote_verification(
        &self,
        operation: &str,
        attempt: u64,
        sequence: u64,
        record_hash: &str,
    ) -> Result<Value> {
        let raw = {
            let db = self.db.lock();
            remote_source(&db, operation, attempt, sequence)?;
            let body: String = db.query_row(
                "SELECT value FROM workbench_documents WHERE key=?1",
                [format!("verification-upload:{sequence}")],
                |r| r.get(0),
            )?;
            let saved: Value = serde_json::from_str(&body)?;
            let bytes = STANDARD.decode(
                saved["data"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("verification staging corrupt"))?,
            )?;
            if saved["record_hash"] != record_hash
                || saved["bytes"].as_u64() != Some(bytes.len() as u64)
                || digest(&bytes) != record_hash
            {
                bail!("verification upload incomplete or corrupt")
            }
            String::from_utf8(bytes)?
        };
        let receipt = self.archive_verification_record(sequence, Upload { result_json: raw })?;
        Ok(
            json!({"sequence":sequence,"record_hash":receipt["record_hash"],"archived":true,"completion_authorized":false}),
        )
    }
}
