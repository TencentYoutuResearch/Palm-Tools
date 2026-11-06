//! Per-account in-memory state.
//!
//! Everything a request can reach hangs off one `Tenant`, which is looked up
//! only by the verified `sub`. There is no cross-tenant index, so a handler
//! that forgets a check still cannot name another account's device.

use std::collections::{HashMap, HashSet};

use kode_relay_protocol::{AgentSession, CloudEnvelope, ServerFrame, SHARED_RUNTIME_ID_FLOOR};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

pub(crate) type Reply = (u16, Value);

#[derive(Default)]
pub(crate) struct Tenant {
    pub(crate) devices: HashMap<String, Device>,
}

#[derive(Clone)]
pub(crate) struct AgentConn {
    pub(crate) connection_id: String,
    pub(crate) tx: mpsc::UnboundedSender<ServerFrame>,
}

pub(crate) struct Device {
    pub(crate) name: String,
    pub(crate) agent: Option<AgentConn>,
    /// Boot of the connected agent, used to place sessions it creates.
    pub(crate) boot_id: Option<String>,
    pub(crate) last_seen_ms: u64,
    pub(crate) bus: broadcast::Sender<CloudEnvelope>,
    /// Open mobile WebSockets for this desktop.
    pub(crate) ws_viewers: usize,
    /// REST activity and recently closed sockets keep streaming until then.
    pub(crate) lease_until_ms: u64,
    /// The value most recently sent to the agent.
    pub(crate) sync_enabled: bool,
    /// Bumped whenever the agent delivers an authoritative hello snapshot.
    pub(crate) snapshots: watch::Sender<u64>,
    pub(crate) sessions: SessionIndex,
    pub(crate) commands: HashMap<String, CommandReceipt>,
    pub(crate) command_keys: HashMap<String, String>,
    pub(crate) setup_pending: HashMap<String, oneshot::Sender<Reply>>,
    pub(crate) creates: HashMap<String, CreateReceipt>,
}

pub(crate) struct CommandReceipt {
    pub(crate) cloud_session_id: i64,
    pub(crate) local_session_id: u64,
    pub(crate) kind: String,
    pub(crate) payload: Value,
    pub(crate) status: String,
    pub(crate) expires_at: u64,
    pub(crate) updated_ms: u64,
    pub(crate) envelope: CloudEnvelope,
}

pub(crate) struct CreateReceipt {
    pub(crate) request_id: String,
    pub(crate) payload: String,
    pub(crate) result: Option<Reply>,
    pub(crate) created_ms: u64,
}

impl Device {
    pub(crate) fn new(name: String, now: u64) -> Self {
        Self {
            name,
            agent: None,
            boot_id: None,
            last_seen_ms: now,
            bus: broadcast::channel(512).0,
            ws_viewers: 0,
            lease_until_ms: 0,
            sync_enabled: false,
            snapshots: watch::channel(0).0,
            sessions: SessionIndex::default(),
            commands: HashMap::new(),
            command_keys: HashMap::new(),
            setup_pending: HashMap::new(),
            creates: HashMap::new(),
        }
    }

    pub(crate) fn wants_stream(&self, now: u64) -> bool {
        self.ws_viewers > 0 || now < self.lease_until_ms
    }

    pub(crate) fn publish(&self, envelope: CloudEnvelope) {
        let _ = self.bus.send(envelope);
    }

    /// Sends the viewer gate to the agent when it changed. Returns whether
    /// streaming just turned on, so callers can wait for the fresh snapshot.
    pub(crate) fn apply_stream_gate(&mut self, now: u64) -> bool {
        let wanted = self.wants_stream(now);
        if wanted == self.sync_enabled {
            return false;
        }
        let Some(agent) = &self.agent else {
            return false;
        };
        let frame = ServerFrame::BindingChanged {
            sync_enabled: wanted,
            binding_count: self.ws_viewers as u64,
        };
        if agent.tx.send(frame).is_err() {
            return false;
        }
        self.sync_enabled = wanted;
        if !wanted {
            // A stopped desktop no longer reports changes; the next enable
            // delivers a new authoritative snapshot.
            self.sessions.mark_stale();
        }
        wanted
    }
}

#[derive(Default)]
pub(crate) struct SessionIndex {
    next_id: i64,
    by_key: HashMap<(String, u64), i64>,
    entries: HashMap<i64, SessionEntry>,
}

pub(crate) struct SessionEntry {
    pub(crate) local_id: u64,
    pub(crate) dto: Value,
    pub(crate) live: bool,
}

/// Shared-runtime ids are stable across desktop restarts; ordinary ids are
/// reused by every boot and must be namespaced by it.
fn scope_for(boot_id: &str, local_id: u64) -> String {
    if local_id >= SHARED_RUNTIME_ID_FLOOR {
        "shared-runtime".into()
    } else {
        format!("boot:{boot_id}")
    }
}

impl SessionIndex {
    fn mark_stale(&mut self) {
        for entry in self.entries.values_mut() {
            entry.live = false;
        }
    }

    /// Applies an authoritative hello snapshot and returns the envelopes the
    /// phone needs to converge: exits first, then creates, then refreshes.
    pub(crate) fn apply_snapshot(
        &mut self,
        boot_id: &str,
        sessions: Vec<AgentSession>,
        now: u64,
    ) -> Vec<CloudEnvelope> {
        let previously_live: Vec<i64> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.live)
            .map(|(id, _)| *id)
            .collect();
        self.mark_stale();
        let mut present = HashSet::new();
        let mut created = Vec::new();
        let mut updated = Vec::new();
        for session in sessions {
            if session.dto["status"] == "exited" {
                continue;
            }
            let (cloud_id, was_created) = self.upsert(boot_id, session.local_id, session.dto);
            present.insert(cloud_id);
            let dto = self.entries[&cloud_id].dto.clone();
            if was_created {
                created.push(CloudEnvelope::new(cloud_id, "session.created", dto, now));
            } else {
                updated.push(CloudEnvelope::new(cloud_id, "session.updated", dto, now));
            }
        }
        let mut out: Vec<CloudEnvelope> = previously_live
            .into_iter()
            .filter(|id| !present.contains(id))
            .map(|id| CloudEnvelope::new(id, "session.exited", json!({}), now))
            .collect();
        out.extend(created);
        out.extend(updated);
        out
    }

    /// Inserts or refreshes one session and marks it live.
    pub(crate) fn upsert(&mut self, boot_id: &str, local_id: u64, mut dto: Value) -> (i64, bool) {
        let key = (scope_for(boot_id, local_id), local_id);
        let (cloud_id, created) = match self.by_key.get(&key) {
            Some(id) => (*id, false),
            None => {
                self.next_id += 1;
                self.by_key.insert(key.clone(), self.next_id);
                (self.next_id, true)
            }
        };
        if dto.is_object() {
            dto["id"] = json!(cloud_id);
        }
        self.entries.insert(
            cloud_id,
            SessionEntry {
                local_id,
                dto,
                live: true,
            },
        );
        (cloud_id, created)
    }

    pub(crate) fn cloud_id(&self, boot_id: &str, local_id: u64) -> Option<i64> {
        self.by_key
            .get(&(scope_for(boot_id, local_id), local_id))
            .copied()
    }

    /// A session the phone may act on: known, live, and not exited.
    pub(crate) fn live(&self, cloud_id: i64) -> Option<&SessionEntry> {
        self.entries
            .get(&cloud_id)
            .filter(|entry| entry.live && entry.dto["status"] != "exited")
    }

    pub(crate) fn live_dtos(&self) -> Vec<Value> {
        let mut ids: Vec<i64> = self
            .entries
            .iter()
            .filter(|(id, _)| self.live(**id).is_some())
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable_by(|a, b| b.cmp(a));
        ids.into_iter()
            .map(|id| self.entries[&id].dto.clone())
            .collect()
    }

    /// Translates a desktop event into the phone's id space and folds it into
    /// the session projection. Returns None for events the phone never sees.
    pub(crate) fn translate(
        &mut self,
        boot_id: &str,
        local_session_id: u64,
        event: kode_relay_protocol::AgentEnvelope,
    ) -> Option<CloudEnvelope> {
        if matches!(event.kind.as_str(), "pty_bytes" | "shell.pty_bytes") {
            return None;
        }
        let cloud_id = self.cloud_id(boot_id, local_session_id)?;
        let mut envelope = CloudEnvelope {
            protocol_version: event.protocol_version,
            schema_version: event.schema_version,
            session_id: cloud_id,
            ts: event.ts,
            kind: event.kind,
            payload: event.payload,
        };
        if matches!(
            envelope.kind.as_str(),
            "session.created" | "session.updated"
        ) {
            if !envelope.payload.is_object() {
                return None;
            }
            envelope.payload["id"] = json!(cloud_id);
        }
        if let Some(entry) = self.entries.get_mut(&cloud_id) {
            patch_dto(&mut entry.dto, &envelope);
            if envelope.kind == "session.exited" {
                entry.live = false;
            } else if matches!(
                envelope.kind.as_str(),
                "session.created" | "session.updated"
            ) {
                entry.live = entry.dto["status"] != "exited";
            }
        }
        Some(envelope)
    }

    /// Maps a desktop history page into phone ids for one session.
    pub(crate) fn translate_history(&self, cloud_id: i64, events: &[Value]) -> Vec<CloudEnvelope> {
        events
            .iter()
            .filter_map(|raw| {
                serde_json::from_value::<kode_relay_protocol::AgentEnvelope>(raw.clone()).ok()
            })
            .filter(|event| {
                !matches!(
                    event.kind.as_str(),
                    "pty_bytes" | "shell.pty_bytes" | "session.status"
                )
            })
            .map(|event| {
                let mut envelope = CloudEnvelope {
                    protocol_version: event.protocol_version,
                    schema_version: event.schema_version,
                    session_id: cloud_id,
                    ts: event.ts,
                    kind: event.kind,
                    payload: event.payload,
                };
                if matches!(
                    envelope.kind.as_str(),
                    "session.created" | "session.updated"
                ) && envelope.payload.is_object()
                {
                    envelope.payload["id"] = json!(cloud_id);
                }
                envelope
            })
            .collect()
    }
}

/// Folds an event into a session DTO. Mirrors kode-sync-server: `meta` is a
/// sparse update where JSON null means "unchanged".
fn patch_dto(dto: &mut Value, envelope: &CloudEnvelope) {
    match envelope.kind.as_str() {
        "session.created" | "session.updated" => *dto = envelope.payload.clone(),
        "meta" => {
            for field in ["title", "model", "context_pct", "cost_usd"] {
                if let Some(v) = envelope.payload.get(field).filter(|v| !v.is_null()) {
                    dto[field] = v.clone();
                }
            }
            if dto.get("tokens").is_none() {
                dto["tokens"] = json!({"total":0,"input":0,"output":0,"cached":0});
            }
            for (source, target) in [
                ("tokens", "total"),
                ("input_tokens", "input"),
                ("output_tokens", "output"),
                ("cached_tokens", "cached"),
            ] {
                if let Some(v) = envelope.payload.get(source).filter(|v| !v.is_null()) {
                    dto["tokens"][target] = v.clone();
                }
            }
        }
        "session.status" => {
            if let Some(v) = envelope.payload.get("status") {
                dto["status"] = v.clone();
            }
        }
        "session.exited" => dto["status"] = json!("exited"),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_relay_protocol::AgentEnvelope;

    fn session(local_id: u64, title: &str) -> AgentSession {
        AgentSession {
            local_id,
            dto: json!({"id": local_id, "title": title, "status": "idle"}),
        }
    }

    fn event(local: u64, kind: &str, payload: Value) -> AgentEnvelope {
        AgentEnvelope {
            protocol_version: "v1".into(),
            schema_version: 1,
            session_id: local,
            ts: 5,
            kind: kind.into(),
            payload,
        }
    }

    #[test]
    fn snapshots_allocate_ids_and_announce_vanished_sessions() {
        let mut index = SessionIndex::default();
        let first = index.apply_snapshot("boot-a", vec![session(1, "one"), session(2, "two")], 1);
        assert_eq!(
            first.iter().filter(|e| e.kind == "session.created").count(),
            2
        );
        let one = index.cloud_id("boot-a", 1).unwrap();
        let two = index.cloud_id("boot-a", 2).unwrap();
        assert_eq!(index.live(one).unwrap().dto["id"], json!(one));

        let second = index.apply_snapshot("boot-a", vec![session(2, "two")], 2);
        assert_eq!(second[0].kind, "session.exited");
        assert_eq!(second[0].session_id, one);
        assert_eq!(second[1].kind, "session.updated");
        assert!(index.live(one).is_none());
        assert_eq!(index.live_dtos().len(), 1);
        assert_eq!(index.live(two).unwrap().local_id, 2);
    }

    #[test]
    fn ordinary_ids_are_per_boot_but_shared_runtime_ids_are_stable() {
        let mut index = SessionIndex::default();
        let shared = SHARED_RUNTIME_ID_FLOOR + 3;
        index.apply_snapshot("boot-a", vec![session(1, "a"), session(shared, "s")], 1);
        let a = index.cloud_id("boot-a", 1).unwrap();
        let s = index.cloud_id("boot-a", shared).unwrap();
        index.apply_snapshot("boot-b", vec![session(1, "b"), session(shared, "s")], 2);
        assert_ne!(index.cloud_id("boot-b", 1).unwrap(), a);
        assert_eq!(index.cloud_id("boot-b", shared).unwrap(), s);
    }

    #[test]
    fn events_are_translated_patched_and_raw_terminal_frames_dropped() {
        let mut index = SessionIndex::default();
        index.apply_snapshot("boot", vec![session(4, "old")], 1);
        let id = index.cloud_id("boot", 4).unwrap();
        assert!(index
            .translate("boot", 4, event(4, "pty_bytes", json!({})))
            .is_none());
        assert!(index
            .translate("boot", 99, event(99, "message", json!({})))
            .is_none());

        let meta = index
            .translate(
                "boot",
                4,
                event(4, "meta", json!({"title": null, "model": "m1"})),
            )
            .unwrap();
        assert_eq!(meta.session_id, id);
        let dto = &index.live(id).unwrap().dto;
        assert_eq!(dto["title"], "old", "null meta fields are unchanged");
        assert_eq!(dto["model"], "m1");

        index.translate("boot", 4, event(4, "session.exited", json!({})));
        assert!(index.live(id).is_none());
    }
}
