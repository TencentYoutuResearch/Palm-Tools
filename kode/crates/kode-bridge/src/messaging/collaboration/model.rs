use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Scope {
    pub home_hub: String,
    pub host_id: String,
    pub workspace_id: String,
    pub root_ref: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Kind {
    Channel,
    Dm,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SurfaceChange {
    pub request_id: String,
    pub expected_revision: u64,
    pub scope: Scope,
    pub kind: Kind,
    pub title: String,
    pub team_ids: Vec<String>,
    pub enabled: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Surface {
    pub id: String,
    pub scope: Scope,
    pub kind: Kind,
    pub title: String,
    pub team_ids: Vec<String>,
    pub revision: u64,
    pub audience_revision: u64,
    pub enabled: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Mention {
    pub team_id: String,
    pub team_revision: u64,
    pub worker_id: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Send {
    pub request_id: String,
    pub expected_revision: u64,
    pub thread_id: Option<String>,
    pub content: String,
    #[serde(default)]
    pub mentions: Vec<Mention>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive_selection: Option<crate::messaging::interactive_team::InteractiveSelection>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Publication {
    pub destination_id: String,
    pub destination_revision: u64,
    pub summary_sha256: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateTask {
    pub request_id: String,
    pub origin_surface_id: String,
    pub origin_message_id: String,
    pub origin_revision: u64,
    pub archive_surface_id: String,
    pub archive_revision: u64,
    pub team_id: String,
    pub team_revision: u64,
    pub summary: String,
    pub publication: Option<Publication>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Task {
    pub id: String,
    pub scope: Scope,
    pub origin_surface_id: String,
    pub origin_message_id: String,
    pub origin_revision: u64,
    pub archive_surface_id: String,
    pub archive_revision: u64,
    pub origin_audience_revision: u64,
    pub archive_audience_revision: u64,
    pub thread_id: String,
    pub team_id: String,
    pub team_revision: u64,
    pub summary: String,
    pub revision: u64,
    /// Scope amendments only; discussion/CAS revisions must not revoke a running task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_revision: Option<u64>,
    pub state: String,
    pub dispatch_state: String,
    pub context_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_run_id: Option<String>,
    pub created_at: u64,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Action {
    Question,
    Supplement,
    Pause,
    Cancel,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Command {
    pub request_id: String,
    pub expected_revision: u64,
    pub source_surface_id: String,
    pub action: Action,
    pub content: Option<String>,
    pub publication: Option<Publication>,
    pub worker_id: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Page {
    #[serde(default)]
    pub after: u64,
    pub limit: Option<usize>,
    pub thread_id: Option<String>,
}
