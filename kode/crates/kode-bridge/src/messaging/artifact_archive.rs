//! Owner-only bounded archive transfer. Partial uploads are never readable as delivered artifacts.
use super::{
    artifact_archive_format::{digest, valid_hash, validate},
    artifact_evidence::Snapshot,
    store::Store,
};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub(super) const CHUNK: usize = 256 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub archive_hash: String,
    pub bytes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chunk {
    pub archive_hash: String,
    pub bytes: usize,
    pub data: String,
}
fn bounds(sequence: u64, id: &Identity) -> Result<usize> {
    if sequence == 0
        || sequence > i64::MAX as u64
        || !valid_hash(&id.archive_hash)
        || id.bytes == 0
        || id.bytes > 192 * 1024 * 1024
    {
        bail!("invalid archive identity")
    }
    Ok(id.bytes.div_ceil(CHUNK))
}
fn source(db: &Connection, sequence: u64) -> Result<(Value, Snapshot)> {
    let body: String = db.query_row(
        "SELECT body FROM operation_events WHERE seq=?1",
        [sequence],
        |r| r.get(0),
    )?;
    let event: Value = serde_json::from_str(&body)?;
    if event["kind"] != "artifact_evidence" || event["evidence"]["payload"]["kind"] != "artifact" {
        bail!("archive requires artifact observation")
    }
    let snapshot = serde_json::from_value(event["evidence"]["payload"]["snapshot"].clone())?;
    Ok((event, snapshot))
}
fn receipt(db: &Connection, sequence: u64) -> Result<Value> {
    let (hash, bytes, complete): (String, usize, bool) = db.query_row(
        "SELECT hash,bytes,complete FROM artifact_archives WHERE sequence=?1",
        [sequence],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let (event, _) = source(db, sequence)?;
    Ok(
        json!({"sequence":sequence,"archive_hash":hash,"bytes":bytes,"chunk_bytes":CHUNK,"snapshot_hash":event["snapshot_hash"],"complete":complete,"completion_authorized":false}),
    )
}
impl Store {
    pub fn artifact_archive(&self, sequence: u64) -> Result<Value> {
        receipt(&self.db.lock(), sequence)
    }
    pub fn put_artifact_chunk(&self, sequence: u64, index: usize, input: Chunk) -> Result<Value> {
        let id = Identity {
            archive_hash: input.archive_hash,
            bytes: input.bytes,
        };
        let count = bounds(sequence, &id)?;
        if index >= count || input.data.len() > CHUNK.div_ceil(3) * 4 {
            bail!("archive chunk bounds")
        }
        let bytes = STANDARD.decode(&input.data)?;
        let expected = if index + 1 == count {
            id.bytes - index * CHUNK
        } else {
            CHUNK
        };
        if bytes.len() != expected || STANDARD.encode(&bytes) != input.data {
            bail!("archive chunk encoding or size mismatch")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        source(&tx, sequence)?;
        tx.execute("INSERT OR IGNORE INTO artifact_archives(sequence,hash,bytes,complete) VALUES (?1,?2,?3,0)",params![sequence,id.archive_hash,id.bytes])?;
        let saved = receipt(&tx, sequence)?;
        if saved["archive_hash"] != id.archive_hash || saved["bytes"] != id.bytes {
            bail!("archive upload identity conflict")
        }
        let prior: Option<Vec<u8>> = tx
            .query_row(
                "SELECT data FROM artifact_archive_chunks WHERE sequence=?1 AND idx=?2",
                params![sequence, index],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            if prior != bytes {
                bail!("archive chunk identity conflict")
            }
        } else {
            if saved["complete"] == true {
                bail!("completed archive cannot change")
            }
            tx.execute(
                "INSERT INTO artifact_archive_chunks(sequence,idx,data) VALUES (?1,?2,?3)",
                params![sequence, index, bytes],
            )?;
        }
        tx.commit()?;
        Ok(saved)
    }
    pub fn complete_artifact_archive(&self, sequence: u64, id: Identity) -> Result<Value> {
        let count = bounds(sequence, &id)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let saved = receipt(&tx, sequence)?;
        if saved["archive_hash"] != id.archive_hash || saved["bytes"] != id.bytes {
            bail!("archive upload identity conflict")
        }
        if saved["complete"] == true {
            return Ok(saved);
        }
        let mut data = Vec::with_capacity(id.bytes);
        let mut query = tx.prepare(
            "SELECT idx,data FROM artifact_archive_chunks WHERE sequence=?1 ORDER BY idx",
        )?;
        let rows = query.query_map([sequence], |r| {
            Ok((r.get::<_, usize>(0)?, r.get::<_, Vec<u8>>(1)?))
        })?;
        let mut chunks = 0;
        for row in rows {
            let (index, bytes) = row?;
            if index != chunks {
                bail!("archive chunks incomplete")
            }
            data.extend(bytes);
            chunks += 1;
        }
        if chunks != count || data.len() != id.bytes || digest(&data) != id.archive_hash {
            bail!("archive content incomplete or hash mismatch")
        }
        let (event, snapshot) = source(&tx, sequence)?;
        validate(&data, &snapshot)?;
        tx.execute(
            "UPDATE artifact_archives SET complete=1 WHERE sequence=?1",
            [sequence],
        )?;
        tx.execute("INSERT INTO operation_events(operation_id,body) VALUES (?1,?2)",params![event["evidence"]["operation_id"].as_str(),serde_json::to_string(&json!({"kind":"artifact_archive_completed","sequence":sequence,"archive_hash":id.archive_hash,"snapshot_hash":event["snapshot_hash"]}))?])?;
        let result = receipt(&tx, sequence)?;
        drop(query);
        tx.commit()?;
        Ok(result)
    }
    pub fn artifact_archive_chunk(&self, sequence: u64, index: usize) -> Result<Value> {
        let db = self.db.lock();
        let r = receipt(&db, sequence)?;
        if r["complete"] != true {
            bail!("artifact archive is not complete")
        }
        let data: Vec<u8> = db.query_row(
            "SELECT data FROM artifact_archive_chunks WHERE sequence=?1 AND idx=?2",
            params![sequence, index],
            |r| r.get(0),
        )?;
        Ok(
            json!({"sequence":sequence,"index":index,"archive_hash":r["archive_hash"],"data":STANDARD.encode(data)}),
        )
    }
}

// Wire segments fit inside the 64 KiB accounting envelope; storage chunks stay
// 256 KiB for compatibility. Partial chunks cannot pass archive completion.
pub(super) const SEGMENT: usize = 32 * 1024;
fn remote_source(db: &Connection, sequence: u64, operation: &str, attempt: u64) -> Result<()> {
    let (event, _) = source(db, sequence)?;
    let body: String = db.query_row(
        "SELECT body FROM operations WHERE id=?1",
        [operation],
        |r| r.get(0),
    )?;
    let op: super::operations::Operation = serde_json::from_str(&body)?;
    if event["evidence"]["operation_id"] != operation
        || event["evidence"]["attempt"] != attempt
        || op.attempt != attempt
        || event["producer"] != serde_json::to_value(op.worker)?
    {
        bail!("foreign remote archive source")
    }
    Ok(())
}
impl Store {
    pub(super) fn put_remote_artifact_segment(
        &self,
        operation: &str,
        attempt: u64,
        sequence: u64,
        index: usize,
        offset: usize,
        input: Chunk,
    ) -> Result<Value> {
        let id = Identity {
            archive_hash: input.archive_hash,
            bytes: input.bytes,
        };
        let count = bounds(sequence, &id)?;
        if index >= count
            || offset >= CHUNK
            || offset % SEGMENT != 0
            || input.data.len() > SEGMENT.div_ceil(3) * 4
        {
            bail!("archive segment bounds")
        }
        let chunk_len = (id.bytes - index * CHUNK).min(CHUNK);
        if offset >= chunk_len {
            bail!("archive segment offset exceeds chunk")
        }
        let data = STANDARD.decode(&input.data)?;
        if data.len() != (chunk_len - offset).min(SEGMENT) || STANDARD.encode(&data) != input.data {
            bail!("archive segment encoding or size mismatch")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        remote_source(&tx, sequence, operation, attempt)?;
        tx.execute("INSERT OR IGNORE INTO artifact_archives(sequence,hash,bytes,complete) VALUES (?1,?2,?3,0)", params![sequence,id.archive_hash,id.bytes])?;
        let saved = receipt(&tx, sequence)?;
        if saved["archive_hash"] != id.archive_hash || saved["bytes"] != id.bytes {
            bail!("archive upload identity conflict")
        }
        let prior: Option<Vec<u8>> = tx
            .query_row(
                "SELECT data FROM artifact_archive_chunks WHERE sequence=?1 AND idx=?2",
                params![sequence, index],
                |r| r.get(0),
            )
            .optional()?;
        let mut bytes = prior.unwrap_or_default();
        if offset < bytes.len() {
            if offset + data.len() > bytes.len() || bytes[offset..offset + data.len()] != data {
                bail!("archive segment identity conflict")
            }
        } else {
            if offset != bytes.len() || saved["complete"] == true {
                bail!("archive segment requires contiguous upload")
            }
            bytes.extend_from_slice(&data);
            tx.execute("INSERT INTO artifact_archive_chunks(sequence,idx,data) VALUES (?1,?2,?3) ON CONFLICT(sequence,idx) DO UPDATE SET data=excluded.data",params![sequence,index,bytes])?;
        }
        // Receipt describes this immutable segment, so later progress cannot change replay.
        let result = json!({"sequence":sequence,"index":index,"offset":offset,"segment_bytes":data.len(),"archive_hash":id.archive_hash,"bytes":id.bytes,"completion_authorized":false});
        tx.commit()?;
        Ok(result)
    }
    pub(super) fn complete_remote_artifact_archive(
        &self,
        operation: &str,
        attempt: u64,
        sequence: u64,
        id: Identity,
    ) -> Result<Value> {
        remote_source(&self.db.lock(), sequence, operation, attempt)?;
        self.complete_artifact_archive(sequence, id)
    }
}

impl Store {
    /// Read only an artifact frozen into the consumer Assignment, not arbitrary home bytes.
    pub(super) fn assignment_artifact_segment(
        &self,
        assignment: &Value,
        sequence: u64,
        offset: Option<usize>,
    ) -> Result<Value> {
        if assignment["state"] != "prepared" {
            bail!("Assignment archive requires prepared consumer")
        }
        let source = assignment["inputs"]["binding"]["sources"]
            .as_object()
            .and_then(|sources| {
                sources.values().find_map(|source| {
                    source["outputs"].as_object().and_then(|outputs| {
                        outputs.values().find(|output| {
                            output["sequence"] == sequence && output["artifact"].is_object()
                        })
                    })
                })
            })
            .ok_or_else(|| anyhow::anyhow!("archive is not a frozen Assignment input"))?;
        let db = self.db.lock();
        let metadata = receipt(&db, sequence)?;
        let artifact = &source["artifact"];
        if metadata["complete"] != true
            || metadata["snapshot_hash"] != artifact["snapshot_hash"]
            || metadata["archive_hash"] != artifact["archive_hash"]
            || metadata["bytes"] != artifact["bytes"]
        {
            bail!("Assignment archive identity mismatch")
        }
        let Some(offset) = offset else {
            return Ok(metadata);
        };
        let bytes = metadata["bytes"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("archive length missing"))? as usize;
        if offset >= bytes || offset % SEGMENT != 0 {
            bail!("Assignment archive segment offset")
        }
        let chunk: Vec<u8> = db.query_row(
            "SELECT data FROM artifact_archive_chunks WHERE sequence=?1 AND idx=?2",
            params![sequence, offset / CHUNK],
            |r| r.get(0),
        )?;
        let start = offset % CHUNK;
        let length = SEGMENT.min(bytes - offset);
        let data = chunk
            .get(start..start + length)
            .ok_or_else(|| anyhow::anyhow!("archive chunk incomplete"))?;
        Ok(
            json!({"sequence":sequence,"offset":offset,"archive_hash":metadata["archive_hash"],"data":STANDARD.encode(data)}),
        )
    }
}
