//! Durable input-scoped controls. A stop request is not a termination receipt.
use super::{model::*, Hub};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Requested,
    QueuedRemoved,
    CancelUnconfirmed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub message_id: String,
    pub session_id: String,
    pub input_id: String,
    pub state: State,
    pub reason: Option<String>,
    pub updated_at: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub session_id: String,
    pub input_id: String,
    pub state: State,
    pub reason: Option<String>,
}
impl Hub {
    pub(super) fn cancellation(&self, id: &str) -> Result<Option<Record>> {
        let text: Option<String> = self
            .store
            .db
            .lock()
            .query_row(
                "SELECT body FROM input_cancellations WHERE message_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        text.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }
    pub(super) fn request_cancellation(&self, id: &str) -> Result<Record> {
        let _guard = self.gate.lock();
        let m = self
            .store
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("unknown message"))?;
        if m.source.node_id != self.node_id() {
            bail!("foreign cancellation source")
        }
        if m.target.node_id != self.node_id() && !self.cancel_peer_supported(&m.target.node_id)? {
            bail!("remote input cancellation is not negotiated")
        }
        if let Some(old) = self.cancellation(id)? {
            return Ok(old);
        }
        let binding = (if m.target.node_id == self.node_id() {
            self.store.delivery(id)?
        } else {
            self.store.delivery_mirror(id)?
        })
        .ok_or_else(|| anyhow::anyhow!("runtime input binding unavailable"))?;
        let record = Record {
            message_id: id.into(),
            session_id: binding.session_id,
            input_id: binding.input_id,
            state: State::Requested,
            reason: None,
            updated_at: now(),
        };
        self.save_cancellation(&record)?;
        Ok(record)
    }
    pub(super) fn pending_cancellations(&self, session: &str, after: &str) -> Result<Vec<Record>> {
        let db = self.store.db.lock();
        let mut q = db.prepare("SELECT c.body FROM input_cancellations c JOIN messages m ON m.id=c.message_id WHERE c.session=?1 AND c.pending=1 AND c.message_id>?2 AND m.target_node=?3 ORDER BY c.message_id LIMIT 200")?;
        let rows = q.query_map(params![session, after, self.node_id()], |r| {
            r.get::<_, String>(0)
        })?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub(super) fn report_cancellation(&self, id: &str, report: Report) -> Result<Record> {
        let _guard = self.gate.lock();
        let m = self
            .store
            .get(id)?
            .ok_or_else(|| anyhow::anyhow!("unknown message"))?;
        if m.target.node_id != self.node_id() {
            bail!("foreign cancellation execution host")
        }
        let mut record = self
            .cancellation(id)?
            .ok_or_else(|| anyhow::anyhow!("unknown cancellation"))?;
        if record.session_id != report.session_id || record.input_id != report.input_id {
            bail!("foreign cancellation binding")
        }
        if report.state == State::Requested || report.reason.as_ref().is_some_and(|s| s.len() > 256)
        {
            bail!("invalid cancellation result")
        }
        if record.state != State::Requested {
            if record.state != report.state || record.reason != report.reason {
                bail!("cancellation result conflict")
            }
            return Ok(record);
        }
        record.state = report.state;
        record.reason = report.reason;
        record.updated_at = now();
        self.save_cancellation(&record)?;
        Ok(record)
    }
    fn save_cancellation(&self, record: &Record) -> Result<()> {
        let mut db = self.store.db.lock();
        let tx = db.transaction()?;
        let body = serde_json::to_string(record)?;
        tx.execute("INSERT INTO input_cancellations(message_id,session,pending,body) VALUES (?1,?2,?3,?4) ON CONFLICT(message_id) DO UPDATE SET pending=excluded.pending,body=excluded.body", params![record.message_id,record.session_id,record.state==State::Requested,body])?;
        tx.execute(
            "INSERT INTO input_cancellation_events(message_id,body) VALUES (?1,?2)",
            params![record.message_id, body],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn pending_control_survives_exclusive_store_reopen() {
        let root = tempfile::tempdir().unwrap();
        let ctx =
            crate::build_test_ctx(kode_core::config::Config::default(), "fixture-admin".into());
        let config = || super::super::Config {
            node_id: "local".into(),
            database: root.path().join("control.sqlite"),
            peers: vec![],
        };
        let hub = Hub::open(config(), &ctx).unwrap();
        hub.store
            .insert(Message {
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
                idempotency_key: "control".into(),
                in_reply_to: None,
                hop_count: 0,
                created_at: now(),
                expires_at: now() + 60_000,
                status: Status::Delivering,
                detail: None,
            })
            .unwrap();
        hub.observe_delivery(
            "message",
            super::super::delivery::Observation {
                session_id: "worker".into(),
                input_id: "input".into(),
                phase: super::super::delivery::Phase::Prepared,
                event_seq: None,
            },
        )
        .unwrap();
        hub.request_cancellation("message").unwrap();
        drop(hub);
        let hub = Hub::open(config(), &ctx).unwrap();
        let pending = hub.pending_cancellations("worker", "").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].input_id, "input");
        hub.report_cancellation(
            "message",
            Report {
                session_id: "worker".into(),
                input_id: "input".into(),
                state: State::QueuedRemoved,
                reason: None,
            },
        )
        .unwrap();
        drop(hub);
        let hub = Hub::open(config(), &ctx).unwrap();
        assert!(hub.pending_cancellations("worker", "").unwrap().is_empty());
        assert_eq!(
            hub.request_cancellation("message").unwrap().state,
            State::QueuedRemoved
        );
        let mut remote = hub.store.get("message").unwrap().unwrap();
        remote.id = "remote-message".into();
        remote.idempotency_key = "remote-key".into();
        remote.target.node_id = "executor".into();
        hub.store.insert(remote).unwrap();
        assert!(
            hub.request_cancellation("remote-message").is_err(),
            "unknown capability must fail closed"
        );
        hub.remember_cancel_peer("executor", true).unwrap();
        hub.mirror_deliveries(
            "executor",
            &[super::super::delivery::DeliveryEvent {
                seq: 1,
                record: super::super::delivery::Record {
                    message_id: "remote-message".into(),
                    session_id: "worker".into(),
                    input_id: "remote-input".into(),
                    phase: super::super::delivery::Phase::Queued,
                    event_seq: None,
                    observed_at: now(),
                },
            }],
        )
        .unwrap();
        hub.request_cancellation("remote-message").unwrap();
        drop(hub);
        let hub = Hub::open(config(), &ctx).unwrap();
        assert_eq!(hub.outgoing_cancellations("executor", "").unwrap().len(), 1);
        assert!(hub.pending_cancellations("worker", "").unwrap().is_empty());
        hub.remember_cancel_peer("executor", false).unwrap();
        assert!(
            hub.request_cancellation("remote-message").is_err(),
            "a v1 reconnect revokes capability for further requests"
        );
    }
}

impl Hub {
    pub(super) fn remember_cancel_peer(&self, peer: &str, supported: bool) -> Result<()> {
        self.store.db.lock().execute("INSERT INTO cancellation_peers(peer,supported) VALUES (?1,?2) ON CONFLICT(peer) DO UPDATE SET supported=excluded.supported", params![peer,supported])?;
        Ok(())
    }
    fn cancel_peer_supported(&self, peer: &str) -> Result<bool> {
        Ok(self
            .store
            .db
            .lock()
            .query_row(
                "SELECT supported FROM cancellation_peers WHERE peer=?1",
                [peer],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }
    pub(super) fn outgoing_cancellations(&self, peer: &str, after: &str) -> Result<Vec<Record>> {
        let db = self.store.db.lock();
        let mut q = db.prepare("SELECT c.body FROM input_cancellations c JOIN messages m ON m.id=c.message_id WHERE c.pending=1 AND m.source_node=?1 AND m.target_node=?2 AND c.message_id>?3 ORDER BY c.message_id LIMIT 64")?;
        let rows = q.query_map(params![self.node_id(), peer, after], |r| {
            r.get::<_, String>(0)
        })?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    // Requested records originate only at the message source; results only at
    // its execution host. Requests repeat until a result is durably received.
    pub(super) fn receive_cancellation(
        &self,
        peer: &str,
        mut input: Record,
    ) -> Result<Option<Record>> {
        let _guard = self.gate.lock();
        let m = self
            .store
            .get(&input.message_id)?
            .ok_or_else(|| anyhow::anyhow!("unknown cancellation message"))?;
        if input.session_id != m.target.session_id
            || !valid_id(&input.input_id)
            || input.reason.as_ref().is_some_and(|s| s.len() > 256)
        {
            bail!("invalid cancellation binding")
        }
        let old = self.cancellation(&input.message_id)?;
        if let Some(old) = &old {
            if old.input_id != input.input_id || old.session_id != input.session_id {
                bail!("cancellation binding conflict")
            }
        }
        if input.state == State::Requested {
            if m.source.node_id != peer
                || m.target.node_id != self.node_id()
                || input.reason.is_some()
            {
                bail!("foreign cancellation request")
            }
            let binding = self
                .store
                .delivery(&m.id)?
                .ok_or_else(|| anyhow::anyhow!("missing local input binding"))?;
            if binding.input_id != input.input_id {
                bail!("foreign cancellation input")
            }
            if let Some(old) = old {
                return Ok(if old.state == State::Requested {
                    None
                } else {
                    Some(old)
                });
            }
        } else {
            if m.source.node_id != self.node_id() || m.target.node_id != peer {
                bail!("foreign cancellation result")
            }
            let old = old.ok_or_else(|| anyhow::anyhow!("unsolicited cancellation result"))?;
            if old.state != State::Requested {
                if old.state != input.state || old.reason != input.reason {
                    bail!("cancellation result conflict")
                }
                return Ok(None);
            }
        }
        input.updated_at = now();
        self.save_cancellation(&input)?;
        Ok(None)
    }
}
