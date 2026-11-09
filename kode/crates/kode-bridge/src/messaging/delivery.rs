//! Runtime input evidence is separate from message delivery and task completion.
use super::{model::*, store::Store, Hub};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Prepared,
    Queued,
    Consumed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub session_id: String,
    pub input_id: String,
    pub phase: Phase,
    pub event_seq: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub message_id: String,
    pub session_id: String,
    pub input_id: String,
    pub phase: Phase,
    pub event_seq: Option<u64>,
    pub observed_at: u64,
}
impl Store {
    pub fn delivery(&self, id: &str) -> Result<Option<Record>> {
        let body: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT body FROM runtime_deliveries WHERE message_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub fn pending_deliveries(&self, session: &str, after: &str) -> Result<Vec<Record>> {
        let db = self.db.lock();
        let mut q = db.prepare("SELECT body FROM runtime_deliveries WHERE session=?1 AND phase<2 AND message_id>?2 ORDER BY message_id LIMIT 200")?;
        let rows = q.query_map(params![session, after], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    fn save_delivery(&self, mut message: Message, input: Observation) -> Result<Record> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT body FROM runtime_deliveries WHERE message_id=?1",
                [&message.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let old: Record = serde_json::from_str(&old)?;
            if old.input_id != input.input_id || old.session_id != input.session_id {
                bail!("delivery input binding conflict")
            }
            if old.phase >= input.phase {
                return Ok(old);
            }
        } else if input.phase != Phase::Prepared {
            bail!("prepare delivery before reporting runtime evidence")
        }
        let record = Record {
            message_id: message.id.clone(),
            session_id: input.session_id,
            input_id: input.input_id,
            phase: input.phase,
            event_seq: input.event_seq,
            observed_at: now(),
        };
        let body = serde_json::to_string(&record)?;
        let rank = match record.phase {
            Phase::Prepared => 0,
            Phase::Queued => 1,
            Phase::Consumed => 2,
        };
        tx.execute("INSERT INTO runtime_deliveries(message_id,session,phase,body) VALUES (?1,?2,?3,?4) ON CONFLICT(message_id) DO UPDATE SET phase=excluded.phase,body=excluded.body", params![message.id, record.session_id, rank, body])?;
        tx.execute(
            "INSERT INTO runtime_delivery_events(message_id,body) VALUES (?1,?2)",
            params![message.id, body],
        )?;
        if record.phase != Phase::Prepared && message.status != Status::Accepted {
            message.status = Status::Accepted;
            message.detail =
                Some("runtime input durably observed; task completion is not confirmed".into());
            let body = serde_json::to_string(&message)?;
            tx.execute(
                "UPDATE messages SET body=?2 WHERE id=?1",
                params![message.id, body],
            )?;
            tx.execute("INSERT INTO events(message) VALUES (?1)", [body])?;
        }
        tx.commit()?;
        Ok(record)
    }
}
impl Hub {
    pub(super) fn observe_delivery(&self, id: &str, input: Observation) -> Result<Record> {
        let _guard = self.gate.lock();
        let m = self
            .store
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("unknown message"))?;
        if m.target.node_id != self.node_id() || m.target.session_id != input.session_id {
            bail!("foreign delivery")
        }
        if !valid_id(&input.input_id)
            || (input.phase == Phase::Consumed && input.event_seq.is_none())
        {
            bail!("invalid delivery evidence")
        }
        if !matches!(
            m.status,
            Status::Delivering | Status::Uncertain | Status::Accepted
        ) {
            bail!("message is not claimed")
        }
        self.store.save_delivery(m, input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observations_survive_reopen_and_duplicate_reports_do_not_duplicate_audit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("delivery.sqlite");
        let store = Store::open(&path, "local").unwrap();
        let message = Message {
            id: "message".into(),
            source: Address {
                node_id: "local".into(),
                session_id: "sender".into(),
            },
            target: Address {
                node_id: "local".into(),
                session_id: "worker".into(),
            },
            content: "fixture".into(),
            idempotency_key: "observation".into(),
            in_reply_to: None,
            hop_count: 0,
            created_at: now(),
            expires_at: now() + 60_000,
            status: Status::Delivering,
            detail: None,
        };
        store.insert(message.clone()).unwrap();
        let observation = |phase| Observation {
            session_id: "worker".into(),
            input_id: "input".into(),
            phase,
            event_seq: None,
        };
        store
            .save_delivery(message.clone(), observation(Phase::Prepared))
            .unwrap();
        assert_eq!(store.pending_count("worker").unwrap(), 1);
        assert_eq!(store.pending_count("other").unwrap(), 0);
        store
            .save_delivery(message, observation(Phase::Queued))
            .unwrap();
        drop(store);
        let store = Store::open(&path, "local").unwrap();
        assert_eq!(
            store.delivery("message").unwrap().unwrap().phase,
            Phase::Queued
        );
        assert_eq!(
            store.get("message").unwrap().unwrap().status,
            Status::Accepted
        );
        assert_eq!(store.pending_deliveries("worker", "").unwrap().len(), 1);
        assert_eq!(store.pending_count("worker").unwrap(), 1);
        // Cancellation wakes only while actionable, and must not double-count a delivery.
        store.db.lock().execute("INSERT INTO input_cancellations(message_id,session,pending,body) VALUES ('message','worker',1,'{}')", []).unwrap();
        assert_eq!(store.pending_count("worker").unwrap(), 1);
        store
            .db
            .lock()
            .execute("UPDATE input_cancellations SET pending=0", [])
            .unwrap();
        assert_eq!(store.pending_count("worker").unwrap(), 0);
        store
            .db
            .lock()
            .execute("DELETE FROM input_cancellations", [])
            .unwrap();
        let mut consumed = observation(Phase::Consumed);
        consumed.event_seq = Some(7);
        for _ in 0..2 {
            store
                .save_delivery(store.get("message").unwrap().unwrap(), consumed.clone())
                .unwrap();
        }
        assert_eq!(store.pending_count("worker").unwrap(), 0);
        assert!(store.pending_deliveries("worker", "").unwrap().is_empty());
        let count: u64 = store
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM runtime_delivery_events", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 3);
        let mut second = store.get("message").unwrap().unwrap();
        second.id = "second-message".into();
        second.idempotency_key = "second-message".into();
        second.status = Status::Delivering;
        store.insert(second.clone()).unwrap();
        assert!(
            store
                .save_delivery(second, observation(Phase::Prepared))
                .is_err(),
            "two messages cannot share one runtime input"
        );
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryEvent {
    pub seq: u64,
    pub record: Record,
}
impl Store {
    pub fn delivery_mirror(&self, id: &str) -> Result<Option<Record>> {
        let text: Option<String> = self
            .db
            .lock()
            .query_row(
                "SELECT body FROM delivery_mirrors WHERE message_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        text.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub fn delivery_batch(&self, peer: &str) -> Result<Vec<DeliveryEvent>> {
        let db = self.db.lock();
        let after: u64 = db
            .query_row(
                "SELECT seq FROM delivery_peer_cursors WHERE peer=?1",
                [peer],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let mut q = db.prepare("SELECT e.seq,e.body FROM runtime_delivery_events e JOIN messages m ON m.id=e.message_id WHERE e.seq>?1 AND m.source_node=?2 AND m.target_node=?3 ORDER BY e.seq LIMIT 64")?;
        let rows = q.query_map(params![after, peer, self.node_id], |r| {
            Ok((r.get(0)?, r.get::<_, String>(1)?))
        })?;
        rows.map(|r| {
            let (seq, body) = r?;
            Ok(DeliveryEvent {
                seq,
                record: serde_json::from_str(&body)?,
            })
        })
        .collect()
    }
    pub fn acknowledge_deliveries(&self, peer: &str, through: u64) -> Result<()> {
        self.db.lock().execute("INSERT INTO delivery_peer_cursors(peer,seq) VALUES (?1,?2) ON CONFLICT(peer) DO UPDATE SET seq=MAX(seq,excluded.seq)", params![peer, through])?;
        Ok(())
    }
    fn mirror_deliveries(&self, peer: &str, entries: &[DeliveryEvent]) -> Result<u64> {
        if entries.is_empty() || entries.len() > 64 {
            bail!("invalid delivery batch size")
        }
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let mut previous = 0;
        for event in entries {
            let record = &event.record;
            if event.seq <= previous
                || !valid_id(&record.input_id)
                || (record.phase == Phase::Consumed && record.event_seq.is_none())
            {
                bail!("invalid remote delivery evidence")
            }
            previous = event.seq;
            let message: String = tx.query_row(
                "SELECT body FROM messages WHERE id=?1",
                [&record.message_id],
                |r| r.get(0),
            )?;
            let message: Message = serde_json::from_str(&message)?;
            if message.source.node_id != self.node_id
                || message.target.node_id != peer
                || message.target.session_id != record.session_id
            {
                bail!("foreign remote delivery")
            }
            let body = serde_json::to_string(record)?;
            let old_event: Option<String> = tx
                .query_row(
                    "SELECT body FROM delivery_mirror_events WHERE peer=?1 AND seq=?2",
                    params![peer, event.seq],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(old) = old_event {
                if old != body {
                    bail!("delivery event identity conflict")
                }
                continue;
            }
            let old: Option<String> = tx
                .query_row(
                    "SELECT body FROM delivery_mirrors WHERE message_id=?1",
                    [&record.message_id],
                    |r| r.get(0),
                )
                .optional()?;
            let advance = if let Some(old) = old {
                let old: Record = serde_json::from_str(&old)?;
                if old.input_id != record.input_id || old.session_id != record.session_id {
                    bail!("remote delivery binding conflict")
                }
                record.phase > old.phase
            } else {
                true
            };
            tx.execute(
                "INSERT INTO delivery_mirror_events(peer,seq,body) VALUES (?1,?2,?3)",
                params![peer, event.seq, body],
            )?;
            if advance {
                tx.execute("INSERT INTO delivery_mirrors(message_id,body) VALUES (?1,?2) ON CONFLICT(message_id) DO UPDATE SET body=excluded.body", params![record.message_id,body])?;
            }
        }
        tx.commit()?;
        Ok(previous)
    }
}
impl Hub {
    pub(super) fn mirror_deliveries(&self, peer: &str, entries: &[DeliveryEvent]) -> Result<u64> {
        let _guard = self.gate.lock();
        self.store.mirror_deliveries(peer, entries)
    }
}

#[cfg(test)]
mod mirror_tests {
    use super::*;
    #[test]
    fn mirror_batch_is_atomic_and_survives_reopen_with_ack_cursor() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("mirrors.sqlite");
        let store = Store::open(&path, "source").unwrap();
        store
            .insert(Message {
                id: "known".into(),
                source: Address {
                    node_id: "source".into(),
                    session_id: "sender".into(),
                },
                target: Address {
                    node_id: "executor".into(),
                    session_id: "worker".into(),
                },
                content: "fixture".into(),
                idempotency_key: "known".into(),
                in_reply_to: None,
                hop_count: 0,
                created_at: now(),
                expires_at: now() + 60_000,
                status: Status::Queued,
                detail: None,
            })
            .unwrap();
        let first = DeliveryEvent {
            seq: 3,
            record: Record {
                message_id: "known".into(),
                session_id: "worker".into(),
                input_id: "input".into(),
                phase: Phase::Consumed,
                event_seq: Some(12),
                observed_at: now(),
            },
        };
        let mut bad = first.clone();
        bad.seq = 4;
        bad.record.message_id = "unknown".into();
        assert!(store
            .mirror_deliveries("executor", &[first.clone(), bad])
            .is_err());
        assert!(
            store.delivery_mirror("known").unwrap().is_none(),
            "failed batch cannot leave a partial mirror"
        );
        assert_eq!(
            store
                .mirror_deliveries("executor", &[first.clone()])
                .unwrap(),
            3
        );
        store.acknowledge_deliveries("executor", 9).unwrap();
        store.acknowledge_deliveries("executor", 2).unwrap();
        drop(store);
        let store = Store::open(&path, "source").unwrap();
        assert_eq!(
            store.delivery_mirror("known").unwrap().unwrap().phase,
            Phase::Consumed
        );
        let cursor: u64 = store
            .db
            .lock()
            .query_row(
                "SELECT seq FROM delivery_peer_cursors WHERE peer='executor'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cursor, 9);
        store.mirror_deliveries("executor", &[first]).unwrap();
        let count: u64 = store
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM delivery_mirror_events", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
