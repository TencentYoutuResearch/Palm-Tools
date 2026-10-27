//! SQLite is authoritative; network sends and process submission never own durability.
use super::model::*;
use anyhow::{bail, Context, Result};
use fs2::FileExt;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs::{self, File},
    path::Path,
};

pub struct Store {
    db: Mutex<Connection>,
    pub node_id: String,
    _lock: Option<File>,
}
impl Store {
    pub fn document(&self, key: &str) -> Result<serde_json::Value> {
        let row: Option<(u64, String)> = self.db.lock().query_row(
            "SELECT revision,value FROM workbench_documents WHERE key=?1", [key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        match row {
            Some((revision, value)) => Ok(serde_json::json!({"revision":revision,"value":serde_json::from_str::<serde_json::Value>(&value)?})),
            None => Ok(serde_json::json!({"revision":0,"value":null})),
        }
    }
    pub fn save_document(&self, key: &str, expected: u64, value: serde_json::Value) -> Result<serde_json::Value> {
        let mut db = self.db.lock();
        let transaction = db.transaction()?;
        let current: u64 = transaction.query_row("SELECT revision FROM workbench_documents WHERE key=?1", [key], |row| row.get(0)).optional()?.unwrap_or(0);
        if current != expected { bail!("configuration changed; reload before saving") }
        let revision = current + 1;
        transaction.execute("INSERT INTO workbench_documents VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value", params![key, revision, serde_json::to_string(&value)?])?;
        transaction.commit()?;
        Ok(serde_json::json!({"revision":revision,"value":value}))
    }
    pub fn open(path: &Path, node_id: &str) -> Result<Self> {
        if !valid_id(node_id) {
            bail!("invalid node_id")
        }
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let lock = File::options()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path.with_extension("lock"))?;
        lock.try_lock_exclusive()
            .context("messaging store already owned by another bridge")?;
        let db = Connection::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Self::init(db, node_id, Some(lock))
    }
    fn init(db: Connection, node_id: &str, lock: Option<File>) -> Result<Self> {
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS identity (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, info TEXT NOT NULL, token TEXT NOT NULL, seen INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, source_node TEXT NOT NULL, source_session TEXT NOT NULL, target_node TEXT NOT NULL, target_session TEXT NOT NULL, idem TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(source_node,source_session,idem));
          CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS message_target ON messages(target_node,target_session);
          CREATE TABLE IF NOT EXISTS workbench_documents (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);")?;
        db.execute(
            "INSERT OR IGNORE INTO identity VALUES ('node_id',?1)",
            [node_id],
        )?;
        let stored: String =
            db.query_row("SELECT value FROM identity WHERE key='node_id'", [], |r| {
                r.get(0)
            })?;
        if stored != node_id {
            bail!("database belongs to a different node")
        }
        // Process loss after submission is ambiguous: never replay into an external runtime.
        let store = Self {
            db: Mutex::new(db),
            node_id: node_id.into(),
            _lock: lock,
        };
        for mut m in store.messages()? {
            if m.target.node_id == node_id && m.status == Status::Delivering {
                m.status = Status::Uncertain;
                m.detail = Some("bridge restarted during runtime submission".into());
                store.save(&m)?;
            }
        }
        store.db.lock().execute("UPDATE sessions SET seen=0", [])?;
        Ok(store)
    }
    pub fn register(&self, req: RegisterRequest) -> Result<Registration> {
        if !valid_id(&req.session_id) || req.title.len() > 512 || req.runtime.len() > 64 {
            bail!("invalid session metadata")
        }
        let db = self.db.lock();
        let previous: Option<(String, u64)> = db
            .query_row(
                "SELECT token,seen FROM sessions WHERE id=?1",
                [&req.session_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let token = match previous {
            Some((token, seen)) => {
                if req.owner_token.as_deref() != Some(&token)
                    && now().saturating_sub(seen) < LEASE_MS
                {
                    bail!("session already has an owner; supply its owner_token")
                }
                if req.runtime == "kode" {
                    token
                } else {
                    uuid::Uuid::new_v4().to_string()
                }
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        let info = SessionInfo {
            address: Address {
                node_id: self.node_id.clone(),
                session_id: req.session_id,
            },
            title: req.title,
            runtime: req.runtime,
            online: true,
            updated_at: now(),
        };
        db.execute("INSERT INTO sessions VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET info=excluded.info,token=excluded.token,seen=excluded.seen", params![info.address.session_id, serde_json::to_string(&info)?, token, now()])?;
        Ok(Registration {
            session: info,
            owner_token: token,
        })
    }
    pub fn principal(&self, token: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .lock()
            .query_row("SELECT id FROM sessions WHERE token=?1", [token], |r| {
                r.get(0)
            })
            .optional()?)
    }
    pub(super) fn db_token(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .lock()
            .query_row("SELECT token FROM sessions WHERE id=?1", [id], |r| r.get(0))
            .optional()?)
    }
    /// Metadata refresh must not rotate the owner token or disturb claimed messages.
    pub fn update_title(&self, id: &str, title: &str) -> Result<()> {
        if title.trim().is_empty() || title.len() > 512 {
            bail!("invalid session title");
        }
        let db = self.db.lock();
        let text: String =
            db.query_row("SELECT info FROM sessions WHERE id=?1", [id], |r| r.get(0))?;
        let mut info: SessionInfo = serde_json::from_str(&text)?;
        info.title = title.into();
        info.updated_at = now();
        db.execute(
            "UPDATE sessions SET info=?2 WHERE id=?1",
            params![id, serde_json::to_string(&info)?],
        )?;
        Ok(())
    }
    pub fn heartbeat(&self, id: &str) -> Result<()> {
        let count = self.db.lock().execute(
            "UPDATE sessions SET seen=?2 WHERE id=?1",
            params![id, now()],
        )?;
        if count == 0 {
            bail!("unknown session")
        }
        Ok(())
    }
    pub fn offline(&self, id: &str) -> Result<()> {
        self.db
            .lock()
            .execute("UPDATE sessions SET seen=0 WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn sessions(&self) -> Result<Vec<SessionInfo>> {
        let db = self.db.lock();
        let mut q = db.prepare("SELECT info,seen FROM sessions ORDER BY id")?;
        let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)))?;
        rows.map(|row| {
            let (text, seen) = row?;
            let mut s: SessionInfo = serde_json::from_str(&text)?;
            s.online = now().saturating_sub(seen) < LEASE_MS;
            Ok(s)
        })
        .collect()
    }
    pub fn messages(&self) -> Result<Vec<Message>> {
        let db = self.db.lock();
        let mut q = db.prepare("SELECT body FROM messages ORDER BY rowid")?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn get(&self, id: &str) -> Result<Option<Message>> {
        let body: Option<String> = self
            .db
            .lock()
            .query_row("SELECT body FROM messages WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        body.map(|b| Ok(serde_json::from_str(&b)?)).transpose()
    }
    /// Insert or deduplicate under one database lock. Changed payloads never reuse an id/key.
    pub fn insert(&self, m: Message) -> Result<Message> {
        let mut db = self.db.lock();
        let previous: Option<String> = db.query_row("SELECT body FROM messages WHERE id=?1 OR (source_node=?2 AND source_session=?3 AND idem=?4)", params![m.id,m.source.node_id,m.source.session_id,m.idempotency_key], |r| r.get(0)).optional()?;
        if let Some(body) = previous {
            let p: Message = serde_json::from_str(&body)?;
            if p.source != m.source
                || p.target != m.target
                || p.content != m.content
                || p.idempotency_key != m.idempotency_key
                || p.in_reply_to != m.in_reply_to
                || p.hop_count != m.hop_count
                || p.expires_at.saturating_sub(p.created_at)
                    != m.expires_at.saturating_sub(m.created_at)
            {
                bail!("idempotency conflict")
            }
            return Ok(p);
        }
        let pending: usize = db.query_row("SELECT count(*) FROM messages WHERE target_node=?1 AND target_session=?2 AND json_extract(body,'$.status') IN ('queued','received','delivering')", params![m.target.node_id,m.target.session_id], |r| r.get(0))?;
        if pending >= MAX_PENDING {
            bail!("target inbox is full")
        }
        let text = serde_json::to_string(&m)?;
        let tx = db.transaction()?;
        tx.execute(
            "INSERT INTO messages VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                m.id,
                m.source.node_id,
                m.source.session_id,
                m.target.node_id,
                m.target.session_id,
                m.idempotency_key,
                text
            ],
        )?;
        tx.execute("INSERT INTO events(message) VALUES (?1)", [&text])?;
        tx.commit()?;
        Ok(m)
    }
    pub fn save(&self, m: &Message) -> Result<()> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let text = serde_json::to_string(m)?;
        if tx.execute(
            "UPDATE messages SET body=?2 WHERE id=?1",
            params![m.id, text],
        )? != 1
        {
            bail!("unknown message")
        }
        tx.execute("INSERT INTO events(message) VALUES (?1)", [&text])?;
        tx.commit()?;
        Ok(())
    }
    /// Read-only wakeup probe; unlike claim this never renews ownership or consumes work.
    pub fn pending_count(&self, session: &str) -> Result<u64> {
        Ok(self.db.lock().query_row(
            "SELECT COUNT(*) FROM messages WHERE target_node=?1 AND target_session=?2 AND json_extract(body,'$.status')='received' AND json_extract(body,'$.expires_at')>?3",
            params![self.node_id, session, now()],
            |r| r.get(0),
        )?)
    }
    pub fn events(&self, after: u64, session: Option<&str>) -> Result<Vec<Event>> {
        let db = self.db.lock();
        let mut q = db.prepare("SELECT seq,message FROM events WHERE seq>?1 AND (?2 IS NULL OR (json_extract(message,'$.source.node_id')=?3 AND json_extract(message,'$.source.session_id')=?2) OR (json_extract(message,'$.target.node_id')=?3 AND json_extract(message,'$.target.session_id')=?2)) ORDER BY seq LIMIT 200")?;
        let rows = q.query_map(params![after, session, self.node_id], |r| {
            Ok((r.get(0)?, r.get::<_, String>(1)?))
        })?;
        rows.map(|r| {
            let (seq, text) = r?;
            Ok(Event {
                seq,
                message: serde_json::from_str(&text)?,
            })
        })
        .collect()
    }
}
