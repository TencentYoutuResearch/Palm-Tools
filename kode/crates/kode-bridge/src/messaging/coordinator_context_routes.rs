//! Candidate HTTP contracts compiled only in tests. This router is intentionally
//! absent from production routing while scoped runtime isolation remains incomplete.
use super::{admin, Error};
use crate::messaging::{
    collaboration::scoped_thread_create::Create, coordinator_context_input::RecordInput,
    coordinator_context_retrieval::ApproveSummary, coordinator_control::Bind, Hub,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
type Result<T> = std::result::Result<T, Error>;

pub(in crate::messaging) fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/api/v1/messaging/context-v2/threads", post(create_thread))
        .route(
            "/api/v1/messaging/context-v2/contexts/:key",
            get(read_context),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/control",
            get(read_control).post(bind_control),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/inputs",
            post(record_input),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/inputs/:request",
            get(read_input),
        )
        .route(
            "/api/v1/messaging/context-v2/summary-approvals",
            post(approve_summary),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/summary-approvals/:request",
            get(read_summary),
        )
}

async fn create_thread(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(input): Json<Create>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(
        json!({"runtime_ready":false,"thread":hub.store.create_scoped_thread(input)?}),
    ))
}
async fn read_context(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(
        json!({"runtime_ready":false,"context":hub.store.coordinator_context(&key)?}),
    ))
}
async fn read_control(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(
        json!({"runtime_ready":false,"control":hub.store.context_coordinator_control(&key)?}),
    ))
}
async fn bind_control(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(input): Json<Bind>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(
        json!({"runtime_ready":false,"control":hub.store.bind_context_coordinator_control(&key,input)?}),
    ))
}
async fn record_input(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(key): Path<String>,
    Json(input): Json<RecordInput>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(
        json!({"runtime_ready":false,"input":hub.store.record_context_input(&key,input)?}),
    ))
}
async fn read_input(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((key, request)): Path<(String, String)>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(
        json!({"runtime_ready":false,"input":hub.store.context_input(&key,&request)?}),
    ))
}
async fn approve_summary(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(input): Json<ApproveSummary>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(
        json!({"runtime_ready":false,"approval":hub.store.approve_context_summary(input)?}),
    ))
}
async fn read_summary(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((key, request)): Path<(String, String)>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(
        json!({"runtime_ready":false,"approval":hub.store.approved_context_summary(&key,&request)?}),
    ))
}
