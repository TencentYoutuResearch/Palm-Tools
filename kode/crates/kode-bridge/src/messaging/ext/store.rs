//! Extension grants, session ownership, idempotent requests and the derived
//! event log. A separate database from messaging: extension traffic never
//! waits on the delivery store's lock.
use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Derived events kept for replay; older rows are pruned on insert.
const EVENT_RETENTION: u64 = 100_000;

pub struct Store {
    db: Mutex<Connection>,
}

pub struct Grant {
    pub extension: String,
    pub capabilities: Vec<String>,
}

pub struct Owned {
    pub extension: String,
    pub labels: Vec<String>,
    pub meta: Value,
    pub parent: Option<u64>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Event {
    pub seq: u64,
    pub session_id: u64,
    pub kind: String,
    pub payload: Value,
    pub ts: u64,
}

pub fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        Self::init(db)
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn init(db: Connection) -> Result<Self> {
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        // Grants are re-minted on every extension start and events derive
        // from the durable runtime log, so NORMAL durability is enough.
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS ext_grants(token_hash TEXT PRIMARY KEY, extension TEXT NOT NULL, capabilities TEXT NOT NULL, created INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS ext_grants_extension ON ext_grants(extension);
            CREATE TABLE IF NOT EXISTS ext_sessions(session_id INTEGER PRIMARY KEY, extension TEXT NOT NULL, labels TEXT NOT NULL, meta TEXT NOT NULL, parent INTEGER, created INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS ext_sessions_extension ON ext_sessions(extension);
            CREATE TABLE IF NOT EXISTS ext_requests(extension TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT, PRIMARY KEY(extension,key));
            CREATE TABLE IF NOT EXISTS ext_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS ext_events_session ON ext_events(session_id, seq);
            CREATE TABLE IF NOT EXISTS ext_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self { db: Mutex::new(db) })
    }

    /// Replace every token of `extension` with one new token.
    pub fn grant(&self, extension: &str, capabilities: &[String]) -> Result<String> {
        let token = format!(
            "kext_{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM ext_grants WHERE extension=?1", [extension])?;
        tx.execute(
            "INSERT INTO ext_grants VALUES(?1,?2,?3,?4)",
            params![
                digest(&token),
                extension,
                serde_json::to_string(capabilities)?,
                crate::now_ms()
            ],
        )?;
        tx.commit()?;
        Ok(token)
    }

    pub fn revoke(&self, extension: &str) -> Result<()> {
        self.db
            .lock()
            .execute("DELETE FROM ext_grants WHERE extension=?1", [extension])?;
        Ok(())
    }

    pub fn principal(&self, token: &str) -> Result<Option<Grant>> {
        if !token.starts_with("kext_") {
            return Ok(None);
        }
        let row: Option<(String, String)> = self
            .db
            .lock()
            .query_row(
                "SELECT extension,capabilities FROM ext_grants WHERE token_hash=?1",
                [digest(token)],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(extension, capabilities)| {
            Ok(Grant {
                extension,
                capabilities: serde_json::from_str(&capabilities)?,
            })
        })
        .transpose()
    }

    pub fn own(&self, id: u64, owner: &Owned) -> Result<()> {
        self.db.lock().execute(
            "INSERT INTO ext_sessions VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(session_id) DO NOTHING",
            params![
                id,
                owner.extension,
                serde_json::to_string(&owner.labels)?,
                serde_json::to_string(&owner.meta)?,
                owner.parent,
                crate::now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn owner(&self, id: u64) -> Result<Option<Owned>> {
        let row: Option<(String, String, String, Option<u64>)> = self
            .db
            .lock()
            .query_row(
                "SELECT extension,labels,meta,parent FROM ext_sessions WHERE session_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        row.map(|(extension, labels, meta, parent)| {
            Ok(Owned {
                extension,
                labels: serde_json::from_str(&labels)?,
                meta: serde_json::from_str(&meta)?,
                parent,
            })
        })
        .transpose()
    }

    pub fn update_meta(
        &self,
        id: u64,
        labels: Option<&[String]>,
        meta: Option<&Value>,
    ) -> Result<()> {
        let db = self.db.lock();
        if let Some(labels) = labels {
            db.execute(
                "UPDATE ext_sessions SET labels=?2 WHERE session_id=?1",
                params![id, serde_json::to_string(labels)?],
            )?;
        }
        if let Some(meta) = meta {
            db.execute(
                "UPDATE ext_sessions SET meta=?2 WHERE session_id=?1",
                params![id, serde_json::to_string(meta)?],
            )?;
        }
        Ok(())
    }

    pub fn owned_by(&self, extension: &str) -> Result<Vec<(u64, Owned)>> {
        let db = self.db.lock();
        let mut stmt = db.prepare(
            "SELECT session_id,labels,meta,parent FROM ext_sessions WHERE extension=?1 ORDER BY session_id",
        )?;
        let rows = stmt.query_map([extension], |r| {
            Ok((
                r.get::<_, u64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<u64>>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (id, labels, meta, parent) = row?;
            Ok((
                id,
                Owned {
                    extension: extension.into(),
                    labels: serde_json::from_str(&labels)?,
                    meta: serde_json::from_str(&meta)?,
                    parent,
                },
            ))
        })
        .collect()
    }

    /// Prior outcome of `key`: `Ok(Some(result))` when settled, `Ok(None)` when
    /// new or still in flight with the same body; an error when the key was
    /// used for a different request.
    pub fn begin_request(
        &self,
        extension: &str,
        key: &str,
        fingerprint: &str,
    ) -> Result<Option<Value>> {
        let db = self.db.lock();
        let prior: Option<(String, Option<String>)> = db
            .query_row(
                "SELECT fingerprint,result FROM ext_requests WHERE extension=?1 AND key=?2",
                params![extension, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match prior {
            Some((prior, _)) if prior != fingerprint => {
                bail!("idempotency_key was already used for a different request")
            }
            Some((_, Some(result))) => Ok(Some(serde_json::from_str(&result)?)),
            Some((_, None)) => Ok(None),
            None => {
                db.execute(
                    "INSERT INTO ext_requests VALUES(?1,?2,?3,NULL)",
                    params![extension, key, fingerprint],
                )?;
                Ok(None)
            }
        }
    }

    pub fn finish_request(&self, extension: &str, key: &str, result: &Value) -> Result<()> {
        self.db.lock().execute(
            "UPDATE ext_requests SET result=?3 WHERE extension=?1 AND key=?2",
            params![extension, key, serde_json::to_string(result)?],
        )?;
        Ok(())
    }

    pub fn append(&self, session_id: u64, kind: &str, payload: &Value) -> Result<Event> {
        let ts = crate::now_ms();
        let db = self.db.lock();
        db.execute(
            "INSERT INTO ext_events(session_id,kind,payload,ts) VALUES(?1,?2,?3,?4)",
            params![session_id, kind, serde_json::to_string(payload)?, ts],
        )?;
        let seq = db.last_insert_rowid() as u64;
        if seq % 1000 == 0 && seq > EVENT_RETENTION {
            db.execute(
                "DELETE FROM ext_events WHERE seq<=?1",
                [seq - EVENT_RETENTION],
            )?;
        }
        Ok(Event {
            seq,
            session_id,
            kind: kind.into(),
            payload: payload.clone(),
            ts,
        })
    }

    pub fn latest_seq(&self) -> u64 {
        self.db
            .lock()
            .query_row("SELECT COALESCE(MAX(seq),0) FROM ext_events", [], |r| {
                r.get(0)
            })
            .unwrap_or(0)
    }

    /// Events after `after`, optionally limited to sessions owned by `owner`.
    pub fn events(
        &self,
        after: u64,
        owner: Option<&str>,
        session: Option<u64>,
        limit: usize,
    ) -> Result<Vec<Event>> {
        let db = self.db.lock();
        let mut stmt = db.prepare(
            "SELECT e.seq,e.session_id,e.kind,e.payload,e.ts FROM ext_events e
             WHERE e.seq>?1
               AND (?2 IS NULL OR e.session_id IN (SELECT session_id FROM ext_sessions WHERE extension=?2))
               AND (?3 IS NULL OR e.session_id=?3)
             ORDER BY e.seq LIMIT ?4",
        )?;
        let rows = stmt.query_map(params![after, owner, session, limit.min(1000)], |r| {
            Ok((
                r.get::<_, u64>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, u64>(4)?,
            ))
        })?;
        rows.map(|row| {
            let (seq, session_id, kind, payload, ts) = row?;
            Ok(Event {
                seq,
                session_id,
                kind,
                payload: serde_json::from_str(&payload)?,
                ts,
            })
        })
        .collect()
    }

    pub fn state(&self, key: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .db
            .lock()
            .query_row("SELECT value FROM ext_state WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).context("corrupt extension state"))
            .transpose()
    }

    pub fn states_with_prefix(&self, prefix: &str) -> Result<Vec<(String, Value)>> {
        let db = self.db.lock();
        let mut stmt = db.prepare("SELECT key,value FROM ext_state WHERE substr(key,1,length(?1))=?1")?;
        let rows = stmt.query_map([prefix], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.map(|row| {
            let (key, raw) = row?;
            Ok((key, serde_json::from_str(&raw)?))
        })
        .collect()
    }

    pub fn set_state(&self, key: &str, value: &Value) -> Result<()> {
        self.db.lock().execute(
            "INSERT INTO ext_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }
}

impl Owned {
    pub fn describe(&self) -> Value {
        json!({"owner":self.extension,"labels":self.labels,"meta":self.meta,"parent":self.parent})
    }
}
