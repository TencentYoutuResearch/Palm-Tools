//! Wire types for the desktop agent WebSocket and mobile event stream.
//!
//! `kode-sync-server` predates this crate and keeps its own private copy of
//! the same frames; the account relay and the desktop agent share these so the
//! two ends cannot drift. Field names and `type` tags are the contract in
//! `.specops/specs/cloud-sync-protocol.md` and `account-relay-protocol.md`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Local ids at or above this floor belong to shared runtimes. They survive
/// desktop restarts, so the center must not scope them by `boot_id`.
pub const SHARED_RUNTIME_ID_FLOOR: u64 = 1 << 40;

/// Setup request kind that asks the desktop for one session's history window.
pub const SETUP_KIND_HISTORY: &str = "history";

/// Event delivered to mobile clients over `/ws` and in `/history` responses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CloudEnvelope {
    pub protocol_version: String,
    pub schema_version: u32,
    pub session_id: i64,
    pub ts: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

impl CloudEnvelope {
    pub fn new(session_id: i64, kind: impl Into<String>, payload: Value, ts: u64) -> Self {
        Self {
            protocol_version: "v1".into(),
            schema_version: 1,
            session_id,
            ts,
            kind: kind.into(),
            payload,
        }
    }
}

/// Frames sent by the desktop agent to the center.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentFrame {
    #[serde(rename = "hello")]
    Hello {
        boot_id: String,
        sessions: Vec<AgentSession>,
    },
    #[serde(rename = "event")]
    Event {
        boot_id: String,
        local_session_id: u64,
        event: AgentEnvelope,
    },
    #[serde(rename = "setup.result")]
    SetupResult {
        request_id: String,
        boot_id: String,
        status: u16,
        body: Value,
    },
    #[serde(rename = "command.result")]
    CommandResult {
        command_id: String,
        status: String,
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub local_id: u64,
    pub dto: Value,
}

/// A desktop event as emitted by the local bus; `session_id` is the local id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEnvelope {
    #[serde(default = "default_protocol")]
    pub protocol_version: String,
    #[serde(default = "default_schema")]
    pub schema_version: u32,
    pub session_id: u64,
    pub ts: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

fn default_protocol() -> String {
    "v1".into()
}

fn default_schema() -> u32 {
    1
}

/// Frames sent by the center to the desktop agent.
///
/// For the account relay `binding_count` carries the number of active mobile
/// viewers; `sync_enabled` is true only while at least one viewer is present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerFrame {
    #[serde(rename = "server.hello")]
    Hello {
        sync_enabled: bool,
        binding_count: u64,
    },
    #[serde(rename = "pairing.bound")]
    PairingBound { binding_count: u64 },
    #[serde(rename = "binding.changed")]
    BindingChanged {
        sync_enabled: bool,
        binding_count: u64,
    },
    #[serde(rename = "setup.request")]
    SetupRequest {
        request_id: String,
        kind: String,
        payload: Value,
        expires_at: u64,
    },
    #[serde(rename = "command")]
    Command {
        command_id: String,
        local_session_id: u64,
        kind: String,
        payload: Value,
        expires_at: u64,
    },
    #[serde(rename = "pong")]
    Pong,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn server_frames_keep_the_sync_server_wire_tags() {
        let frame = ServerFrame::BindingChanged {
            sync_enabled: true,
            binding_count: 2,
        };
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            json!({"type":"binding.changed","sync_enabled":true,"binding_count":2})
        );
        let parsed: ServerFrame =
            serde_json::from_value(json!({"type":"pong"})).expect("pong frame");
        assert_eq!(parsed, ServerFrame::Pong);
    }

    #[test]
    fn agent_frames_accept_desktop_json() {
        let frame: AgentFrame = serde_json::from_value(json!({
            "type": "event",
            "boot_id": "boot-1",
            "local_session_id": 7,
            "event": {"session_id": 7, "ts": 1, "type": "message", "payload": {}}
        }))
        .expect("event frame");
        match frame {
            AgentFrame::Event { event, .. } => {
                assert_eq!(event.protocol_version, "v1");
                assert_eq!(event.kind, "message");
            }
            other => panic!("unexpected frame {other:?}"),
        }
        let result: AgentFrame = serde_json::from_value(json!({
            "type": "command.result", "command_id": "cmd_1", "status": "accepted"
        }))
        .expect("command result without error");
        assert!(matches!(
            result,
            AgentFrame::CommandResult { error: None, .. }
        ));
    }
}
