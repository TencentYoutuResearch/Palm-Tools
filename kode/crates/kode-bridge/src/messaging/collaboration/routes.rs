//! Dedicated authenticated owner endpoints. Session credentials and webhook payloads are not owners.
use super::model::*;
use crate::messaging::{
    api::{admin, Error},
    Hub,
};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use std::sync::Arc;
type Result<T> = std::result::Result<T, Error>;
pub(in crate::messaging) fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/api/v1/messaging/conversations/:id/task-notices", get(task_notices))
        .route("/api/v1/messaging/collaboration/tasks/:id/clarification-answers", post(answer_clarification))
        .route("/api/v1/messaging/collaboration/tasks/:id/execution", get(execution).post(dispatch))
        .route("/api/v1/messaging/collaboration/tasks/:id/execution/cancel", post(cancel_execution))
        .route(
            "/api/v1/messaging/collaboration/surfaces/:id/threads",
            get(threads),
        )
        .route(
            "/api/v1/messaging/collaboration/surfaces",
            get(list_surfaces),
        )
        .route(
            "/api/v1/messaging/collaboration/surfaces/:id",
            post(change_surface),
        )
        .route(
            "/api/v1/messaging/collaboration/surfaces/:id/messages",
            get(messages).post(send),
        )
        .route(
            "/api/v1/messaging/collaboration/surfaces/:id/tasks",
            get(list_tasks),
        )
        .route("/api/v1/messaging/collaboration/tasks", post(create_task))
        .route("/api/v1/messaging/collaboration/tasks/:id", get(task))
        .route(
            "/api/v1/messaging/collaboration/tasks/:id/commands",
            post(command),
        )
        .route(
            "/api/v1/messaging/collaboration/tasks/:id/events",
            get(events),
        )
        .route(
            "/api/v1/messaging/collaboration/tasks/:id/context",
            get(context),
        )
}
async fn task_notices(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>, Query(page): Query<super::conversation_notices::Page>) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.conversation_task_notices(&id, page)?))
}
async fn list_surfaces(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Query(scope): Query<Scope>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.collaboration_surfaces(scope)?))
}
async fn change_surface(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<SurfaceChange>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.change_collaboration_surface(&id, input)?))
}
async fn send(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Send>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    let (mut row,newly_stored)=hub.store.send_collaboration_message_with_status(&id,input)?;
    row["newly_stored"]=serde_json::json!(newly_stored);
    Ok(Json(row))
}
async fn messages(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.collaboration_messages(&id, page)?))
}
async fn list_tasks(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.collaboration_tasks(&id)?))
}
async fn create_task(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(input): Json<CreateTask>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.create_collaboration_task(input)?))
}
async fn task(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.collaboration_task(&id)?))
}
async fn command(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Command>,
) -> Result<(axum::http::StatusCode,Json<Value>)> {
    admin(&hub, &headers)?;
    match hub.store.command_collaboration_task(&id,input) {
        Ok(result)=>Ok((axum::http::StatusCode::OK,Json(result))),
        Err(error) if error.downcast_ref::<super::tasks::UnsupportedMutation>().is_some()=>
            Ok((axum::http::StatusCode::CONFLICT,Json(serde_json::json!({"error":error.to_string(),"code":"task_mutation_requires_reauthorization","retry":"unsupported"})))),
        Err(error)=>Err(error.into()),
    }
}
async fn events(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.collaboration_task_events(&id, page)?))
}
async fn context(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.collaboration_task_context(&id)?))
}

async fn threads(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.collaboration_threads(&id, page)?))
}

async fn execution(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    admin(&hub, &headers)?; Ok(Json(hub.store.collaboration_execution(&id)?))
}
async fn dispatch(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>, Json(input): Json<super::execution::Dispatch>) -> Result<Json<Value>> {
    admin(&hub, &headers)?; Ok(Json(hub.store.dispatch_collaboration_task(&id,input)?))
}
async fn cancel_execution(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>, Json(input): Json<super::execution::Cancel>) -> Result<Json<Value>> {
    admin(&hub, &headers)?; Ok(Json(hub.store.cancel_collaboration_execution(&id,input)?))
}

async fn answer_clarification(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>, Json(input): Json<super::clarification_answers::Answer>) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.answer_collaboration_clarification(&id, input)?))
}
