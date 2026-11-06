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

// UNION preserves both directions, including terminal receipts, and deduplicates
// self-addressed events. Each branch seeks its participant+cursor index.
const SESSION_EVENTS: &str = "SELECT seq,message FROM events WHERE json_extract(message,'$.source.node_id')=?3 AND json_extract(message,'$.source.session_id')=?2 AND seq>?1
    UNION SELECT seq,message FROM events WHERE json_extract(message,'$.target.node_id')=?3 AND json_extract(message,'$.target.session_id')=?2 AND seq>?1 ORDER BY seq LIMIT 200";

pub struct Store {
    pub(super) db: Mutex<Connection>,
    pub node_id: String,
    _lock: Option<File>,
}
impl Store {
    pub fn document(&self, key: &str) -> Result<serde_json::Value> {
        let row: Option<(u64, String)> = self
            .db
            .lock()
            .query_row(
                "SELECT revision,value FROM workbench_documents WHERE key=?1",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match row {
            Some((revision, value)) => Ok(
                serde_json::json!({"revision":revision,"value":serde_json::from_str::<serde_json::Value>(&value)?}),
            ),
            None => Ok(serde_json::json!({"revision":0,"value":null})),
        }
    }
    pub fn save_document(
        &self,
        key: &str,
        expected: u64,
        value: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let mut db = self.db.lock();
        let transaction = db.transaction()?;
        let current: u64 = transaction
            .query_row(
                "SELECT revision FROM workbench_documents WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        if current != expected {
            bail!("configuration changed; reload before saving")
        }
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
        let version = super::migrations::preflight(&db, node_id)?;
        super::migrations::backup_before_upgrade(&db, path, version)?;
        Self::init(db, node_id, Some(lock))
    }
    fn init(db: Connection, node_id: &str, lock: Option<File>) -> Result<Self> {
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        super::migrations::preflight(&db, node_id)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        super::migrations::migrate(&db, node_id)?;
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
        for mut m in store.open_messages()? {
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
    /// Only live delivery states belong in runtime polling, never archived terminal rows.
    pub fn open_messages(&self) -> Result<Vec<Message>> {
        let db = self.db.lock();
        let mut q = db.prepare("SELECT body FROM messages WHERE json_extract(body,'$.status') IN ('queued','received','delivering') ORDER BY rowid")?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn inbox(&self, session: &str) -> Result<Vec<Message>> {
        let db = self.db.lock();
        let mut q = db.prepare("SELECT body FROM messages WHERE target_node=?1 AND target_session=?2 AND json_extract(body,'$.status')='received' ORDER BY rowid")?;
        let rows = q.query_map(params![self.node_id, session], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    /// Incoming terminal rows remain eligible for receipt replay after every reconnect.
    /// Do not replace this with open_messages: the sender may have missed the final receipt.
    pub fn peer_messages(&self, peer: &str) -> Result<Vec<Message>> {
        let db = self.db.lock();
        let mut q = db.prepare("SELECT body FROM messages WHERE (source_node=?1 AND target_node=?2 AND json_extract(body,'$.status') IN ('queued','received','delivering')) OR (source_node=?2 AND target_node=?1) ORDER BY rowid")?;
        let rows = q.query_map(params![self.node_id, peer], |r| r.get::<_, String>(0))?;
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
        let tx = db.transaction()?;
        let result = Self::insert_in(&tx, m)?;
        tx.commit()?;
        Ok(result)
    }
    pub(super) fn insert_in(db: &Connection, m: Message) -> Result<Message> {
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
        db.execute(
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
        db.execute("INSERT INTO events(message) VALUES (?1)", [&text])?;
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
            "SELECT COUNT(*) FROM messages m WHERE target_node=?1 AND target_session=?2 AND (
                (json_extract(m.body,'$.status')='received' AND json_extract(m.body,'$.expires_at')>?3)
                OR EXISTS (SELECT 1 FROM runtime_deliveries d WHERE d.message_id=m.id AND d.session=?2 AND d.phase<2
                    AND NOT EXISTS (SELECT 1 FROM input_cancellations c WHERE c.message_id=m.id))
                OR EXISTS (SELECT 1 FROM input_cancellations c WHERE c.message_id=m.id AND c.session=?2 AND c.pending=1)
            )",
            params![self.node_id, session, now()],
            |r| r.get(0),
        )?)
    }
    pub fn events(&self, after: u64, session: Option<&str>) -> Result<Vec<Event>> {
        let db = self.db.lock();
        let mut q = db.prepare(if session.is_some() {
            SESSION_EVENTS
        } else {
            "SELECT seq,message FROM events WHERE seq>?1 ORDER BY seq LIMIT 200"
        })?;
        let mut rows = if let Some(session) = session {
            q.query(params![after, session, self.node_id])?
        } else {
            q.query([after])?
        };
        let mut events = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let (seq, text): (u64, String) = (row.get(0)?, row.get(1)?);
            // Keep full v1 DTOs, but cap aggregate bytes. A first event is always
            // returned so a large valid message cannot permanently stall cursors.
            if !events.is_empty() && bytes + text.len() > 256 * 1024 {
                break;
            }
            bytes += text.len();
            events.push(Event {
                seq,
                message: serde_json::from_str(&text)?,
            });
        }
        Ok(events)
    }
}

#[cfg(test)]
mod query_tests {
    use super::*;

    fn message(id: &str, source: &str, target: &str, session: &str, status: Status) -> Message {
        Message {
            id: id.into(),
            source: Address {
                node_id: source.into(),
                session_id: "sender".into(),
            },
            target: Address {
                node_id: target.into(),
                session_id: session.into(),
            },
            content: "fixture".into(),
            idempotency_key: id.into(),
            in_reply_to: None,
            hop_count: 0,
            created_at: now(),
            expires_at: now() + 60_000,
            status,
            detail: None,
        }
    }

    #[test]
    fn inbox_polling_excludes_history_but_peer_reconnect_keeps_terminal_receipts() {
        let store = Store::init(Connection::open_in_memory().unwrap(), "local", None).unwrap();
        for m in [
            message("old", "peer", "local", "worker", Status::Accepted),
            message("ready", "peer", "local", "worker", Status::Received),
            message("other-session", "peer", "local", "other", Status::Received),
            message(
                "other-peer",
                "elsewhere",
                "local",
                "worker",
                Status::Rejected,
            ),
            message("outgoing", "local", "peer", "remote", Status::Queued),
            message(
                "finished-outgoing",
                "local",
                "peer",
                "remote",
                Status::Accepted,
            ),
            message("uncertain", "peer", "local", "worker", Status::Uncertain),
        ] {
            store.insert(m).unwrap();
        }
        let ids = |messages: Vec<Message>| messages.into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids(store.inbox("worker").unwrap()), ["ready"]);
        assert_eq!(
            ids(store.open_messages().unwrap()),
            ["ready", "other-session", "outgoing"]
        );
        assert_eq!(
            ids(store.peer_messages("peer").unwrap()),
            ["old", "ready", "other-session", "outgoing", "uncertain"]
        );
        let mut ready = store.get("ready").unwrap().unwrap();
        ready.status = Status::Accepted;
        store.save(&ready).unwrap();
        assert!(store.inbox("worker").unwrap().is_empty());
        assert_eq!(
            ids(store.peer_messages("peer").unwrap()),
            ["old", "ready", "other-session", "outgoing", "uncertain"]
        );
        assert_eq!(
            store.messages().unwrap().len(),
            7,
            "polling must not delete history"
        );
    }

    #[test]
    fn event_byte_pages_preserve_full_content_and_cursor_continuation() {
        let store = Store::init(Connection::open_in_memory().unwrap(), "local", None).unwrap();
        for index in 0..12 {
            let mut m = message(
                &format!("large-{index}"),
                "peer",
                "local",
                "worker",
                Status::Received,
            );
            m.content = "x".repeat(60 * 1024);
            store.insert(m).unwrap();
        }
        let mut cursor = 0;
        let mut count = 0;
        loop {
            let page = store.events(cursor, Some("worker")).unwrap();
            if page.is_empty() {
                break;
            }
            assert!(page.len() <= 4);
            for event in &page {
                assert_eq!(event.message.content.len(), 60 * 1024);
                assert!(event.seq > cursor);
            }
            cursor = page.last().unwrap().seq;
            count += page.len();
        }
        assert_eq!(count, 12);
        assert!(store.events(0, Some("foreign")).unwrap().is_empty());
    }

    #[test]
    fn lifecycle_cursor_pages_are_bounded_without_losing_records() {
        let store = Store::init(Connection::open_in_memory().unwrap(), "local", None).unwrap();
        let mut m = message("audit", "peer", "local", "worker", Status::Accepted);
        m.detail = Some("x".repeat(1024));
        store.insert(m.clone()).unwrap();
        for _ in 0..100 {
            store.save(&m).unwrap();
        }
        let mut after = 0;
        let mut total = 0;
        loop {
            let page = store.lifecycle_events(after, Some("worker")).unwrap();
            if page.is_empty() {
                break;
            }
            assert!(page.len() <= 100);
            assert!(
                page.iter()
                    .map(|e| serde_json::to_vec(e).unwrap().len())
                    .sum::<usize>()
                    <= 32768
            );
            assert!(page.iter().all(|e| e.seq > after));
            total += page.len();
            after = page.last().unwrap().seq;
        }
        assert_eq!(total, 101);
        assert!(store
            .lifecycle_events(0, Some("foreign"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn lifecycle_participant_query_seeks_indexes_and_preserves_terminal_receipts() {
        let store = Store::init(Connection::open_in_memory().unwrap(), "local", None).unwrap();
        for i in 0..500 {
            store
                .insert(message(
                    &format!("unrelated-{i}"),
                    "peer",
                    "local",
                    "other",
                    Status::Accepted,
                ))
                .unwrap();
        }
        let mut incoming = message("incoming", "peer", "local", "worker", Status::Received);
        store.insert(incoming.clone()).unwrap();
        let mut outgoing = message("outgoing", "local", "peer", "worker", Status::Accepted);
        outgoing.source.session_id = "worker".into();
        store.insert(outgoing).unwrap();
        let mut own = message("own", "local", "local", "worker", Status::Accepted);
        own.source.session_id = "worker".into();
        store.insert(own).unwrap();
        incoming.status = Status::Rejected;
        store.save(&incoming).unwrap();
        let page = store.lifecycle_events(0, Some("worker")).unwrap();
        assert_eq!(page.len(), 4);
        assert_eq!(page.iter().filter(|e| e.message_id == "own").count(), 1);
        assert_eq!(page.last().unwrap().data["status"], "rejected");
        assert_eq!(
            store
                .lifecycle_events(page[2].seq, Some("worker"))
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .lifecycle_events(0, Some("foreign"))
            .unwrap()
            .is_empty());
        let db = store.db.lock();
        let plan = db
            .prepare(&format!(
                "EXPLAIN QUERY PLAN {}",
                super::super::lifecycle::SESSION_QUERY
            ))
            .unwrap()
            .query_map(params![0, "worker", "local"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n");
        assert_eq!(
            plan.matches("SEARCH e USING INDEX lifecycle_message")
                .count(),
            2,
            "{plan}"
        );
        assert!(
            !plan.contains("SCAN e") && !plan.contains("SCAN m"),
            "{plan}"
        );
    }

    #[test]
    fn participant_event_indexes_keep_receipts_and_deduplicate_self_messages() {
        let store = Store::init(Connection::open_in_memory().unwrap(), "local", None).unwrap();
        for index in 0..500 {
            store
                .insert(message(
                    &format!("noise-{index}"),
                    "peer",
                    "local",
                    "other",
                    Status::Accepted,
                ))
                .unwrap();
        }
        let mut own = message("self", "local", "local", "sender", Status::Received);
        store.insert(own.clone()).unwrap();
        let first = store.events(0, Some("sender")).unwrap();
        assert_eq!(first.len(), 1, "self-addressed events occur once");
        own.status = Status::Accepted;
        store.save(&own).unwrap();
        store
            .insert(message(
                "reply",
                "peer",
                "local",
                "sender",
                Status::Rejected,
            ))
            .unwrap();
        let after = first[0].seq;
        let next = store.events(after, Some("sender")).unwrap();
        assert_eq!(next.len(), 2);
        assert_eq!(next[0].message.status, Status::Accepted);
        assert_eq!(next[1].message.status, Status::Rejected);
        assert!(next.iter().all(|row| row.seq > after));
        assert!(store
            .events(next[1].seq, Some("sender"))
            .unwrap()
            .is_empty());
        assert!(store.events(0, Some("foreign")).unwrap().is_empty());
        let db = store.db.lock();
        let details = db
            .prepare(&format!("EXPLAIN QUERY PLAN {SESSION_EVENTS}"))
            .unwrap()
            .query_map(params![after, "sender", "local"], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n");
        for index in ["event_source_cursor", "event_target_cursor"] {
            assert!(details.contains(index), "{details}");
        }
        assert!(!details.contains("SCAN events"), "{details}");
    }

    #[test]
    fn sqlite_uses_inbox_and_route_indexes() {
        let store = Store::init(Connection::open_in_memory().unwrap(), "local", None).unwrap();
        let db = store.db.lock();
        for (query, expected) in [
            ("EXPLAIN QUERY PLAN SELECT body FROM messages WHERE target_node='local' AND target_session='worker' AND json_extract(body,'$.status')='received' ORDER BY rowid", "message_inbox_status"),
            ("EXPLAIN QUERY PLAN SELECT body FROM messages WHERE json_extract(body,'$.status') IN ('queued','received','delivering') ORDER BY rowid", "message_status"),
            ("EXPLAIN QUERY PLAN SELECT body FROM messages WHERE (source_node='local' AND target_node='peer' AND json_extract(body,'$.status') IN ('queued','received','delivering')) OR (source_node='peer' AND target_node='local') ORDER BY rowid", "message_route"),
        ] {
            let mut q = db.prepare(query).unwrap();
            let details = q.query_map([], |r| r.get::<_, String>(3)).unwrap().collect::<std::result::Result<Vec<_>, _>>().unwrap().join("\n");
            assert!(details.contains(expected), "expected {expected}: {details}");
            assert!(!details.contains("SCAN messages"), "unexpected full scan: {details}");
        }
    }
}
