//! Scope-neutral owner-admin Host enrollment. This records trust in controlled Host
//! code, not hardware attestation, new credentials, or permission to execute work.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) const PROTOCOL: u64 = 1;
pub(super) const CHALLENGE_TTL_MS: u64 = 30_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Challenge {
    pub request_id: String,
    pub host_id: String,
    pub boot_id: String,
    pub protocol_version: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Register {
    pub request_id: String,
    pub challenge_id: String,
    pub nonce: String,
    pub host_id: String,
    pub boot_id: String,
    pub protocol_version: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Revoke {
    pub request_id: String,
    pub enrollment_id: String,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeRecord {
    home: String,
    id: String,
    nonce: String,
    request: Challenge,
    expires_at: u64,
    consumed_by: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Enrollment {
    pub id: String,
    pub home: String,
    pub host_id: String,
    pub boot_id: String,
    pub protocol_version: u64,
    pub revision: u64,
    pub revoked: bool,
}
fn key(kind: &str, home: &str, id: &str) -> String {
    format!("runtime-host-enrollment-v1:{kind}:{}", json!([home, id]))
}
fn read<T: serde::de::DeserializeOwned>(db: &Connection, key: &str) -> Result<Option<T>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM workbench_documents WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn require<T: serde::de::DeserializeOwned>(db: &Connection, key: &str) -> Result<T> {
    read(db, key)?.ok_or_else(|| anyhow::anyhow!("Host enrollment record missing"))
}
fn insert(db: &Connection, key: &str, value: &impl Serialize) -> Result<()> {
    db.execute(
        "INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2)",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}
fn valid(ids: &[&str], protocol: u64) -> Result<()> {
    if !ids.iter().all(|id| valid_id(id)) || protocol != PROTOCOL {
        bail!("invalid Host enrollment identity or unsupported protocol")
    }
    Ok(())
}
fn view(row: &Enrollment, replay: bool) -> Value {
    json!({"enrollment":row,"status":if row.revoked {"revoked"}else{"active"},"receipt_replay":replay,"trust_basis":"owner_admin_controlled_host",
        "runtime_authorized":false,"runtime_ready":false})
}

/// Current owner-admin enrollment identity only, never scope/worker attestation.
/// Read within the caller's transaction so revoke/boot replacement cannot race.
pub(super) fn require_current_in(
    db: &Connection, home: &str, id: &str, host: &str, boot: &str,
) -> Result<Enrollment> {
    valid(&[home,id,host,boot],PROTOCOL)?;
    let row: Enrollment=require(db,&key("enrollment",home,id))?;
    let current: Enrollment=require(db,&key("host",home,host))?;
    if row != current || row.home!=home || row.id!=id || row.host_id!=host
        || row.boot_id!=boot || row.protocol_version!=PROTOCOL || row.revoked
        || row.revision!=1 {
        bail!("Host enrollment revoked, replaced or identity mismatch")
    }
    Ok(row)
}

pub(super) fn current_for_host_in(db: &Connection, home: &str, id: &str, host: &str) -> Result<Enrollment> {
    let row: Enrollment=require(db,&key("enrollment",home,id))?;
    require_current_in(db,home,id,host,&row.boot_id)
}

impl Store {
    /// Exact owner-only status; neither reads nor receipt replay grant execution.
    pub(super) fn runtime_host_status(&self, enrollment_id: &str) -> Result<Value> {
        valid(&[enrollment_id], PROTOCOL)?;
        let db = self.db.lock();
        match read::<Enrollment>(&db, &key("enrollment", &self.node_id, enrollment_id))? {
            Some(row) if row.id == enrollment_id && row.home == self.node_id => {
                Ok(view(&row, false))
            }
            Some(_) => bail!("Host enrollment status identity mismatch"),
            None => {
                Ok(json!({"status":"not_found","runtime_authorized":false,"runtime_ready":false}))
            }
        }
    }
    pub(super) fn runtime_host_register_status(&self, request_id: &str) -> Result<Value> {
        valid(&[request_id], PROTOCOL)?;
        let db = self.db.lock();
        let Some(receipt) =
            read::<Value>(&db, &key("register-request", &self.node_id, request_id))?
        else {
            return Ok(
                json!({"status":"not_found","runtime_authorized":false,"runtime_ready":false}),
            );
        };
        let request: Register = serde_json::from_value(receipt["request"].clone())?;
        let id = receipt["enrollment_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("invalid Host receipt"))?;
        let row: Enrollment = require(&db, &key("enrollment", &self.node_id, id))?;
        if request.request_id != request_id
            || row.id != id
            || row.home != self.node_id
            || row.host_id != request.host_id
            || row.boot_id != request.boot_id
            || row.protocol_version != request.protocol_version
        {
            bail!("Host register receipt identity mismatch")
        }
        Ok(view(&row, true))
    }
    /// Owner/admin only at the transport boundary. Nonce is a one-use challenge,
    /// never accepted instead of the existing owner/admin authentication.
    pub(super) fn challenge_runtime_host(&self, input: Challenge) -> Result<Value> {
        valid(
            &[&input.request_id, &input.host_id, &input.boot_id],
            input.protocol_version,
        )?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let request_key = key("challenge-request", &self.node_id, &input.request_id);
        if let Some(old) = read::<ChallengeRecord>(&tx, &request_key)? {
            if old.request != input {
                bail!("Host challenge request conflict")
            }
            let current: ChallengeRecord = require(&tx, &key("challenge", &self.node_id, &old.id))?;
            if current.consumed_by.is_some() || now() >= current.expires_at {
                bail!("Host challenge consumed or expired")
            }
            return Ok(
                json!({"challenge_id":old.id,"nonce":old.nonce,"expires_at":old.expires_at,
                    "home":old.home,"host_id":old.request.host_id,"boot_id":old.request.boot_id,
                    "protocol_version":old.request.protocol_version,"runtime_authorized":false}),
            );
        }
        let record = ChallengeRecord {
            home: self.node_id.clone(),
            id: uuid::Uuid::new_v4().to_string(),
            nonce: uuid::Uuid::new_v4().to_string(),
            request: input,
            expires_at: now()
                .checked_add(CHALLENGE_TTL_MS)
                .ok_or_else(|| anyhow::anyhow!("challenge expiry overflow"))?,
            consumed_by: None,
        };
        insert(&tx, &request_key, &record)?;
        insert(&tx, &key("challenge", &self.node_id, &record.id), &record)?;
        tx.commit()?;
        Ok(
            json!({"challenge_id":record.id,"nonce":record.nonce,"expires_at":record.expires_at,
                "home":record.home,"host_id":record.request.host_id,"boot_id":record.request.boot_id,
                "protocol_version":record.request.protocol_version,"runtime_authorized":false}),
        )
    }

    pub(super) fn register_runtime_host(&self, input: Register) -> Result<Value> {
        valid(
            &[
                &input.request_id,
                &input.challenge_id,
                &input.nonce,
                &input.host_id,
                &input.boot_id,
            ],
            input.protocol_version,
        )?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let request_key = key("register-request", &self.node_id, &input.request_id);
        if let Some(old) = read::<Value>(&tx, &request_key)? {
            if old["request"] != serde_json::to_value(&input)? {
                bail!("Host register request conflict")
            }
            let id = old["enrollment_id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid Host receipt"))?;
            let row: Enrollment = require(&tx, &key("enrollment", &self.node_id, id))?;
            if row.id != id
                || row.home != self.node_id
                || row.host_id != input.host_id
                || row.boot_id != input.boot_id
                || row.protocol_version != input.protocol_version
            {
                bail!("Host register receipt identity mismatch")
            }
            // Return current revoked status, never resurrect an old receipt.
            return Ok(view(&row, true));
        }
        let challenge_key = key("challenge", &self.node_id, &input.challenge_id);
        let mut challenge: ChallengeRecord = require(&tx, &challenge_key)?;
        if challenge.home != self.node_id
            || challenge.id != input.challenge_id
            || challenge.nonce != input.nonce
            || challenge.request.host_id != input.host_id
            || challenge.request.boot_id != input.boot_id
            || challenge.request.protocol_version != input.protocol_version
            || challenge.consumed_by.is_some()
            || now() >= challenge.expires_at
        {
            bail!("Host challenge expired, consumed or identity mismatch")
        }
        let host_key = key("host", &self.node_id, &input.host_id);
        if let Some(old) = read::<Enrollment>(&tx, &host_key)? {
            if !old.revoked {
                bail!("Host already enrolled; revoke before replacing boot")
            }
            if old.boot_id == input.boot_id {
                bail!("revoked Host boot cannot be re-enrolled")
            }
        }
        // Permanent tombstone prevents returning to any earlier revoked boot.
        let boot_key = key(
            "boot",
            &self.node_id,
            &json!([input.host_id, input.boot_id]).to_string(),
        );
        if read::<Value>(&tx, &boot_key)?.is_some() {
            bail!("Host boot already enrolled")
        }
        let row = Enrollment {
            id: uuid::Uuid::new_v4().to_string(),
            home: self.node_id.clone(),
            host_id: input.host_id.clone(),
            boot_id: input.boot_id.clone(),
            protocol_version: input.protocol_version,
            revision: 1,
            revoked: false,
        };
        insert(&tx, &key("enrollment", &self.node_id, &row.id), &row)?;
        insert(&tx, &boot_key, &json!({"enrollment_id":row.id}))?;
        tx.execute("INSERT INTO workbench_documents(key,revision,value) VALUES (?1,1,?2) ON CONFLICT(key) DO UPDATE SET revision=revision+1,value=excluded.value",params![host_key,serde_json::to_string(&row)?])?;
        challenge.consumed_by = Some(input.request_id.clone());
        tx.execute(
            "UPDATE workbench_documents SET revision=revision+1,value=?1 WHERE key=?2",
            params![serde_json::to_string(&challenge)?, challenge_key],
        )?;
        insert(
            &tx,
            &request_key,
            &json!({"request":input,"enrollment_id":row.id}),
        )?;
        tx.commit()?;
        Ok(view(&row, false))
    }

    pub(super) fn revoke_runtime_host(&self, input: Revoke) -> Result<Value> {
        valid(&[&input.request_id, &input.enrollment_id], PROTOCOL)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let request_key = key("revoke-request", &self.node_id, &input.request_id);
        let enrollment_key = key("enrollment", &self.node_id, &input.enrollment_id);
        let mut row: Enrollment = require(&tx, &enrollment_key)?;
        if let Some(old) = read::<Revoke>(&tx, &request_key)? {
            if old != input {
                bail!("Host revoke request conflict")
            }
            return Ok(view(&row, true));
        }
        if row.home != self.node_id
            || row.id != input.enrollment_id
            || row.revoked
            || row.revision != input.expected_revision
        {
            bail!("Host revoke revision or identity conflict")
        }
        let host_key = key("host", &self.node_id, &row.host_id);
        let current: Enrollment = require(&tx, &host_key)?;
        if current != row {
            bail!("Host enrollment fence changed")
        }
        row.revoked = true;
        row.revision += 1;
        if tx.execute(
            "UPDATE workbench_documents SET revision=?1,value=?2 WHERE key=?3 AND revision=?4",
            params![
                row.revision,
                serde_json::to_string(&row)?,
                enrollment_key,
                input.expected_revision
            ],
        )? != 1
        {
            bail!("Host revoke CAS conflict")
        }
        tx.execute(
            "UPDATE workbench_documents SET revision=revision+1,value=?1 WHERE key=?2",
            params![serde_json::to_string(&row)?, host_key],
        )?;
        insert(&tx, &request_key, &input)?;
        tx.commit()?;
        Ok(view(&row, false))
    }
}
