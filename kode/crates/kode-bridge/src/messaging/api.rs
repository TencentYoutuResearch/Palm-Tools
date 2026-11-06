//! Administration uses the existing bridge bearer. Agent credentials are session-scoped.
use super::{model::*, Hub};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub(super) struct Error(pub(super) StatusCode, pub(super) String);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        tracing::debug!(error=%e,"messaging request rejected");
        Self(StatusCode::BAD_REQUEST, e.to_string())
    }
}
type Result<T> = std::result::Result<T, Error>;
#[derive(Clone)]
enum Principal {
    Admin,
    Session(String),
}
fn auth(hub: &Hub, headers: &HeaderMap) -> Result<Principal> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "unauthorized".into()))?;
    if hub
        .ctx
        .upgrade()
        .is_some_and(|ctx| crate::constant_eq(token, &ctx.token))
    {
        return Ok(Principal::Admin);
    }
    hub.store
        .principal(token)?
        .map(Principal::Session)
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "unauthorized".into()))
}
fn admin(hub: &Hub, h: &HeaderMap) -> Result<()> {
    match auth(hub, h)? {
        Principal::Admin => Ok(()),
        _ => Err(Error(
            StatusCode::FORBIDDEN,
            "administrator required".into(),
        )),
    }
}
fn owner(hub: &Hub, h: &HeaderMap, id: &str) -> Result<()> {
    match auth(hub, h)? {
        Principal::Admin => Ok(()),
        Principal::Session(s) if s == id => Ok(()),
        _ => Err(Error(StatusCode::FORBIDDEN, "foreign session".into())),
    }
}
pub(super) fn router(hub: Arc<Hub>) -> Router {
    Router::new()
        .route("/api/v1/messaging/workbench/agent-hub", get(agent_hub).post(change_agent_hub))
        .route("/api/v1/messaging/workbench/handoff", post(handoff))
        .route("/api/v1/messaging/model-usage", get(model_usage))
        .route("/api/v1/messaging/integrations", get(integration_status).post(integration_configure))
        .route("/api/v1/messaging/memory/tool", post(memory_tool))
        .route("/api/v1/messaging/cloud/status", get(cloud_status))
        .route("/api/v1/messaging/cloud/pair", post(cloud_pair))
        .route("/api/v1/messaging/cloud/activate", post(cloud_activate))
        .route("/api/v1/messaging/cloud/backend", post(cloud_backend))
        .route(
            "/api/v1/messaging/runtime/publish",
            post(runtime_publish).layer(axum::extract::DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/api/v1/messaging/runtime/claim", post(runtime_claim))
        .route("/api/v1/messaging/runtime/release", post(runtime_release))
        .route("/api/v1/messaging/runtime/settle", post(runtime_settle))
        .route("/api/v1/messaging/runtime/command", post(runtime_command))
        .route("/api/v1/messaging/runtime/sessions", get(runtime_sessions))
        .route("/api/v1/messaging/runtime/history", get(runtime_history))
        .route(
            "/api/v1/messaging/workbench/communication-health",
            get(communication_health),
        )
        .route(
            "/api/v1/messaging/sessions/:id/diagnostics",
            get(session_diagnostics),
        )
        .route("/api/v1/messaging/node", get(node))
        .route("/api/v1/messaging/workbench/peers", post(add_peer))
        .route(
            "/api/v1/messaging/workbench/peers/remove",
            post(remove_peer),
        )
        .route(
            "/api/v1/messaging/workbench/catalog",
            get(workbench_catalog),
        )
        .route(
            "/api/v1/messaging/workbench/agents",
            get(agent_catalog).post(change_agent),
        )
        .route(
            "/api/v1/messaging/workbench/sessions",
            get(workbench_sessions),
        )
        .route(
            "/api/v1/messaging/workbench/workspaces",
            get(workspaces).post(change_workspace),
        )
        .route(
            "/api/v1/messaging/workbench/workspaces/hosts",
            get(workspace_hosts),
        )
        .route(
            "/api/v1/messaging/workbench/transcript",
            post(workbench_transcript),
        )
        .route(
            "/api/v1/messaging/workbench/documents/:key",
            get(workbench_document).post(save_workbench_document),
        )
        .route("/api/v1/messaging/self", get(own_session))
        .route("/api/v1/messaging/native/resolve", post(resolve_native))
        .route(
            "/api/v1/messaging/native/:id/credential",
            post(native_credential),
        )
        .route("/api/v1/messaging/sessions", get(directory).post(register))
        .route("/api/v1/messaging/sessions/:id/heartbeat", post(heartbeat))
        .route("/api/v1/messaging/sessions/:id/title", post(update_title))
        .route("/api/v1/messaging/sessions/:id/offline", post(offline))
        .route("/api/v1/messaging/sessions/:id/claim", post(claim))
        .route("/api/v1/messaging/sessions/:id/pending", get(pending))
        .route("/api/v1/messaging/messages", post(send))
        .route("/api/v1/messaging/messages/:id", get(message).post(settle))
        .route(
            "/api/v1/messaging/messages/:id/delivery",
            get(delivery).post(observe_delivery),
        )
        .route(
            "/api/v1/messaging/sessions/:id/deliveries",
            get(pending_deliveries),
        )
        .route(
            "/api/v1/messaging/messages/:id/cancellation",
            get(cancellation).post(request_cancellation),
        )
        .route(
            "/api/v1/messaging/messages/:id/cancellation/result",
            post(report_cancellation),
        )
        .route(
            "/api/v1/messaging/sessions/:id/cancellations",
            get(pending_cancellations),
        )
        .route("/api/v1/messaging/events", get(events))
        .route("/api/v1/messaging/lifecycle-events", get(lifecycle_events))
        .route("/api/v1/messaging/resource-binding", get(resource_binding))
        .route(
            "/api/v1/messaging/resource-binding/invalidate",
            post(invalidate_resource_binding),
        )
        .route(
            "/api/v1/messaging/capability-profiles",
            post(save_capability_profile),
        )
        .route(
            "/api/v1/messaging/capability-profiles/:id/:revision",
            get(read_capability_profile),
        )
        .route("/api/v1/messaging/price-versions", post(create_price))
        .route("/api/v1/messaging/price-versions/:id", get(read_price))
        .route(
            "/api/v1/messaging/budget-reservations/:id/pricing",
            post(bind_price),
        )
        .route("/api/v1/messaging/metered-usage", post(record_usage))
        .route("/api/v1/messaging/metered-usage/:id", get(usage_receipt))
        .route("/api/v1/messaging/teams/:id/scheduling-options/:revision", get(team_scheduling_options))
        .route("/api/v1/messaging/teams/:id/scheduling", post(configure_team_scheduling))
        .route("/api/v1/messaging/teams/:id/capability-update", post(update_team_capability))
        .route("/api/v1/messaging/teams/:id/capability-update-requests/:request", get(team_capability_update_receipt))
        .route("/api/v1/messaging/teams/:id/scheduling-requests/:request", get(team_scheduling_receipt))
        .route("/api/v1/messaging/teams/:id/authority", post(configure_team_authority))
        .route("/api/v1/messaging/teams/:id/authority-requests/:request_id", get(read_team_authority_receipt))
        .route("/api/v1/messaging/teams/:id/resources", post(configure_team_resource))
        .route("/api/v1/messaging/teams/:id/resource-requests/:request_id", get(read_team_resource_receipt))
        .route("/api/v1/messaging/budgets", post(configure_budget))
        .route("/api/v1/messaging/teams/:id/budgets", post(configure_team_budget))
        .route("/api/v1/messaging/teams/:id/budget-requests/:request_id", get(read_team_budget_receipt))
        .route("/api/v1/messaging/budgets/:id", get(read_budget))
        .route("/api/v1/messaging/budgets/:id/events", get(budget_events))
        .route(
            "/api/v1/messaging/budgets/:id/reservations",
            get(budget_reservations),
        )
        .route(
            "/api/v1/messaging/budget-reservations/:id",
            get(budget_reservation),
        )
        .route(
            "/api/v1/messaging/budget-reservations/:id/settlements/:event",
            get(budget_settlement),
        )
        .route(
            "/api/v1/messaging/budget-reservations",
            post(reserve_budget),
        )
        .route(
            "/api/v1/messaging/budget-reservations/:id/settle",
            post(settle_budget),
        )
        .route(
            "/api/v1/messaging/quota-snapshots",
            get(quota_snapshot).post(record_quota),
        )
        .route(
            "/api/v1/messaging/tool-resolutions",
            post(resolve_tool_evidence),
        )
        .route("/api/v1/messaging/team-grants", post(write_team_grant))
        .route(
            "/api/v1/messaging/team-grants/:id/check",
            post(check_team_grant),
        )
        .route("/api/v1/messaging/team-grants/:id", get(team_grant))
        .route(
            "/api/v1/messaging/tool-evidence",
            post(record_tool_evidence),
        )
        .route(
            "/api/v1/messaging/verification-records/:sequence",
            get(verification_record)
                .post(archive_verification_record)
                .layer(axum::extract::DefaultBodyLimit::max(4 * 1024 * 1024)),
        )
        .route(
            "/api/v1/messaging/artifact-archives/:sequence",
            get(artifact_archive),
        )
        .route(
            "/api/v1/messaging/artifact-archives/:sequence/complete",
            post(complete_artifact_archive),
        )
        .route(
            "/api/v1/messaging/artifact-archives/:sequence/chunks/:index",
            get(artifact_archive_chunk)
                .post(put_artifact_chunk)
                .layer(axum::extract::DefaultBodyLimit::max(384 * 1024)),
        )
        .route(
            "/api/v1/messaging/artifact-evidence",
            post(record_artifact_evidence),
        )
        .route(
            "/api/v1/messaging/selection-evidence",
            post(record_selection_evidence),
        )
        .route(
            "/api/v1/messaging/official-calls",
            post(begin_official_call),
        )
        .route("/api/v1/messaging/official-calls/:id", get(official_call))
        .route(
            "/api/v1/messaging/official-calls/:id/events",
            get(official_call_events).post(record_official_call),
        )
        .route(
            "/api/v1/messaging/resource-accounts",
            post(change_resource_account),
        )
        .route(
            "/api/v1/messaging/resource-accounts/:id",
            get(resource_account),
        )
        .route(
            "/api/v1/messaging/resource-bindings",
            get(resource_bindings).post(bind_resource_account),
        )
        .route(
            "/api/v1/messaging/operation-bundles",
            post(prepare_operation_bundle),
        )
        .route(
            "/api/v1/messaging/operation-bundles/:id/abandon",
            post(abandon_operation_bundle),
        )
        .route("/api/v1/messaging/operations", post(prepare_operation))
        .route(
            "/api/v1/messaging/operation-accounting-relay/:node",
            post(relay_accounting),
        )
        .route(
            "/api/v1/messaging/operation-relay/:node",
            post(relay_operation),
        )
        .route(
            "/api/v1/messaging/operations/:id",
            get(operation).post(command_operation),
        )
        .route(
            "/api/v1/messaging/resource-admission",
            post(resource_admission),
        )
        .route("/api/v1/messaging/resources/rank", post(rank_resources))
        .route(
            "/api/v1/messaging/work-assignments/:id/admit",
            post(admit_work_assignment),
        )
        .route(
            "/api/v1/messaging/assignment-capacities",
            post(configure_assignment_capacity),
        )
        .route(
            "/api/v1/messaging/assignment-capacities/:id",
            get(read_assignment_capacity),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/resources",
            post(reserve_assignment_resources),
        )
        .route(
            "/api/v1/messaging/assignment-dispatches",
            get(pending_assignment_dispatches),
        )
        .route(
            "/api/v1/messaging/assignment-dispatches/remote/:node",
            get(remote_assignment_dispatches),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/creation",
            post(assignment_creation_receipt),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/workspace-scope",
            post(authorize_assignment_workspace),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/workspace-receipt",
            post(assignment_workspace_receipt),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/task-workspace/prepare",
            post(prepare_assignment_task_workspace),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/task-workspace",
            post(assignment_task_workspace),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/accounting",
            post(finalize_assignment_accounting),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/stop-receipt",
            post(assignment_stop_receipt),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/mandate",
            post(enqueue_assignment_mandate),
        )
        .route(
            "/api/v1/messaging/work-runs/:id/stages/:stage/complete",
            post(complete_work_stage),
        )
        .route(
            "/api/v1/messaging/work-runs/:id/stages/:stage/evidence",
            post(select_stage_evidence),
        )
        .route("/api/v1/messaging/team-policies", post(write_team_policy))
        .route("/api/v1/messaging/team-policies/:id", get(read_team_policy))
        .route("/api/v1/messaging/work-runs", post(create_work_run))
        .route("/api/v1/messaging/work-runs/active", get(active_work_runs))
        .route(
            "/api/v1/messaging/work-runs/:id/schedule",
            post(schedule_work_run),
        )
        .route("/api/v1/messaging/work-runs/:id/delivery-decision", post(decide_work_delivery))
        .route(
            "/api/v1/messaging/work-runs/:id/delivery",
            post(finalize_work_delivery),
        )
        .route(
            "/api/v1/messaging/work-runs/:id",
            get(read_work_run).post(command_work_run),
        )
        .route("/api/v1/messaging/work-runs/:id/commands/:request", get(work_run_command_receipt))
        .route("/api/v1/messaging/work-runs/:id/trace", get(work_run_trace))
        .route("/api/v1/messaging/work-runs/:id/accounting-status", get(work_run_accounting_status))
        .route("/api/v1/messaging/work-runs/:id/diagnostics", get(work_run_diagnostics))
        .route(
            "/api/v1/messaging/work-runs/:id/events",
            get(work_run_events),
        )
        .route(
            "/api/v1/messaging/work-runs/:id/stages/:stage/plan",
            get(work_run_stage_plan),
        )
        .route(
            "/api/v1/messaging/work-runs/:id/stages/:stage/assignments",
            post(prepare_work_assignment),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id",
            get(read_work_assignment),
        )
        .route(
            "/api/v1/messaging/work-assignments/:id/abandon",
            post(abandon_work_assignment),
        )
        .route("/api/v1/messaging/work-assignments/:id/clarification-answers", post(answer_assignment_clarification))
        .route("/api/v1/messaging/work-assignments/:id/clarification-answers/:request", get(read_assignment_answer))
        .route("/api/v1/messaging/work-assignments/:id/clarifications", post(record_assignment_clarification))
        .route("/api/v1/messaging/work-assignments/:id/clarifications/:request", get(read_assignment_clarification))
        .route("/api/v1/messaging/teams", get(list_teams).post(save_team))
        .route(
            "/api/v1/messaging/superagents/drafts",
            get(list_builder_drafts)
                .post(save_builder_draft)
                .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/v1/messaging/superagents/drafts/:id",
            get(read_builder_draft),
        )
        .route(
            "/api/v1/messaging/superagents/drafts/:id/commands/:request",
            get(read_builder_draft_command),
        )
        .route(
            "/api/v1/messaging/superagents/drafts/:id/policy-details",
            post(builder_policy_details),
        )
        .route(
            "/api/v1/messaging/superagents/drafts/:id/accept-proposal",
            post(accept_builder_proposal),
        )
        .route(
            "/api/v1/messaging/superagents/drafts/:id/acceptances/:request",
            get(builder_acceptance),
        )
        .route(
            "/api/v1/messaging/superagents/drafts/:id/catalog",
            post(builder_catalog),
        )
        .route(
            "/api/v1/messaging/superagents/drafts/:id/preflight",
            post(builder_preflight),
        )
        .route(
            "/api/v1/messaging/operations/:id/builder-scope",
            get(read_builder_scope).post(bind_builder_scope),
        )
        .route(
            "/api/v1/messaging/superagents/builder-starts",
            post(prepare_builder_start),
        )
        .route("/api/v1/messaging/operations/:id/builder-accounting", post(finalize_builder_accounting))
        .route("/api/v1/messaging/operations/:id/coordinator-accounting", post(finalize_coordinator_accounting))
        .route("/api/v1/messaging/operations/:id/coordinator-close", get(read_coordinator_close).post(begin_coordinator_close))
        .route("/api/v1/messaging/coordinator-closes/pending", get(pending_coordinator_closes))
        .route("/api/v1/messaging/operations/:id/builder-close", get(read_builder_close).post(begin_builder_close))
        .route(
            "/api/v1/messaging/operations/:id/builder-continue",
            post(continue_builder_answers),
        )
        .route(
            "/api/v1/messaging/operations/:id/builder-inputs",
            post(enqueue_builder_input),
        )
        .route(
            "/api/v1/messaging/operations/:id/builder-inputs/:request",
            get(read_builder_input),
        )
        .route(
            "/api/v1/messaging/superagents/drafts/:id/answers",
            post(answer_builder_draft),
        )
        .route(
            "/api/v1/messaging/workflows/validate",
            post(validate_workflow),
        )
        .route(
            "/api/v1/messaging/workflows/check-evidence",
            post(check_workflow_evidence),
        )
        .route("/api/v1/messaging/workflows", post(save_workflow))
        .route(
            "/api/v1/messaging/project-configs",
            post(save_project_config),
        )
        .route(
            "/api/v1/messaging/project-configs/:id/versions/:version",
            get(read_project_config),
        )
        .route(
            "/api/v1/messaging/project-configs/:id/events",
            get(project_config_events),
        )
        .route(
            "/api/v1/messaging/workflows/:id/versions/:version",
            get(read_workflow),
        )
        .route(
            "/api/v1/messaging/workflows/:id/events",
            get(workflow_events),
        )
        .route(
            "/api/v1/messaging/teams/:id/activation",
            get(read_team_activation).post(change_team_activation),
        )
        .route(
            "/api/v1/messaging/teams/:id/activation-receipts/:request_id",
            get(read_team_activation_receipt),
        )
        .route("/api/v1/messaging/teams/:id", get(read_team))
        .route("/api/v1/messaging/contact-directory", get(contact_directory))
        .route("/api/v1/messaging/teams/:id/contact-preference", get(contact_preference).post(change_contact_preference))
        .route("/api/v1/messaging/teams/:id/contact-preference-requests/:request", get(contact_preference_request))
        .route("/api/v1/messaging/teams/:id/work-runs", get(team_work_runs))
        .route("/api/v1/messaging/superagents/drafts/:id/workspaces", post(set_builder_workspaces))
        .route("/api/v1/messaging/superagents/drafts/:id/account", post(confirm_builder_account))
        .route("/api/v1/messaging/superagents/drafts/:id/account-requests/:request", get(builder_account_receipt))
        .route("/api/v1/messaging/superagents/drafts/:id/funding", get(builder_funding).post(confirm_builder_funding))
        .route("/api/v1/messaging/superagents/drafts/:id/selection", get(builder_selection).post(save_builder_selection))
        .route("/api/v1/messaging/superagents/drafts/:id/patch-status", get(builder_patch_status))
        .route("/api/v1/messaging/work-runs/:id/stages/:stage/outputs/:output", get(selected_stage_output))
        .route("/api/v1/messaging/work-runs/:id/stages/:stage/waiver-plan", get(stage_waiver_plan))
        .route("/api/v1/messaging/work-runs/:id/stages/:stage/waiver", post(waive_stage))
        .route("/api/v1/messaging/work-runs/:id/stages/:stage/waiver-requests/:request", get(stage_waiver_receipt))
        .route("/api/v1/messaging/teams/:id/events", get(team_events))
        .route(
            "/api/v1/messaging/teams/:id/revisions/:revision",
            get(read_team_revision),
        )
        .route("/api/v1/messaging/conversations/:id/read-state", get(conversation_read_state).post(mark_conversation_read))
        .route(
            "/api/v1/messaging/conversations/:id/messages",
            get(conversation_messages).post(send_conversation_message),
        )
        .route(
            "/api/v1/messaging/conversations/:id/requests/:request",
            get(conversation_request),
        )
        .route(
            "/api/v1/messaging/conversations/:id/pending-inputs",
            get(pending_conversation_inputs),
        )
        .route(
            "/api/v1/messaging/conversations/:conversation/messages/:message/coordinator-input",
            get(read_coordinator_input).post(dispatch_coordinator_input),
        )
        .route("/api/v1/messaging/teams/:id/coordinator-transfers/pending",get(pending_coordinator_transfers))
        .route("/api/v1/messaging/work-runs/:id/coordinator-transfer",post(transfer_coordinator_run))
        .route("/api/v1/messaging/conversations/:conversation/messages/:message/reply-authorities/:revision",get(read_coordinator_reply_authority))
        .route(
            "/api/v1/messaging/teams/:id/coordinator-recovery",
            get(read_coordinator_recovery),
        )
        .route(
            "/api/v1/messaging/teams/:id/coordinator-control",
            get(read_coordinator_control).post(bind_coordinator_control),
        )
        .route(
            "/api/v1/messaging/teams/:id/coordinator-starts",
            post(prepare_coordinator_start),
        )
        .route(
            "/api/v1/messaging/coordinator-updates/pending",
            get(pending_coordinator_updates),
        )
        .route(
            "/api/v1/messaging/work-runs/:id/coordinator-updates",
            post(queue_coordinator_update),
        )
        .route(
            "/api/v1/messaging/work-runs/:id/coordinator-updates/:revision",
            get(read_coordinator_update),
        )
        .route(
            "/api/v1/messaging/conversations/:id/work-runs",
            post(start_coordinator_run),
        )
        .route(
            "/api/v1/messaging/conversations/:id/work-runs/requests/:request",
            get(coordinator_run_receipt),
        )
        .route(
            "/api/v1/messaging/conversations/:id/coordinator-replies",
            post(publish_coordinator_reply),
        )
        .route(
            "/api/v1/messaging/conversations/:id/coordinator-replies/:request",
            get(read_coordinator_reply),
        )
        .route(
            "/api/v1/messaging/teams/:id/activation-review",
            post(review_team_activation),
        )
        .route(
            "/api/v1/messaging/teams/:id/revisions/:revision/workflow-preflight",
            get(team_workflow_preflight),
        )
        .route(
            "/api/v1/messaging/monetary-quota",
            get(read_monetary_quota).post(record_monetary_quota),
        )
        .route(
            "/api/v1/messaging/operations/:id/grant",
            get(operation_grant_context).post(attach_operation_grant),
        )
        .route(
            "/api/v1/messaging/operations/:id/resource",
            post(attach_operation_resource),
        )
        .route(
            "/api/v1/messaging/operations/:id/budget",
            post(attach_operation_budget).get(operation_accounting),
        )
        .route(
            "/api/v1/messaging/operations/:id/events",
            get(operation_events),
        )
        .route("/api/v1/messaging/link", get(super::link::upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(128 * 1024))
        .with_state(hub)
}
async fn node(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    auth(&hub, &h)?;
    let (executable, built_at) = server_binary();
    Ok(Json(json!({"node_id":hub.node_id(),"protocol_version":1,"managed_peers":true,"delivery_tracking":true,"input_cancellation":true,"lifecycle_events":true,"messaging_schema_version":super::migrations::VERSION,
        "pid":std::process::id(),"executable":executable,"built_at":built_at})))
}
/// Executable path and its modification time (Unix seconds), so a host app
/// can replace a service started from an older build.
pub fn server_binary() -> (Option<String>, Option<u64>) {
    static BINARY: std::sync::OnceLock<(Option<String>, Option<u64>)> = std::sync::OnceLock::new();
    BINARY
        .get_or_init(|| {
            let path = std::env::current_exe().ok();
            let built_at = path
                .as_ref()
                .and_then(|path| std::fs::metadata(path).ok()?.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|age| age.as_secs());
            (path.map(|path| path.to_string_lossy().into_owned()), built_at)
        })
        .clone()
}
// The standalone session server exposes the same collector as the full bridge.
async fn model_usage(State(hub): State<Arc<Hub>>, h: HeaderMap, Query(query): Query<crate::model_usage::ModelUsageQuery>) -> Response {
    if let Err(error) = admin(&hub, &h) { return error.into_response(); }
    crate::get_model_usage(Query(query)).await.into_response()
}
async fn add_peer(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(peer): Json<super::Peer>) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let node_id = peer.node_id.clone();
    hub.add_peer(peer)?;
    Ok(Json(json!({"node_id":node_id})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PeerRemoval {
    node_id: String,
}
async fn remove_peer(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<PeerRemoval>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    hub.remove_peer(&input.node_id)?;
    Ok(Json(json!({"removed":true})))
}
fn document_key(key: &str) -> Result<()> {
    let builder_setup = key.strip_prefix("builder-workflow-").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    });
    if !builder_setup && !matches!(key, "agents" | "ssh-hosts" | "session-index" | "workspaces") {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "unknown workbench document".into(),
        ));
    }
    Ok(())
}
async fn workbench_document(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    document_key(&key)?;
    if key == "workspaces" {
        return Ok(Json(
            tokio::task::spawn_blocking(move || {
                let _gate = hub.gate.lock();
                super::workspaces::ensure(&hub)
            })
            .await
            .map_err(anyhow::Error::from)??,
        ));
    }
    Ok(Json(hub.store.document(&key)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentUpdate {
    expected_revision: u64,
    value: serde_json::Value,
}
async fn save_workbench_document(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(key): Path<String>,
    Json(update): Json<DocumentUpdate>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    document_key(&key)?;
    if key == "workspaces" {
        super::workspaces::validate(&update.value)?;
    }
    if key == "agents" {
        return Ok(Json(
            tokio::task::spawn_blocking(move || {
                let _gate = hub.gate.lock();
                super::agents::save(&hub, update.expected_revision, update.value)
            })
            .await
            .map_err(anyhow::Error::from)??,
        ));
    }
    Ok(Json(hub.store.save_document(
        &key,
        update.expected_revision,
        update.value,
    )?))
}
async fn agent_catalog(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
) -> Result<Json<super::agents::Catalog>> {
    admin(&hub, &h)?;
    Ok(Json(
        tokio::task::spawn_blocking(move || super::agents::catalog(&hub))
            .await
            .map_err(anyhow::Error::from)??,
    ))
}
async fn change_agent(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(command): Json<super::agents::Change>,
) -> Result<Json<super::agents::Catalog>> {
    admin(&hub, &h)?;
    Ok(Json(
        tokio::task::spawn_blocking(move || {
            let _gate = hub.gate.lock();
            super::agents::change(&hub, command)
        })
        .await
        .map_err(anyhow::Error::from)??,
    ))
}
#[derive(Deserialize)]
struct WorkspaceNode {
    node_id: Option<String>,
}
async fn workspaces(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(query): Query<WorkspaceNode>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        hub.workspace(
            query.node_id.as_deref().unwrap_or(""),
            super::workspaces::Command::List,
        )
        .await?,
    ))
}
#[derive(Deserialize)]
struct WorkspaceChange {
    node_id: Option<String>,
    #[serde(flatten)]
    command: super::workspaces::Command,
}
async fn change_workspace(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<WorkspaceChange>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        hub.workspace(input.node_id.as_deref().unwrap_or(""), input.command)
            .await?,
    ))
}
async fn workspace_hosts(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        json!({"local_node_id":hub.node_id(),"hosts":hub.peers().iter().map(|peer| json!({"node_id":peer.node_id,"ssh_host":peer.ssh.as_ref().map(|ssh| &ssh.host)})).collect::<Vec<_>>()}),
    ))
}
async fn workbench_sessions(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(super::session_catalog::federated(hub).await?))
}
async fn workbench_catalog(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let state_path = std::env::var_os("KODE_GUI_STATE_PATH")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::config_dir().map(|path| path.join("kode/state.json")));
    let mut state = match state_path {
        Some(path) => match tokio::fs::read(path).await {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|error| {
                Error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("cannot read Kode saved state: {error}"),
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
            Err(error) => {
                return Err(Error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("cannot read Kode saved state: {error}"),
                ))
            }
        },
        None => serde_json::json!({}),
    };
    let document = hub.store.document("session-index")?;
    if let Some(gui) = document
        .pointer("/value/gui")
        .and_then(|value| value.as_object())
    {
        if let Some(state) = state.as_object_mut() {
            for (key, value) in gui {
                state.insert(key.clone(), value.clone());
            }
        }
    }
    let mut tabs = state["tabs"].as_array().cloned().unwrap_or_default();
    let mut offset = 0;
    loop {
        let page = super::workspaces::execute(
            hub.clone(),
            super::workspaces::Command::SessionCatalog { offset },
        )
        .await?;
        for tab in page["tabs"].as_array().into_iter().flatten() {
            if let Some(index) = tabs.iter().position(|row| {
                (row["endpoint_id"].is_null() || row["endpoint_id"]["kind"] == "local")
                    && row["session_id"] == tab["session_id"]
                    && row["backend_key"] == tab["backend_key"]
            }) {
                if let (Some(row), Some(native)) = (tabs[index].as_object_mut(), tab.as_object()) {
                    row.extend(native.clone());
                }
            } else {
                tabs.push(tab.clone());
            }
        }
        if let Some(next) = page["next_offset"].as_u64() {
            offset = next as usize
        } else {
            break;
        }
    }
    let workspace_document = hub.store.document("workspaces")?;
    let archived = workspace_document
        .pointer("/value/global/archivedSessionIds")
        .and_then(serde_json::Value::as_array);
    tabs.retain(|tab| {
        if !tab["endpoint_id"].is_null() && tab["endpoint_id"]["kind"]!="local" {return true}
        let native=document.pointer("/value/native_sessions").and_then(serde_json::Value::as_array).and_then(|rows|rows.iter().find(|row|row["session_id"]==tab["session_id"] && row["backend_key"]==tab["backend_key"]));
        let id=tab["dsh_session_id"].as_str().or_else(||native.and_then(|row|row["dsh_session_id"].as_str()));
        !super::session_catalog::is_archived_local(tab, archived)
            && !id.is_some_and(|id|archived.is_some_and(|rows|rows.iter().any(|row|row.as_str()==Some(id))))
    });
    let agents = super::agents::catalog(&hub)?;
    let backends = serde_json::to_value(&agents.backends).map_err(anyhow::Error::from)?;
    Ok(Json(
        serde_json::json!({"node_id":hub.node_id(),"tabs":tabs,"endpoints":state.get("endpoints").cloned().unwrap_or(serde_json::json!([])),"session_titles":state.get("session_titles").cloned().unwrap_or(serde_json::json!({})),"backends":backends,"agent_ids":agents.ids}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedTranscript {
    backend_key: String,
    session_id: String,
    cwd: String,
    limit: Option<usize>,
    tail_bytes: Option<usize>,
    before: Option<i64>,
}
async fn workbench_transcript(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<SavedTranscript>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    if !valid_id(&input.session_id) || !std::path::Path::new(&input.cwd).is_absolute() {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid saved session".into(),
        ));
    }
    let catalog = super::agents::catalog(&hub)?;
    let protocol = catalog
        .backends
        .get(&input.backend_key)
        .map(|config| config.protocol_key(&input.backend_key))
        .unwrap_or(&input.backend_key);
    let backend =
        kode_core::session::jsonl_tail::Backend::from_backend_key(protocol).ok_or_else(|| {
            Error(
                StatusCode::BAD_REQUEST,
                "unsupported transcript format".into(),
            )
        })?;
    let messages = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let Some(path) = kode_core::session::jsonl_tail::resolve_session_path(
            backend,
            std::path::Path::new(&input.cwd),
            &input.session_id,
        ) else {
            return Ok(json!({"messages":[],"available":false}));
        };
        super::transcript::recent_before(
            &path,
            input.limit.unwrap_or(80).clamp(1, 1000),
            input
                .tail_bytes
                .unwrap_or(8 * 1024 * 1024)
                .clamp(4096, 64 * 1024 * 1024),
            input.before,
        )
    })
    .await
    .map_err(anyhow::Error::from)??;
    Ok(Json(messages))
}
async fn own_session(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    let Principal::Session(id) = auth(&hub, &h)? else {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "session credential required".into(),
        ));
    };
    Ok(Json(
        json!({"address":Address{node_id:hub.node_id().into(),session_id:id}}),
    ))
}
async fn native_credential(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<u64>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let live = hub
        .ctx
        .upgrade()
        .is_some_and(|ctx| ctx.sessions.lock().contains_key(&id) || ctx.runtimes.contains(id));
    if !live {
        return Err(Error(
            StatusCode::NOT_FOUND,
            "unknown native session".into(),
        ));
    }
    let session = hub
        .native
        .lock()
        .iter()
        .find(|(_, runtime_id)| **runtime_id == id)
        .map(|(session, _)| session.clone())
        .ok_or_else(|| {
            Error(
                StatusCode::NOT_FOUND,
                "native session is not registered yet".into(),
            )
        })?;
    let token = hub
        .store
        .db_token(&session)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown native session".into()))?;
    Ok(Json(
        json!({"address":Address{node_id:hub.node_id().into(),session_id:session},"token":token}),
    ))
}
async fn directory(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    auth(&hub, &h)?;
    Ok(Json(json!({"sessions":hub.directory()?})))
}
async fn register(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<Registration>> {
    admin(&hub, &h)?;
    if req.session_id.starts_with("kode:") || !matches!(req.runtime.as_str(), "dsh" | "external") {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "reserved runtime or session id".into(),
        ));
    }
    let _guard = hub.gate.lock();
    let id = req.session_id.clone();
    let registration = hub.store.register(req)?;
    // A new activation fences the previous token. Claimed external work is never replayed.
    for mut m in hub.store.messages()? {
        if m.target.node_id == hub.node_id()
            && m.target.session_id == id
            && m.status == Status::Delivering
        {
            m.status = Status::Uncertain;
            m.detail = Some("runtime owner replaced during submission".into());
            hub.store.save(&m)?;
        }
    }
    Ok(Json(registration))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TitleRequest {
    title: String,
}
async fn update_title(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<TitleRequest>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    hub.store.update_title(&id, &req.title)?;
    Ok(Json(json!({"ok":true})))
}
async fn heartbeat(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    hub.store.heartbeat(&id)?;
    Ok(Json(json!({"ok":true})))
}
async fn offline(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    hub.store.offline(&id)?;
    Ok(Json(json!({"ok":true})))
}
async fn claim(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    if hub.native.lock().contains_key(&id) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "native runtime owns this inbox".into(),
        ));
    }
    Ok(Json(json!({"messages":hub.claim(&id)?})))
}
async fn pending(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    Ok(Json(json!({"pending":hub.store.pending_count(&id)?})))
}
async fn send(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(req): Json<SendRequest>,
) -> Result<Json<Message>> {
    let source = match auth(&hub, &h)? {
        Principal::Admin => req
            .source
            .clone()
            .ok_or_else(|| Error(StatusCode::BAD_REQUEST, "source required".into()))?,
        Principal::Session(id) => {
            if req.source.as_ref().is_some_and(|s| s != &id) {
                return Err(Error(
                    StatusCode::FORBIDDEN,
                    "cannot impersonate another session".into(),
                ));
            }
            id
        }
    };
    Ok(Json(hub.send(&source, req)?))
}
async fn message(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Message>> {
    let p = auth(&hub, &h)?;
    let m = hub
        .store
        .get(&id)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown message".into()))?;
    if let Principal::Session(s) = p {
        if !((m.source.node_id == hub.node_id() && m.source.session_id == s)
            || (m.target.node_id == hub.node_id() && m.target.session_id == s))
        {
            return Err(Error(StatusCode::FORBIDDEN, "foreign message".into()));
        }
    }
    Ok(Json(m))
}
async fn delivery(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    // Reuse the participant visibility check, without changing the strict Message DTO.
    let Json(message) = message(State(hub.clone()), h, Path(id.clone())).await?;
    let local = message.target.node_id == hub.node_id();
    let record = if local {
        hub.store.delivery(&id)?
    } else {
        hub.store.delivery_mirror(&id)?
    };
    Ok(Json(
        json!({"delivery":record,"scope":if local {"execution_host"} else {"remote_mirror"},"execution_node":message.target.node_id}),
    ))
}
async fn observe_delivery(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::delivery::Observation>,
) -> Result<Json<super::delivery::Record>> {
    owner(&hub, &h, &input.session_id)?;
    Ok(Json(hub.observe_delivery(&id, input)?))
}
#[derive(Deserialize, Default)]
struct DeliveryCursor {
    #[serde(default)]
    after: String,
}
async fn pending_deliveries(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(cursor): Query<DeliveryCursor>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    let records = hub.store.pending_deliveries(&id, &cursor.after)?;
    let next = if records.len() == 200 {
        records.last().map(|r| r.message_id.clone())
    } else {
        None
    };
    Ok(Json(json!({"deliveries":records,"next":next})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settlement {
    session_id: String,
    status: Status,
    detail: Option<String>,
}
async fn settle(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<Settlement>,
) -> Result<Json<Message>> {
    owner(&hub, &h, &req.session_id)?;
    Ok(Json(hub.settle(
        &req.session_id,
        &id,
        req.status,
        req.detail,
    )?))
}
#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    after: u64,
}
async fn events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    let session = match auth(&hub, &h)? {
        Principal::Admin => None,
        Principal::Session(s) => Some(s),
    };
    let events = hub.store.events(q.after, session.as_deref())?;
    let cursor = events.last().map_or(q.after, |e| e.seq);
    Ok(Json(json!({"events":events,"cursor":cursor})))
}

async fn runtime_publish(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(mut input): Json<crate::runtime::Publication>) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?; let ctx=hub.ctx.upgrade().ok_or_else(||Error(StatusCode::SERVICE_UNAVAILABLE,"backend stopping".into()))?;
    let workspace_document = hub.store.document("workspaces")?;
    enforce_archive_visibility(&mut input, &workspace_document["value"]);
    let archived = workspace_document["value"]["global"]["archivedSessionIds"]
        .as_array().into_iter().flatten().filter_map(serde_json::Value::as_str).collect();
    ctx.runtimes.retire_archived(&ctx, &archived)?;
    let runtime=input.runtime.clone();
    let result=ctx.runtimes.publish(&ctx,input)?;
    if runtime=="gui" {
        for row in result["sessions"].as_array().into_iter().flatten() {
            if let Some(id) = row["id"].as_u64() {
                let snapshot = ctx
                    .runtimes
                    .snapshots()
                    .into_iter()
                    .find(|s| s["local_id"] == id)
                    .unwrap_or_default();
                let sid = format!("kode:runtime:gui:{id}");
                hub.store.register(RegisterRequest {
                    session_id: sid.clone(),
                    title: snapshot["dto"]["title"]
                        .as_str()
                        .unwrap_or("Kode session")
                        .into(),
                    runtime: "kode".into(),
                    owner_token: hub.store.db_token(&sid)?,
                })?;
                hub.native.lock().insert(sid, id);
            }
        }
    }
    Ok(Json(result))
}

fn enforce_archive_visibility(input: &mut crate::runtime::Publication, workspaces: &serde_json::Value) {
    let archived: std::collections::HashSet<&str> = workspaces["global"]["archivedSessionIds"]
        .as_array().into_iter().flatten().filter_map(serde_json::Value::as_str).collect();
    for session in &mut input.sessions {
        if archived.contains(session.session_id.as_str())
            || session.dto["session_uuid"].as_str().is_some_and(|id| archived.contains(id))
        {
            session.dto["status"] = json!("exited");
            session.events.clear();
        }
    }
}

#[cfg(test)]
mod archive_visibility_tests {
    use super::*;

    #[test]
    fn old_hosts_cannot_republish_archived_sessions_or_history() {
        let mut input: crate::runtime::Publication = serde_json::from_value(json!({
            "runtime":"dsh","boot_id":"boot","sessions":[
                {"session_id":"archived","dto":{"status":"idle"},"events":[{"key":"late","kind":"session.status","payload":{"status":"idle"}}]},
                {"session_id":"alias","dto":{"status":"busy","session_uuid":"archived"},"events":[]},
                {"session_id":"active","dto":{"status":"idle"},"events":[]}
            ]
        })).unwrap();
        enforce_archive_visibility(&mut input, &json!({"global":{"archivedSessionIds":["archived"]}}));
        assert_eq!(input.sessions[0].dto["status"], "exited");
        assert!(input.sessions[0].events.is_empty());
        assert_eq!(input.sessions[1].dto["status"], "exited");
        assert_eq!(input.sessions[2].dto["status"], "idle");
        enforce_archive_visibility(&mut input, &json!({}));
        assert_eq!(input.sessions[2].dto["status"], "idle");
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeClaim {
    runtime: String,
    boot_id: String,
}
async fn runtime_claim(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<RuntimeClaim>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    Ok(Json(ctx.runtimes.claim(&input.runtime, &input.boot_id)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeSettlement {
    runtime: String,
    boot_id: String,
    id: String,
    result: serde_json::Value,
}
async fn runtime_settle(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<RuntimeSettlement>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    ctx.runtimes
        .settle(&input.runtime, &input.boot_id, &input.id, input.result)?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeCommand {
    session_id: u64,
    kind: String,
    payload: serde_json::Value,
    request_id: String,
}
async fn runtime_command(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<RuntimeCommand>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    Ok(Json(
        ctx.runtimes
            .command(
                input.session_id,
                &input.kind,
                input.payload,
                &input.request_id,
            )
            .await?,
    ))
}
async fn cloud_status(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
) -> Result<Json<crate::cloud_sync::CloudSyncStatus>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    Ok(Json(crate::cloud_sync::CloudSyncManager::new(ctx).status()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloudPair {
    server_url: String,
}
async fn cloud_pair(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<CloudPair>,
) -> Result<Json<crate::cloud_sync::CloudPairingPayload>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    Ok(Json(
        crate::cloud_sync::CloudSyncManager::new(ctx)
            .configure_and_create_pairing(input.server_url)
            .await
            .map_err(|e| Error(StatusCode::BAD_GATEWAY, e))?,
    ))
}

#[derive(Deserialize)]
struct RuntimeHistory {
    id: u64,
    from: Option<u64>,
    limit: Option<usize>,
}
async fn runtime_history(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(query): Query<RuntimeHistory>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    Ok(Json(
        json!({"events":ctx.runtimes.history(query.id,query.from.unwrap_or(0),query.limit.unwrap_or(10000))?}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloudActivation {
    backend_id: String,
}
async fn cloud_activate(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<CloudActivation>,
) -> Result<Json<crate::cloud_sync::CloudSyncStatus>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    Ok(Json(
        crate::cloud_sync::CloudSyncManager::new(ctx)
            .activate_backend(&input.backend_id)
            .map_err(|e| Error(StatusCode::BAD_REQUEST, e))?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CloudBackend {
    name: String,
    server_url: String,
    ssh_host: String,
    ssh_port: u16,
    remote_port: u16,
    deployment_kind: String,
    remote_deploy_dir: Option<String>,
}
async fn cloud_backend(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<CloudBackend>,
) -> Result<Json<crate::cloud_sync::CloudBackendSummary>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    Ok(Json(
        crate::cloud_sync::CloudSyncManager::new(ctx)
            .upsert_managed_backend(
                input.name,
                input.server_url,
                input.ssh_host,
                input.ssh_port,
                input.remote_port,
                input.deployment_kind,
                input.remote_deploy_dir,
            )
            .map_err(|e| Error(StatusCode::BAD_REQUEST, e))?,
    ))
}

async fn integration_status(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
) -> Result<Json<super::integrations::Settings>> {
    auth(&hub, &h)?;
    Ok(Json(super::integrations::settings(&hub)?))
}
async fn integration_configure(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(value): Json<super::integrations::Change>,
) -> Result<Json<super::integrations::Settings>> {
    admin(&hub, &h)?;
    Ok(Json(super::integrations::change(&hub, value)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryTool {
    name: String,
    arguments: serde_json::Value,
}
async fn memory_tool(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<MemoryTool>,
) -> Result<Json<serde_json::Value>> {
    let source = match auth(&hub, &h)? {
        Principal::Admin => "owner".into(),
        Principal::Session(source) => source,
    };
    Ok(Json(
        super::integrations::tool(&hub, &source, &input.name, input.arguments).await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeResolution {
    native_id: u64,
    process_id: u64,
}
async fn resolve_native(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<NativeResolution>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    let id = ctx
        .runtimes
        .snapshots()
        .iter()
        .find(|row| {
            row["dto"]["runtime"] == "gui"
                && row["dto"]["native_runtime_id"] == input.native_id
                && row["dto"]["native_process_id"] == input.process_id
        })
        .and_then(|row| row["local_id"].as_u64())
        .ok_or_else(|| {
            Error(
                StatusCode::NOT_FOUND,
                "GUI session has not published yet".into(),
            )
        })?;
    native_credential(State(hub), h, Path(id)).await
}

async fn runtime_release(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<RuntimeClaim>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let ctx = hub
        .ctx
        .upgrade()
        .ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "backend stopping".into()))?;
    ctx.runtimes.release(&input.runtime, &input.boot_id)?;
    Ok(Json(json!({"ok":true})))
}

async fn cancellation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let _ = message(State(hub.clone()), h, Path(id.clone())).await?;
    Ok(Json(json!({"cancellation":hub.cancellation(&id)?})))
}
async fn request_cancellation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<super::cancellation::Record>> {
    let m = hub
        .store
        .get(&id)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown message".into()))?;
    owner(&hub, &h, &m.source.session_id)?;
    Ok(Json(hub.request_cancellation(&id)?))
}
async fn report_cancellation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(report): Json<super::cancellation::Report>,
) -> Result<Json<super::cancellation::Record>> {
    owner(&hub, &h, &report.session_id)?;
    Ok(Json(hub.report_cancellation(&id, report)?))
}
async fn pending_cancellations(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(cursor): Query<DeliveryCursor>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    let records = hub.pending_cancellations(&id, &cursor.after)?;
    let next = if records.len() == 200 {
        records.last().map(|r| r.message_id.clone())
    } else {
        None
    };
    Ok(Json(json!({"cancellations":records,"next":next})))
}

async fn lifecycle_events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    let session = match auth(&hub, &h)? {
        Principal::Admin => None,
        Principal::Session(s) => Some(s),
    };
    let events = hub.store.lifecycle_events(q.after, session.as_deref())?;
    let cursor = events.last().map_or(q.after, |e| e.seq);
    Ok(Json(
        json!({"events":events,"cursor":cursor,"may_have_more":!events.is_empty(),"ordering":"local_commit_or_historical_import"}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareOperation {
    #[serde(default)]
    selection_policy: Option<super::selection_evidence::Policy>,
    owner_session: String,
    request_key: String,
    worker: Address,
    #[serde(default)]
    budget_required: bool,
    #[serde(default)]
    resource_required: bool,
    #[serde(default)]
    grant_required: bool,
}
async fn relay_accounting(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(node): Path<String>,
    Json(input): Json<super::operation_relay::Request>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    if input.accounting.is_none() || input.command.is_some() {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "accounting request required".into(),
        ));
    }
    Ok(Json(hub.relay_operation(&node, input).await?))
}
async fn relay_operation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(node): Path<String>,
    Json(input): Json<super::operation_relay::Request>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &input.worker_session)?;
    if input.accounting.is_some() {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "trusted Host accounting endpoint required".into(),
        ));
    }
    Ok(Json(hub.relay_operation(&node, input).await?))
}
async fn prepare_operation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<PrepareOperation>,
) -> Result<Json<super::operations::Operation>> {
    owner(&hub, &h, &input.owner_session)?;
    if input.worker.node_id != hub.node_id()
        && !hub
            .peers()
            .iter()
            .any(|p| p.node_id == input.worker.node_id)
    {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "unknown operation execution host".into(),
        ));
    }
    Ok(Json(hub.store.prepare_selected_operation(
        &input.owner_session,
        &input.request_key,
        input.worker,
        input.budget_required,
        input.resource_required,
        input.grant_required,
        input.selection_policy,
    )?))
}
async fn operation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<super::operations::Operation>> {
    let principal = auth(&hub, &h)?;
    hub.store.expire_operations(now())?;
    let row = hub
        .store
        .operation(&id)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown operation".into()))?;
    match principal {
        Principal::Admin => {}
        Principal::Session(s)
            if s == row.owner
                || (row.worker.node_id == hub.node_id() && row.worker.session_id == s) => {}
        _ => return Err(Error(StatusCode::FORBIDDEN, "foreign operation".into())),
    }
    Ok(Json(row))
}
async fn command_operation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::operations::Command>,
) -> Result<Json<super::operations::Outcome>> {
    use super::operations::Action;
    let row = hub
        .store
        .operation(&id)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown operation".into()))?;
    match input.action {
        Action::Claim { .. }
        | Action::Renew { .. }
        | Action::ClaimResource { .. }
        | Action::RenewResource { .. }
        | Action::Report { .. } => {
            if row.worker.node_id != hub.node_id() {
                return Err(Error(
                    StatusCode::FORBIDDEN,
                    "foreign execution host".into(),
                ));
            }
            owner(&hub, &h, &row.worker.session_id)?;
        }
        Action::AttestStopped { .. } => admin(&hub, &h)?,
        Action::Cancel | Action::NextAttempt => owner(&hub, &h, &row.owner)?,
    }
    Ok(Json(hub.store.command_operation(&id, input, now())?))
}

async fn operation_events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    let _ = operation(State(hub.clone()), h, Path(id.clone())).await?;
    let events = hub.store.operation_events(&id, q.after)?;
    let cursor = events
        .last()
        .and_then(|e| e["seq"].as_u64())
        .unwrap_or(q.after);
    Ok(Json(
        json!({"events":events,"cursor":cursor,"may_have_more":!events.is_empty()}),
    ))
}

async fn change_resource_account(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::resources::AccountCommand>,
) -> Result<Json<super::resources::Account>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.change_resource_account(input)?))
}
async fn resource_account(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<super::resources::Account>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.resource_account(&id)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "unknown account".into())
    })?))
}
async fn bind_resource_account(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::resources::BindingCommand>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.bind_resource_account(input)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResourceQuery {
    host: String,
    #[serde(default)]
    after: String,
}
async fn resource_bindings(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(input): Query<ResourceQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let rows = hub.store.resource_bindings(&input.host, &input.after)?;
    Ok(Json(
        serde_json::json!({"next":rows.last().and_then(|r|r["profile"].as_str()).unwrap_or(&input.after),"may_have_more":rows.len()==100,"bindings":rows}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuotaQuery {
    host: String,
    profile: String,
}
async fn record_quota(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::quota::Sample>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.record_quota(input, now())?))
}
async fn quota_snapshot(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(input): Query<QuotaQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.quota_snapshot(
        &input.host,
        &input.profile,
        now(),
    )?))
}

async fn resource_binding(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(input): Query<QuotaQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        hub.store.resource_binding(&input.host, &input.profile)?,
    ))
}
async fn invalidate_resource_binding(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::resources::InvalidateBinding>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.invalidate_resource_binding(input)?))
}

async fn configure_team_resource(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::team_resource_setup::Configure>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.configure_team_resource(&id, input)?))
}
async fn read_team_resource_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"receipt":hub.store.team_resource_receipt(&id,&request_id)?}),
    ))
}
async fn configure_team_authority(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::team_authority_setup::Configure>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.configure_team_authority(&id, input)?))
}
async fn read_team_authority_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"receipt":hub.store.team_authority_receipt(&id,&request_id)?}),
    ))
}
async fn configure_team_budget(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::team_budget_setup::Configure>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.configure_team_budget(&id, input)?))
}
async fn read_team_budget_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"receipt":hub.store.team_budget_receipt(&id,&request_id)?}),
    ))
}
async fn configure_budget(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::budgets::Configure>,
) -> Result<Json<super::budgets::Budget>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.configure_budget(input, now())?))
}
async fn read_budget(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.budget(&id)?))
}
async fn reserve_budget(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::budgets::Reserve>,
) -> Result<Json<super::budgets::Reservation>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.reserve_budget(input, now())?))
}
async fn settle_budget(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::budgets::Settle>,
) -> Result<Json<super::budgets::Reservation>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.settle_budget(&id, input, now())?))
}

#[derive(Deserialize)]
struct AccountingAttempt {
    attempt: u64,
}
async fn operation_accounting(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(input): Query<AccountingAttempt>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        hub.store
            .operation_accounting(&id, input.attempt)?
            .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown operation budget".into()))?,
    ))
}
async fn attach_operation_budget(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::operation_budget::Attach>,
) -> Result<Json<super::operations::Operation>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.attach_operation_budget(&id, input)?))
}

async fn budget_reservation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.budget_reservation(&id)?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown reservation".into()),
    )?))
}
async fn budget_settlement(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, event)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.budget_settlement(&id, &event)?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown settlement".into()),
    )?))
}
#[derive(Deserialize)]
struct BudgetPage {
    #[serde(default)]
    after: String,
}
async fn budget_reservations(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(input): Query<BudgetPage>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.budget_reservations(&id, &input.after)?))
}
async fn budget_events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(input): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.budget_events(&id, input.after)?))
}

async fn create_price(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::pricing::Price>,
) -> Result<Json<super::pricing::Price>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.create_price(input)?))
}
async fn read_price(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<super::pricing::Price>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.price(&id)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "unknown price version".into())
    })?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BindPrice {
    price_id: String,
}
async fn bind_price(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<BindPrice>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.bind_price(&id, &input.price_id)?))
}
async fn record_usage(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::pricing::Usage>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.record_usage(input, now())?))
}
async fn usage_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.usage_receipt(&id)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "unknown usage event".into())
    })?))
}

async fn resource_admission(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::resource_admission::Policy>,
) -> Result<Json<super::resource_admission::Decision>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.resource_admission(&input, now())?))
}
async fn attach_operation_resource(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::resource_admission::Attach>,
) -> Result<Json<super::operations::Operation>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.attach_operation_resource(&id, input)?))
}

async fn begin_official_call(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::official_calls::Begin>,
) -> Result<Json<super::official_calls::Receipt>> {
    admin(&hub, &h)?;
    local_call_operation(&hub, &input.operation_id)?;
    Ok(Json(hub.store.begin_official_call(input, now())?))
}
fn local_call_operation(hub: &Hub, id: &str) -> Result<()> {
    let op = hub
        .store
        .operation(id)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown operation".into()))?;
    if op.worker.node_id != hub.node_id() {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "remote call collector relay required".into(),
        ));
    }
    Ok(())
}
async fn official_call(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<super::official_calls::Call>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.official_call(&id)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "unknown official call".into())
    })?))
}
async fn record_official_call(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::official_calls::Evidence>,
) -> Result<Json<super::official_calls::Receipt>> {
    admin(&hub, &h)?;
    let call = hub
        .store
        .official_call(&id)?
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown official call".into()))?;
    local_call_operation(&hub, &call.request.operation_id)?;
    Ok(Json(hub.store.record_official_call(&id, input)?))
}
async fn official_call_events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    if hub.store.official_call(&id)?.is_none() {
        return Err(Error(StatusCode::NOT_FOUND, "unknown official call".into()));
    }
    let events = hub.store.official_call_events(&id, q.after)?;
    let cursor = events.last().map(|e| e.sequence).unwrap_or(q.after);
    Ok(Json(
        json!({"events":events,"cursor":cursor,"may_have_more":events.len()==100}),
    ))
}

async fn record_tool_evidence(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::tool_evidence::Evidence>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    local_call_operation(&hub, &input.operation_id)?;
    Ok(Json(hub.store.record_tool_evidence(input)?))
}
async fn record_artifact_evidence(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::artifact_evidence::Evidence>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    local_call_operation(&hub, &input.operation_id)?;
    Ok(Json(hub.store.record_artifact_evidence(input)?))
}

async fn resolve_tool_evidence(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::tool_resolution::Resolution>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.resolve_tool_evidence(input)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantQuery {
    revision: Option<u64>,
}
async fn write_team_grant(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::team_grants::Write>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.write_team_grant(input, now())?))
}
async fn team_grant(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<GrantQuery>,
) -> Result<Json<super::team_grants::Grant>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team_grant(&id, q.revision)?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown team grant".into()),
    )?))
}

async fn check_team_grant(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::team_grants::Check>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.check_team_grant(&id, input, now())?))
}

async fn attach_operation_grant(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::operation_grant::Attach>,
) -> Result<Json<super::operations::Operation>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.attach_operation_grant(&id, input, now())?))
}

async fn operation_grant_context(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.operation_grant_context(&id, now())?))
}

async fn session_diagnostics(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    owner(&hub, &h, &id)?;
    Ok(Json(hub.store.session_diagnostics(&id, now())?))
}

async fn record_selection_evidence(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::selection_evidence::Evidence>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    local_call_operation(&hub, &input.operation_id)?;
    Ok(Json(hub.store.record_selection_evidence(input)?))
}

async fn communication_health(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.communication_health()))
}

async fn save_capability_profile(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::capability_profiles::Command>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.save_capability_profile(input)?))
}
async fn read_capability_profile(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, revision)): Path<(String, u64)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        hub.store
            .capability_profile(&id, revision)?
            .ok_or_else(|| {
                Error(
                    StatusCode::NOT_FOUND,
                    "unknown capability profile revision".into(),
                )
            })?,
    ))
}

async fn rank_resources(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::resource_rank::Request>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.rank_resources(input)?))
}

async fn record_monetary_quota(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::monetary_quota::Observation>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.record_monetary_quota(input)?))
}
async fn read_monetary_quota(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(input): Query<QuotaQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.monetary_quota(&input.host, &input.profile)?))
}

async fn answer_builder_draft(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_answers::Answer>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.answer_builder_draft(&id, input)?))
}
async fn continue_builder_answers(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_continue::Confirm>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.continue_builder_answers(&id, input)?))
}
async fn enqueue_builder_input(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_input::Input>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.enqueue_builder_input(&id, input)?))
}
async fn read_builder_input(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"input":hub.store.builder_input(&id,&request)?}),
    ))
}
async fn read_builder_scope(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"scope": hub.store.builder_scope(&id)?}),
    ))
}
async fn prepare_builder_start(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::builder_start::Request>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.prepare_builder_start(input)?))
}
async fn bind_builder_scope(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_authority::Attach>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.bind_builder_scope(&id, input)?))
}
async fn builder_preflight(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_preflight::Check>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_preflight(&id, input)?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown Builder draft".into()),
    )?))
}
async fn read_builder_draft_command(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"receipt":hub.store.builder_draft_command(&id, &request)?}),
    ))
}
async fn list_builder_drafts(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(page): Query<super::teams::Page>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_drafts(page)?))
}
async fn save_builder_draft(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    input: std::result::Result<
        Json<super::builder_drafts::Save>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let Json(input) = input.map_err(|error| Error(error.status(), error.body_text()))?;
    Ok(Json(hub.store.save_builder_draft(input)?))
}
async fn read_builder_draft(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_draft(&id)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "unknown Builder draft".into())
    })?))
}
async fn save_team(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::teams::Save>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.save_team(input)?))
}
async fn validate_workflow(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::workflows::Pack>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(super::workflows::validate(&input)?))
}
async fn check_workflow_evidence(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::workflow_evidence::Check>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.check_workflow_evidence(input)?))
}
async fn save_workflow(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::workflows::Pack>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.save_workflow(input)?))
}
async fn save_project_config(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::project_configs::Config>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.save_project_config(input)?))
}
async fn read_project_config(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, version)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.project_config(&id, &version)?.ok_or_else(
        || {
            Error(
                StatusCode::NOT_FOUND,
                "unknown project configuration".into(),
            )
        },
    )?))
}
async fn project_config_events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.project_config_events(&id, q.after)?))
}
async fn read_workflow(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, version)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.workflow(&id, &version)?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown workflow version".into()),
    )?))
}
async fn workflow_events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.workflow_events(&id, q.after)?))
}
async fn list_teams(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(page): Query<super::teams::DirectoryPage>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.search_teams(
        super::teams::Page {
            after: page.after,
            limit: page.limit,
        },
        page.q,
    )?))
}
async fn read_team(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team(&id, None)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "unknown team".into())
    })?))
}
async fn contact_directory(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(page): Query<super::contact_directory::Page>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.contact_directory(page)?))
}
async fn contact_preference(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.contact_preference(&id)?))
}
async fn change_contact_preference(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::contact_directory::Change>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.change_contact_preference(&id, input)?))
}
async fn contact_preference_request(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.contact_preference_request(&id, &request)?))
}
async fn read_team_revision(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, revision)): Path<(String, u64)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team(&id, Some(revision))?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown team revision".into()),
    )?))
}
async fn team_workflow_preflight(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, revision)): Path<(String, u64)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        hub.store
            .team_workflow_preflight(&id, revision)?
            .ok_or_else(|| Error(StatusCode::NOT_FOUND, "unknown team revision".into()))?,
    ))
}

async fn team_events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team_events(&id, q.after)?))
}

async fn create_work_run(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::work_runs::Create>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.create_work_run(input)?))
}
async fn read_work_run(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.work_run(&id)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "unknown work run".into())
    })?))
}
async fn command_work_run(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::work_runs::Command>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.command_work_run(&id, input)?))
}
async fn work_run_trace(
    State(hub): State<Arc<Hub>>, h: HeaderMap, Path(id): Path<String>, Query(query): Query<super::work_run_trace::Query>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(hub.store.work_run_trace(&id,query)?.ok_or_else(|| Error(StatusCode::NOT_FOUND,"unknown work run".into()))?))
}
async fn work_run_accounting_status(
    State(hub): State<Arc<Hub>>, h: HeaderMap, Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(hub.store.work_run_accounting_status(&id)?.ok_or_else(|| Error(StatusCode::NOT_FOUND,"unknown work run".into()))?))
}
async fn work_run_diagnostics(
    State(hub): State<Arc<Hub>>, h: HeaderMap, Path(id): Path<String>, Query(query): Query<super::work_run_diagnostics::Query>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(hub.store.work_run_diagnostics(&id,query)?.ok_or_else(||Error(StatusCode::NOT_FOUND,"unknown work run".into()))?))
}
async fn work_run_command_receipt(
    State(hub): State<Arc<Hub>>, h: HeaderMap, Path((id,request)): Path<(String,String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(hub.store.work_run_command_receipt(&id,&request)?.ok_or_else(|| Error(StatusCode::NOT_FOUND,"unknown work run".into()))?))
}
async fn work_run_events(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<Cursor>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.work_run_events(&id, q.after)?))
}

async fn write_team_policy(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::team_policies::Write>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.write_team_policy(input)?))
}
async fn read_team_policy(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<GrantQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team_policy(&id, q.revision)?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown team policy".into()),
    )?))
}

async fn read_team_activation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team_activation(&id)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "team has no activation".into())
    })?))
}
async fn read_team_activation_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"receipt": hub.store.team_activation_receipt(&id, &request_id)?}),
    ))
}
async fn change_team_activation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::team_activation::Command>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.change_team_activation(&id, input)?))
}

async fn prepare_operation_bundle(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::operation_bundle::Request>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    if input.worker.node_id != hub.node_id()
        && !hub
            .peers()
            .iter()
            .any(|p| p.node_id == input.worker.node_id)
    {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "unknown operation execution host".into(),
        ));
    }
    Ok(Json(hub.store.prepare_operation_bundle(input)?))
}

async fn abandon_operation_bundle(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::operation_bundle::Abandon>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.abandon_operation_bundle(&id, input)?))
}

async fn work_run_stage_plan(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, stage)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.work_run_stage_plan(&id, &stage)?))
}

async fn prepare_work_assignment(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, stage)): Path<(String, String)>,
    Json(input): Json<super::work_assignments::Prepare>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let mut hosts = vec![hub.node_id().to_owned()];
    hosts.extend(hub.peers().iter().map(|p| p.node_id.clone()));
    Ok(Json(
        hub.store
            .prepare_work_assignment(&id, &stage, input, &hosts)?,
    ))
}
async fn read_work_assignment(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.work_assignment(&id)?.ok_or_else(|| {
        Error(StatusCode::NOT_FOUND, "unknown assignment".into())
    })?))
}
async fn abandon_work_assignment(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::work_assignments::Abandon>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.abandon_work_assignment(&id, input)?))
}

async fn configure_assignment_capacity(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(input): Json<super::assignment_resources::Capacity>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.configure_assignment_capacity(input)?))
}
async fn read_assignment_capacity(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.assignment_capacity(&id)?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown account capacity".into()),
    )?))
}
async fn reserve_assignment_resources(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_resources::Reserve>,
) -> Result<Response> {
    admin(&hub, &h)?;
    match hub.store.reserve_assignment_resources(&id, input) {
        Ok(value) => Ok(Json(value).into_response()),
        Err(error) => {
            if let Some(wait) = error.downcast_ref::<super::assignment_resources::ResourceWait>() {
                return Ok((
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({"error":wait.to_string(),"code":wait.code()})),
                )
                    .into_response());
            }
            Err(error.into())
        }
    }
}

async fn admit_work_assignment(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_admission::Admit>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.admit_work_assignment(&id, input)?))
}

async fn pending_assignment_dispatches(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(input): Query<super::assignment_dispatch::Pending>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.pending_assignment_dispatches(input)?))
}
async fn assignment_creation_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_dispatch::Receipt>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.assignment_creation_receipt(&id, input)?))
}

async fn enqueue_assignment_mandate(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_mandate::Enqueue>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    let peers = hub.peers();
    let remote_workers: Vec<super::model::Address> = hub
        .directory()?
        .into_iter()
        .filter(|session| {
            peers
                .iter()
                .any(|peer| peer.node_id == session.address.node_id)
        })
        .map(|session| session.address)
        .collect();
    Ok(Json(hub.store.enqueue_assignment_mandate(
        &id,
        input,
        &remote_workers,
    )?))
}

async fn select_stage_evidence(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, stage)): Path<(String, String)>,
    Json(input): Json<super::stage_evidence::Select>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.select_stage_evidence(&id, &stage, input)?))
}

async fn assignment_stop_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_stop::Receipt>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.assignment_stop_receipt(&id, input)?))
}

async fn finalize_assignment_accounting(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_accounting::Finalize>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.finalize_assignment_accounting(&id, input)?))
}

async fn artifact_archive(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(sequence): Path<u64>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.artifact_archive(sequence)?))
}
async fn artifact_archive_chunk(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((sequence, index)): Path<(u64, usize)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.artifact_archive_chunk(sequence, index)?))
}
async fn put_artifact_chunk(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((sequence, index)): Path<(u64, usize)>,
    Json(input): Json<super::artifact_archive::Chunk>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.put_artifact_chunk(sequence, index, input)?))
}
async fn complete_artifact_archive(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(sequence): Path<u64>,
    Json(input): Json<super::artifact_archive::Identity>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.complete_artifact_archive(sequence, input)?))
}

async fn complete_work_stage(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, stage)): Path<(String, String)>,
    Json(input): Json<super::stage_completion::Complete>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.complete_work_stage(&id, &stage, input)?))
}

async fn prepare_assignment_task_workspace(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_task_prepare::Prepare>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.prepare_assignment_task_workspace(&id, input)?))
}

async fn assignment_task_workspace(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_task_workspace::Receipt>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.assignment_task_workspace(&id, input)?))
}

async fn assignment_workspace_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_workspace::Receipt>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.assignment_workspace_receipt(&id, input)?))
}

async fn authorize_assignment_workspace(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::assignment_scope::Authorize>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.authorize_assignment_workspace(&id, input)?))
}

async fn verification_record(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(sequence): Path<u64>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.verification_record(sequence)?))
}
async fn archive_verification_record(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(sequence): Path<u64>,
    Json(input): Json<super::verification_record::Upload>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        hub.store.archive_verification_record(sequence, input)?,
    ))
}

async fn finalize_work_delivery(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::work_delivery::Finalize>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.finalize_work_delivery(&id, input)?))
}

async fn schedule_work_run(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::work_schedule::Schedule>,
) -> Result<Response> {
    admin(&hub, &h)?;
    let mut hosts = vec![hub.node_id().to_owned()];
    hosts.extend(hub.peers().iter().map(|p| p.node_id.clone()));
    match hub.store.schedule_work_run(&id, input, &hosts) {
        Ok(value) => Ok(Json(value).into_response()),
        Err(error) if error.downcast_ref::<super::budgets::InsufficientBudget>().is_some() => Ok((StatusCode::CONFLICT,
            Json(serde_json::json!({"error":"insufficient team budget","code":"team_budget_exhausted"}))).into_response()),
        Err(error) => Err(error.into()),
    }
}

async fn active_work_runs(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(input): Query<super::work_runs::ActiveQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.active_work_runs(input)?))
}

async fn team_work_runs(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(page): Query<super::teams::Page>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team_work_runs(&id, page)?.ok_or_else(
        || Error(StatusCode::NOT_FOUND, "unknown team".into()),
    )?))
}

async fn remote_assignment_dispatches(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(node): Path<String>,
    Query(input): Query<super::assignment_dispatch::RemotePending>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    if node == hub.node_id() || !super::model::valid_id(&node) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "remote home Hub required".into(),
        ));
    }
    Ok(Json(
        hub.workspace(
            &node,
            super::workspaces::Command::AssignmentCatalog { after: input.after },
        )
        .await?,
    ))
}

async fn builder_catalog(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_catalog::Query>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_catalog(&id, input)?))
}

async fn builder_policy_details(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_policy_details::Query>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_policy_details(&id, input)?))
}

async fn accept_builder_proposal(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_accept::Accept>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.accept_builder_proposal(&id, input)?))
}
async fn builder_acceptance(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"acceptance":hub.store.builder_acceptance(&id,&request)?}),
    ))
}

async fn review_team_activation(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::activation_review::Review>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.review_team_activation(&id, input)?))
}

async fn send_conversation_message(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::conversations::Send>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.send_conversation_message(&id, input)?))
}
async fn conversation_messages(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(input): Query<super::conversations::Page>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.conversation_messages(&id, input)?))
}
async fn conversation_request(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"message":hub.store.conversation_request(&id,&request)?}),
    ))
}

async fn bind_coordinator_control(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::coordinator_control::Bind>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.bind_coordinator_control(&id, input)?))
}
async fn pending_coordinator_transfers(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(input): Query<super::work_runs::ActiveQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.pending_coordinator_transfers(&id, input)?))
}

async fn transfer_coordinator_run(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::coordinator_transfer::Transfer>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.transfer_coordinator_run(&id, input)?))
}
async fn read_coordinator_reply_authority(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((conversation, message, revision)): Path<(String, String, u64)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"authority":hub.store.coordinator_reply_authority(&conversation,&message,revision)?}),
    ))
}

async fn read_coordinator_recovery(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.coordinator_recovery(&id)?))
}

async fn read_coordinator_control(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"control":hub.store.coordinator_control(&id)?}),
    ))
}

async fn dispatch_coordinator_input(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((conversation, message)): Path<(String, String)>,
    Json(input): Json<super::coordinator_input::Dispatch>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.dispatch_coordinator_input(
        &conversation,
        &message,
        input,
    )?))
}
async fn read_coordinator_input(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((conversation, message)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"input":hub.store.coordinator_input(&conversation,&message)?}),
    ))
}

async fn publish_coordinator_reply(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::coordinator_reply::Publish>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.publish_coordinator_reply(&id, input)?))
}
async fn read_coordinator_reply(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"message":hub.store.coordinator_reply(&id,&request)?}),
    ))
}

async fn start_coordinator_run(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::coordinator_run::Start>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.start_coordinator_run(&id, input)?))
}
async fn coordinator_run_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"run":hub.store.coordinator_run_receipt(&id,&request)?}),
    ))
}

async fn pending_coordinator_updates(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(q): Query<super::work_runs::ActiveQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.pending_coordinator_updates(q)?))
}
async fn queue_coordinator_update(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(q): Json<super::coordinator_update::Queue>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.queue_coordinator_update(&id, q)?))
}
async fn read_coordinator_update(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, revision)): Path<(String, u64)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        serde_json::json!({"update":hub.store.coordinator_update(&id,revision)?}),
    ))
}

async fn pending_conversation_inputs(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<super::conversations::Page>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.pending_conversation_inputs(&id, q)?))
}

async fn prepare_coordinator_start(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::coordinator_start::Request>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.prepare_coordinator_start(&id, input)?))
}

async fn pending_coordinator_closes(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Query(input): Query<super::coordinator_close::PendingQuery>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.pending_coordinator_closes(input)?))
}

async fn begin_coordinator_close(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::coordinator_close::Close>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.begin_coordinator_close(&id, input)?))
}
async fn read_coordinator_close(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.coordinator_close_state(&id)?))
}

async fn finalize_coordinator_accounting(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::coordinator_accounting::Finalize>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.finalize_coordinator_accounting(&id, input)?))
}

async fn finalize_builder_accounting(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_accounting::Finalize>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.finalize_builder_accounting(&id, input)?))
}

async fn begin_builder_close(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_close::Close>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.begin_builder_close(&id, input)?))
}
async fn read_builder_close(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_close_state(&id)?))
}

async fn selected_stage_output(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, stage, output)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(
        hub.store
            .selected_stage_output(&id, &stage, &output)?
            .ok_or_else(|| Error(StatusCode::NOT_FOUND, "selected output unavailable".into()))?,
    ))
}

async fn set_builder_workspaces(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_answers::Workspaces>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.set_builder_workspaces(&id, input)?))
}

async fn builder_patch_status(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<super::builder_answers::PatchStatus>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_patch_status(&id, query)?))
}

async fn builder_selection(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_selection(&id)?))
}
async fn save_builder_selection(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_selection::Save>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.save_builder_selection(&id, input)?))
}

async fn builder_funding(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_funding(&id)?))
}
async fn confirm_builder_funding(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_funding::Confirm>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.confirm_builder_funding(&id, input)?))
}

async fn confirm_builder_account(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::builder_account::Confirm>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.confirm_builder_account(&id, input)?))
}
async fn builder_account_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.builder_account_receipt(&id, &request)?))
}

async fn team_scheduling_options(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, revision)): Path<(String, u64)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team_scheduling_options(&id, revision)?))
}
async fn team_scheduling_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team_scheduling_receipt(&id, &request)?))
}
async fn runtime_sessions(State(hub): State<Arc<Hub>>, h: HeaderMap) -> Result<Json<serde_json::Value>> {
    admin(&hub,&h)?; let ctx=hub.ctx.upgrade().ok_or_else(||Error(StatusCode::SERVICE_UNAVAILABLE,"backend stopping".into()))?;
    let mut result = json!({"sessions":ctx.runtimes.snapshots().into_iter().map(|s|s["dto"].clone()).collect::<Vec<_>>(),"runtimes":{"gui":ctx.runtimes.available("gui"),"dsh":ctx.runtimes.available("dsh")}});
    super::filter_visible_runtime_sessions(&mut result, &hub.store.document("workspaces")?);
    Ok(Json(result))
}

async fn configure_team_scheduling(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::team_scheduling_setup::Configure>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.configure_team_scheduling(&id, input)?))
}

async fn conversation_read_state(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.conversation_read_state(&id)?))
}
async fn mark_conversation_read(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<super::conversation_read::MarkRead>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.mark_conversation_read(&id, input)?))
}

async fn decide_work_delivery(
    State(hub): State<Arc<Hub>>, h: HeaderMap, Path(id): Path<String>,
    Json(input): Json<super::work_delivery_decision::Decision>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.decide_work_delivery(&id, input)?))
}

async fn update_team_capability(
    State(hub): State<Arc<Hub>>, h: HeaderMap, Path(id): Path<String>,
    Json(input): Json<super::team_capability_update::Update>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.update_team_capability(&id, input)?))
}
async fn team_capability_update_receipt(
    State(hub): State<Arc<Hub>>, h: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.team_capability_update_receipt(&id, &request)?))
}


async fn stage_waiver_plan(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, stage)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.stage_waiver_plan(&id, &stage)?))
}


async fn waive_stage(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, stage)): Path<(String, String)>,
    Json(input): Json<super::stage_waiver::Decision>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.waive_stage(&id, &stage, input)?))
}

async fn stage_waiver_receipt(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Path((id, stage, request)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.stage_waiver_receipt(&id, &stage, &request)?))
}

#[derive(Deserialize)]
struct AgentHubQuery {
    logo: Option<String>,
    package: Option<usize>,
}
async fn agent_hub(State(hub):State<Arc<Hub>>, h:HeaderMap, Query(query):Query<AgentHubQuery>)->Result<Response>{
    admin(&hub,&h)?;
    if let Some(source_id) = query.logo {
        let owner = hub.clone();
        let package = query.package.unwrap_or(0);
        let result = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let state = super::extensions::state(&owner)?;
            let source = state["sources"].as_array().and_then(|rows| rows.iter().find(|row| row["id"].as_str() == Some(&source_id))).ok_or_else(|| anyhow::anyhow!("source not found"))?;
            super::extension_files::logo(&owner.extensions.root, source, package)
        }).await.map_err(anyhow::Error::from)?;
        let (bytes, mime) = result.map_err(|_| Error(StatusCode::NOT_FOUND, "logo unavailable".into()))?;
        return Ok(([
            ("content-type", mime),
            ("cache-control", "private, max-age=60"),
            ("x-content-type-options", "nosniff"),
        ], bytes).into_response())
    }
    Ok(Json(tokio::task::spawn_blocking(move||hub.extensions.view(&hub)).await.map_err(anyhow::Error::from)??).into_response())
}
async fn change_agent_hub(State(hub):State<Arc<Hub>>, h:HeaderMap, Json(input):Json<serde_json::Value>)->Result<Json<serde_json::Value>>{
    admin(&hub,&h)?;
    Ok(Json(tokio::task::spawn_blocking(move||hub.extensions.change(&hub,input)).await.map_err(anyhow::Error::from)??))
}
async fn handoff(State(hub):State<Arc<Hub>>, h:HeaderMap, Json(input):Json<super::handoff::Request>)->Result<Json<serde_json::Value>>{
    admin(&hub,&h)?;
    Ok(Json(super::handoff::execute(hub,input).await?))
}

async fn record_assignment_clarification(State(hub): State<Arc<Hub>>, h: HeaderMap, Path(id): Path<String>, Json(input): Json<super::assignment_clarification::Record>) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(hub.store.record_assignment_clarification(&hub.config.node_id, &id, input)?))
}
async fn read_assignment_clarification(State(hub): State<Arc<Hub>>, h: HeaderMap, Path((id, request)): Path<(String, String)>) -> Result<Json<serde_json::Value>> {
    admin(&hub, &h)?;
    Ok(Json(json!({"clarification":hub.store.assignment_clarification(&id, &request)?})))
}

async fn answer_assignment_clarification(State(hub):State<Arc<Hub>>, h:HeaderMap, Path(id):Path<String>, Json(input):Json<super::assignment_answers::Answer>)->Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(hub.store.answer_assignment_clarification(&id,input)?))
}
async fn read_assignment_answer(State(hub):State<Arc<Hub>>, h:HeaderMap, Path((id,request)):Path<(String,String)>)->Result<Json<serde_json::Value>> {
    admin(&hub,&h)?;
    Ok(Json(json!({"answer":hub.store.assignment_answer(&id,&request)?})))
}
