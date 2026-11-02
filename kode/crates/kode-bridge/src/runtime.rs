//! Runtime-neutral session projection and command mailbox. The runtime owns
//! execution; Kode owns stable public identities, replay and durable receipts.
use crate::{Ctx, EventEnvelope};
use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};

const FIRST_RUNTIME_ID: u64 = 1 << 40;

/// Event kinds a runtime may publish. Publishers filter with this list: one
/// unknown kind rejects the whole publication, which also stalls the
/// runtime's command mailbox.
pub const EVENT_KINDS: &[&str] = &[
    "message",
    "tool_use",
    "tool_result",
    "meta",
    "ask_user_question",
    "plan_proposed",
    "session.attention_cleared",
    "interaction.resolved",
    "session.status",
    "session.mode_changed",
];

#[derive(Default)]
pub struct Registry {
    db: Mutex<Option<Connection>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub runtime: String,
    pub boot_id: String,
    pub sessions: Vec<Projection>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Projection {
    pub session_id: String,
    pub dto: Value,
    #[serde(default)]
    pub events: Vec<ProjectedEvent>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectedEvent {
    pub key: String,
    pub kind: String,
    pub payload: Value,
}

impl Registry {
    pub fn open(&self, path: &Path) -> Result<()> {
        let mut guard = self.db.lock();
        if guard.is_some() {
            return Ok(());
        }
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS runtime_hosts(runtime TEXT PRIMARY KEY, boot TEXT NOT NULL, seen INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS runtime_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, runtime TEXT NOT NULL, native_id TEXT NOT NULL, dto TEXT NOT NULL, UNIQUE(runtime,native_id));
            CREATE TABLE IF NOT EXISTS runtime_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL, UNIQUE(session_id,event_key));
            CREATE INDEX IF NOT EXISTS runtime_events_ts ON runtime_events(ts);
            CREATE TABLE IF NOT EXISTS runtime_commands(id TEXT PRIMARY KEY, runtime TEXT NOT NULL, boot TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, result TEXT);")?;
        db.execute("INSERT OR IGNORE INTO runtime_sessions(id,runtime,native_id,dto) VALUES(?1,'_reserved','_reserved','null')", [FIRST_RUNTIME_ID])?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        db.execute("UPDATE runtime_hosts SET seen=0", [])?;
        *guard = Some(db);
        Ok(())
    }

    pub fn snapshots(&self) -> Vec<Value> {
        let guard = self.db.lock();
        let Some(db) = guard.as_ref() else {
            return vec![];
        };
        let load = || -> Result<Vec<Value>> {
            let hosts: std::collections::HashMap<String, u64> = {
                let mut statement = db.prepare("SELECT runtime,seen FROM runtime_hosts")?;
                let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                rows.collect::<std::result::Result<_, _>>()?
            };
            let mut stmt = db.prepare(
                "SELECT id,dto FROM runtime_sessions WHERE runtime!='_reserved' ORDER BY id",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, u64>(0)?, r.get::<_, String>(1)?)))?;
            rows.map(|row| {
                let (id, dto) = row?;
                let mut dto: Value = serde_json::from_str(&dto)?;
                let online = dto["runtime"]
                    .as_str()
                    .and_then(|runtime| hosts.get(runtime))
                    .is_some_and(|seen| crate::now_ms().saturating_sub(*seen) < 15000);
                dto["runtime_online"] = json!(online);
                let mut alive = online;
                #[cfg(unix)]
                if dto["runtime"] == "gui" {
                    alive = dto["native_process_id"]
                        .as_u64()
                        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
                        .is_some_and(|pid| unsafe {
                            libc::kill(pid as i32, 0) == 0
                                || std::io::Error::last_os_error().raw_os_error()
                                    == Some(libc::EPERM)
                        });
                }
                dto["owner_alive"] = json!(alive);
                Ok(json!({"local_id":id,"dto":dto}))
            })
            .collect()
        };
        load().unwrap_or_default()
    }

    pub fn available(&self, runtime: &str) -> bool {
        let guard = self.db.lock();
        let Some(db) = guard.as_ref() else {
            return false;
        };
        db.query_row(
            "SELECT seen FROM runtime_hosts WHERE runtime=?1",
            [runtime],
            |r| r.get::<_, u64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some_and(|seen| crate::now_ms().saturating_sub(seen) < 15000)
    }

    pub fn contains(&self, id: u64) -> bool {
        let guard = self.db.lock();
        let Some(db) = guard.as_ref() else {
            return false;
        };
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM runtime_sessions WHERE id=?1 AND runtime!='_reserved')",
            [id],
            |row| row.get(0),
        )
        .unwrap_or(false)
    }

    pub fn history(&self, id: u64, from: u64, limit: usize) -> Result<Vec<EventEnvelope>> {
        let guard = self.db.lock();
        let Some(db) = guard.as_ref() else {
            return Ok(vec![]);
        };
        let mut stmt=db.prepare("SELECT ts,kind,payload FROM (SELECT cursor,ts,kind,payload FROM runtime_events WHERE session_id=?1 AND ts>=?2 ORDER BY cursor DESC LIMIT ?3) ORDER BY cursor")?;
        let rows = stmt.query_map(params![id, from, limit.min(10000)], |r| {
            Ok((
                r.get::<_, u64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (cursor, kind, payload) = row?;
            let mut event = EventEnvelope::new(id, kind, serde_json::from_str(&payload)?);
            event.ts = cursor;
            Ok(event)
        })
        .collect()
    }

    pub fn publish(&self, ctx: &Ctx, input: Publication) -> Result<Value> {
        if !crate::messaging::model::valid_id(&input.runtime)
            || input.boot_id.is_empty()
            || input.boot_id.len() > 128
            || input.sessions.len() > 10000
        {
            bail!("invalid runtime publication")
        }
        let mut emitted = vec![];
        let mut mapped = vec![];
        {
            let mut guard = self.db.lock();
            let db = guard.as_mut().context("runtime store unavailable")?;
            let tx = db.transaction()?;
            let previous: Option<(String, u64)> = tx
                .query_row(
                    "SELECT boot,seen FROM runtime_hosts WHERE runtime=?1",
                    [&input.runtime],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((boot, seen)) = previous {
                if boot != input.boot_id {
                    if crate::now_ms().saturating_sub(seen) < 15000 {
                        bail!("Another Host already owns this runtime; stop it before reconnecting")
                    }
                    tx.execute("UPDATE runtime_commands SET status='done',result=?2 WHERE runtime=?1 AND status='queued'",params![input.runtime,json!({"error":"Runtime disconnected before dispatch; operation was not replayed"}).to_string()])?;
                }
            }
            tx.execute("INSERT INTO runtime_hosts VALUES(?1,?2,?3) ON CONFLICT(runtime) DO UPDATE SET boot=excluded.boot,seen=excluded.seen",params![input.runtime,input.boot_id,crate::now_ms()])?;
            for session in input.sessions {
                if !crate::messaging::model::valid_id(&session.session_id)
                    || !session.dto.is_object()
                    || session.events.len() > 10000
                {
                    bail!("invalid session projection")
                }
                let prior: Option<(u64, String)> = tx
                    .query_row(
                        "SELECT id,dto FROM runtime_sessions WHERE runtime=?1 AND native_id=?2",
                        params![input.runtime, session.session_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                let id = match &prior {
                    Some((id, _)) => *id,
                    None => {
                        tx.execute("INSERT INTO runtime_sessions(runtime,native_id,dto) VALUES(?1,?2,'{}')",params![input.runtime,session.session_id])?;
                        tx.last_insert_rowid() as u64
                    }
                };
                let mut dto = session.dto;
                dto["id"] = json!(id);
                dto["runtime"] = json!(input.runtime);
                dto["runtime_session_id"] = json!(session.session_id);
                dto["transport_kind"] = json!("runtime");
                let encoded = serde_json::to_string(&dto)?;
                tx.execute(
                    "UPDATE runtime_sessions SET dto=?2 WHERE id=?1",
                    params![id, encoded],
                )?;
                if prior.as_ref().map(|(_, s)| s) != Some(&encoded) {
                    emitted.push(EventEnvelope::new(
                        id,
                        if prior.is_some() {
                            "session.updated"
                        } else {
                            "session.created"
                        },
                        dto,
                    ));
                }
                for event in session.events {
                    if event.key.len() > 256
                        || event.key.is_empty()
                        || !EVENT_KINDS.contains(&event.kind.as_str())
                    {
                        bail!("invalid runtime event")
                    }
                    let last: u64 =
                        tx.query_row("SELECT COALESCE(MAX(ts),0) FROM runtime_events", [], |r| {
                            r.get(0)
                        })?;
                    let timestamp = crate::now_ms().max(last + 1);
                    let changed=tx.execute("INSERT OR IGNORE INTO runtime_events(session_id,event_key,kind,payload,ts) VALUES(?1,?2,?3,?4,?5)",params![id,event.key,event.kind,serde_json::to_string(&event.payload)?,timestamp])?;
                    if changed > 0 {
                        let mut env = EventEnvelope::new(id, event.kind, event.payload);
                        env.ts = timestamp;
                        emitted.push(env);
                    }
                }
                mapped.push(json!({"session_id":session.session_id,"id":id}));
            }
            tx.commit()?;
        }
        for event in emitted {
            ctx.bus.emit(event);
        }
        Ok(json!({"sessions":mapped}))
    }

    pub async fn request(
        &self,
        runtime: &str,
        session: Option<&str>,
        kind: &str,
        payload: Value,
        request_id: &str,
    ) -> Result<Value> {
        if !crate::messaging::model::valid_id(request_id) || kind.len() > 80 {
            bail!("Invalid runtime request identity or operation")
        }
        let mut body = json!({"runtime":runtime,"id":request_id,"session_id":session,"kind":kind,"payload":payload});
        let fingerprint = serde_json::to_string(&body)?;
        body["expires_at"] = json!(crate::now_ms() + 30000);
        {
            let guard = self.db.lock();
            let db = guard.as_ref().context("runtime unavailable")?;
            let prior: Option<(String, String, Option<String>)> = db
                .query_row(
                    "SELECT fingerprint,status,result FROM runtime_commands WHERE id=?1",
                    [request_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            if let Some((prior, status, result)) = prior {
                if prior != fingerprint {
                    bail!("request identity conflicts with another operation")
                };
                if status == "done" {
                    return decode_result(result.as_deref().context("missing runtime result")?);
                }
            } else {
                let host: Option<(String, u64)> = db
                    .query_row(
                        "SELECT boot,seen FROM runtime_hosts WHERE runtime=?1",
                        [runtime],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                let (boot, seen) = host.context("runtime is not connected")?;
                if crate::now_ms().saturating_sub(seen) > 15000 {
                    bail!("runtime is offline")
                }
                db.execute(
                    "INSERT INTO runtime_commands VALUES(?1,?2,?3,?4,?5,'queued',NULL)",
                    params![
                        request_id,
                        runtime,
                        boot,
                        fingerprint,
                        serde_json::to_string(&body)?
                    ],
                )?;
            }
        }
        for _ in 0..300 {
            {
                let guard = self.db.lock();
                let db = guard.as_ref().context("runtime unavailable")?;
                let result: Option<String> = db.query_row(
                    "SELECT result FROM runtime_commands WHERE id=?1",
                    [request_id],
                    |r| r.get(0),
                )?;
                if let Some(result) = result {
                    return decode_result(&result);
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        bail!("runtime operation outcome unconfirmed; do not replay with a new request id")
    }

    pub async fn command(
        &self,
        id: u64,
        kind: &str,
        payload: Value,
        request_id: &str,
    ) -> Result<Value> {
        let (runtime, native) = {
            let guard = self.db.lock();
            let db = guard.as_ref().context("runtime unavailable")?;
            db.query_row(
                "SELECT runtime,native_id FROM runtime_sessions WHERE id=?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )?
        };
        self.request(&runtime, Some(&native), kind, payload, request_id)
            .await
    }

    pub fn release(&self, runtime: &str, boot: &str) -> Result<()> {
        let guard = self.db.lock();
        let db = guard.as_ref().context("Runtime unavailable")?;
        db.execute(
            "UPDATE runtime_hosts SET seen=0 WHERE runtime=?1 AND boot=?2",
            params![runtime, boot],
        )?;
        Ok(())
    }

    pub fn claim(&self, runtime: &str, boot: &str) -> Result<Value> {
        let mut guard = self.db.lock();
        let db = guard.as_mut().context("runtime unavailable")?;
        let tx = db.transaction()?;
        let updated = tx.execute(
            "UPDATE runtime_hosts SET seen=?3 WHERE runtime=?1 AND boot=?2",
            params![runtime, boot, crate::now_ms()],
        )?;
        if updated == 0 {
            bail!("runtime ownership changed; publish before claiming")
        }
        let bodies: Vec<String> = {
            let mut stmt=tx.prepare("SELECT body FROM runtime_commands WHERE runtime=?1 AND boot=?2 AND status='queued' ORDER BY rowid LIMIT 16")?;
            let rows = stmt.query_map(params![runtime, boot], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let parsed: Vec<Value> = bodies
            .iter()
            .map(|b| serde_json::from_str(b))
            .collect::<std::result::Result<_, _>>()?;
        let mut commands = vec![];
        for command in parsed {
            if command["expires_at"].as_u64().unwrap_or(0) <= crate::now_ms() {
                tx.execute(
                    "UPDATE runtime_commands SET status='done',result=?2 WHERE id=?1",
                    params![
                        command["id"].as_str().unwrap_or_default(),
                        json!({"error":"Runtime request expired before dispatch"}).to_string()
                    ],
                )?;
            } else {
                commands.push(command);
            }
        }
        for command in &commands {
            tx.execute(
                "UPDATE runtime_commands SET status='claimed' WHERE id=?1",
                [command["id"].as_str().unwrap_or_default()],
            )?;
        }
        tx.commit()?;
        Ok(json!({"commands":commands}))
    }

    pub fn settle(&self, runtime: &str, boot: &str, id: &str, result: Value) -> Result<()> {
        let guard = self.db.lock();
        let db = guard.as_ref().context("runtime unavailable")?;
        let prior:Option<String>=db.query_row("SELECT result FROM runtime_commands WHERE id=?1 AND runtime=?2 AND boot=?3 AND status IN ('claimed','done')",params![id,runtime,boot],|r|r.get(0)).optional()?.flatten();
        let encoded = serde_json::to_string(&result)?;
        if let Some(prior) = prior {
            if prior != encoded {
                bail!("runtime receipt conflicts with settled result")
            };
            return Ok(());
        }
        if db.execute("UPDATE runtime_commands SET status='done',result=?4 WHERE id=?1 AND runtime=?2 AND boot=?3 AND status='claimed'",params![id,runtime,boot,encoded])?!=1 {bail!("unknown or unclaimed runtime command")};
        Ok(())
    }
}
fn decode_result(raw: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(raw)?;
    if let Some(error) = value["error"].as_str() {
        bail!("{error}")
    };
    Ok(value["value"].clone())
}

pub async fn command(
    ctx: &Arc<Ctx>,
    id: u64,
    kind: &str,
    payload: Value,
    request_id: &str,
) -> Result<Value> {
    ctx.runtimes.command(id, kind, payload, request_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn publication(boot: &str) -> Publication {
        serde_json::from_value(json!({"runtime":"dsh","boot_id":boot,"sessions":[{"session_id":"session-1","dto":{"title":"Shared conversation","status":"idle","backend_key":"codex"},"events":[{"key":"log:1","kind":"message","payload":{"id":"message-1","role":"assistant","text":"hello"}}]}]})).unwrap()
    }

    /// Mode changes are emitted on every Claude tool call; rejecting them
    /// failed every publication and left mobile commands unclaimed.
    #[tokio::test]
    async fn publication_accepts_every_forwarded_event_kind() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = crate::build_test_ctx(Default::default(), "test".into());
        ctx.runtimes.open(&dir.path().join("runtime.sqlite")).unwrap();
        let events: Vec<_> = EVENT_KINDS
            .iter()
            .enumerate()
            .map(|(i, kind)| json!({"key":format!("k:{i}"),"kind":kind,"payload":{"mode":"bypassPermissions"}}))
            .collect();
        let publication: Publication = serde_json::from_value(json!({"runtime":"gui","boot_id":"gui-1","sessions":[{"session_id":"gui:1:1","dto":{"status":"idle","backend_key":"claude"},"events":events}]})).unwrap();
        ctx.runtimes.publish(&ctx, publication).unwrap();
        let rejected: Publication = serde_json::from_value(json!({"runtime":"gui","boot_id":"gui-1","sessions":[{"session_id":"gui:1:1","dto":{},"events":[{"key":"x","kind":"pty_bytes","payload":{}}]}]})).unwrap();
        assert!(ctx.runtimes.publish(&ctx, rejected).is_err());
    }

    #[tokio::test]
    async fn durable_identity_history_and_receipts_survive_runtime_and_backend_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime.sqlite");
        let ctx = crate::build_test_ctx(Default::default(), "test".into());
        ctx.runtimes.open(&path).unwrap();
        let mut bus = ctx.bus.subscribe();
        let first = ctx.runtimes.publish(&ctx, publication("boot-1")).unwrap();
        let id = first["sessions"][0]["id"].as_u64().unwrap();
        assert!(id > FIRST_RUNTIME_ID);
        assert_eq!(bus.try_recv().unwrap().r#type, "session.created");
        assert_eq!(bus.try_recv().unwrap().payload["text"], "hello");
        ctx.runtimes.publish(&ctx, publication("boot-1")).unwrap();
        assert!(bus.try_recv().is_err());
        let request_ctx = ctx.clone();
        let request = tokio::spawn(async move {
            request_ctx
                .runtimes
                .command(id, "input", json!({"text":"from phone"}), "command-1")
                .await
        });
        let commands = loop {
            let commands = ctx.runtimes.claim("dsh", "boot-1").unwrap();
            if !commands["commands"].as_array().unwrap().is_empty() {
                break commands;
            };
            tokio::task::yield_now().await
        };
        assert_eq!(commands["commands"][0]["session_id"], "session-1");
        assert!(ctx.runtimes.claim("dsh", "boot-1").unwrap()["commands"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(ctx
            .runtimes
            .settle("other", "boot-1", "command-1", json!({"value":true}))
            .is_err());
        ctx.runtimes
            .settle(
                "dsh",
                "boot-1",
                "command-1",
                json!({"value":{"accepted":true}}),
            )
            .unwrap();
        assert_eq!(request.await.unwrap().unwrap()["accepted"], true);
        ctx.runtimes.release("dsh", "boot-1").unwrap();
        assert_eq!(
            ctx.runtimes
                .command(id, "input", json!({"text":"from phone"}), "command-1")
                .await
                .unwrap()["accepted"],
            true
        );
        ctx.runtimes.publish(&ctx, publication("boot-1")).unwrap();
        assert!(ctx
            .runtimes
            .publish(&ctx, publication("competing-owner"))
            .is_err());
        assert!(ctx
            .runtimes
            .command(id, "input", json!({"text":"different"}), "command-1")
            .await
            .is_err());
        let history = ctx.runtimes.history(id, 0, 100).unwrap();
        assert_eq!(history.len(), 1);
        let timestamp = history[0].ts;
        drop(ctx);
        let ctx = crate::build_test_ctx(Default::default(), "test".into());
        ctx.runtimes.open(&path).unwrap();
        assert_eq!(
            ctx.runtimes.publish(&ctx, publication("boot-2")).unwrap()["sessions"][0]["id"],
            id
        );
        assert_eq!(ctx.runtimes.history(id, 0, 100).unwrap()[0].ts, timestamp);
        assert_eq!(
            ctx.runtimes
                .command(id, "input", json!({"text":"from phone"}), "command-1")
                .await
                .unwrap()["accepted"],
            true
        );
        assert!(ctx.runtimes.claim("dsh", "boot-1").is_err());
    }

    #[tokio::test]
    async fn queued_commands_expire_without_being_claimed_or_replayed() {
        let root = tempfile::tempdir().unwrap();
        let ctx = crate::build_test_ctx(Default::default(), "test".into());
        ctx.runtimes
            .open(&root.path().join("runtime.sqlite"))
            .unwrap();
        let published = ctx.runtimes.publish(&ctx, publication("owner")).unwrap();
        let id = published["sessions"][0]["id"].as_u64().unwrap();
        let requester = ctx.clone();
        let request = tokio::spawn(async move {
            requester
                .runtimes
                .command(id, "input", json!({"text":"expired"}), "expired-command")
                .await
        });
        loop {
            let found=ctx.runtimes.db.lock().as_ref().unwrap().execute("UPDATE runtime_commands SET body=json_set(body,'$.expires_at',0) WHERE id='expired-command'",[]).unwrap();
            if found > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(ctx.runtimes.claim("dsh", "owner").unwrap()["commands"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(request
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("expired"));
        assert!(ctx.runtimes.claim("dsh", "owner").unwrap()["commands"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn invalid_publication_rolls_back_metadata_and_events() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = crate::build_test_ctx(Default::default(), "test".into());
        ctx.runtimes
            .open(&dir.path().join("runtime.sqlite"))
            .unwrap();
        let mut input = publication("boot");
        input.sessions[0].events[0].kind = "pty_bytes".into();
        assert!(ctx.runtimes.publish(&ctx, input).is_err());
        assert!(ctx.runtimes.snapshots().is_empty());
    }
}
