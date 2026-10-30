//! Durable messaging vocabulary. Runtime numeric ids never cross node boundaries.
use serde::{Deserialize, Serialize};

pub const MAX_CONTENT_BYTES: usize = 64 * 1024;
pub const MAX_PENDING: usize = 256;
pub const LEASE_MS: u64 = 60_000;
pub fn now() -> u64 {
    crate::now_ms()
}
pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Address {
    pub node_id: String,
    pub session_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Queued,
    Received,
    Delivering,
    Accepted,
    Uncertain,
    Rejected,
    Expired,
}
impl Status {
    pub fn terminal(&self) -> bool {
        matches!(
            self,
            Self::Accepted | Self::Uncertain | Self::Rejected | Self::Expired
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub id: String,
    pub source: Address,
    pub target: Address,
    pub content: String,
    pub idempotency_key: String,
    pub in_reply_to: Option<String>,
    /// Bounds automatic reply chains across runtimes.
    #[serde(default)]
    pub hop_count: u16,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: Status,
    pub detail: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendRequest {
    /// Administrators select a registered source; session credentials bind it instead.
    pub source: Option<String>,
    pub target: Address,
    pub content: String,
    pub idempotency_key: String,
    pub in_reply_to: Option<String>,
    #[serde(default = "default_ttl")]
    pub ttl_seconds: u64,
}
fn default_ttl() -> u64 {
    86400
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionInfo {
    pub address: Address,
    pub title: String,
    pub runtime: String,
    pub online: bool,
    pub updated_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterRequest {
    pub session_id: String,
    pub title: String,
    #[serde(default = "default_runtime")]
    pub runtime: String,
    /// Fences stale owners. Re-registration must present this token.
    pub owner_token: Option<String>,
}
fn default_runtime() -> String {
    "dsh".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registration {
    pub session: SessionInfo,
    pub owner_token: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub message: Message,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Frame {
    WorkspaceRequest { id: String, command: super::workspaces::Command },
    WorkspaceResponse { id: String, value: Option<serde_json::Value>, error: Option<String> },
    Hello {
        node_id: String,
        version: u32,
    },
    Directory {
        sessions: Vec<SessionInfo>,
    },
    Message {
        message: Message,
    },
    Receipt {
        id: String,
        status: Status,
        detail: Option<String>,
    },
}
