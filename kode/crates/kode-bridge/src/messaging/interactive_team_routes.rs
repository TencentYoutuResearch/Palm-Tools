//! Owner Host native-interactive protocol. No session credential may impersonate the Host.
use super::{admin, Error};
use crate::messaging::{
    interactive_team::{Bind, Claim, Finish, Interrupted},
    Hub,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
type Result<T> = std::result::Result<T, Error>;
pub(super) fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route(
            "/api/v1/messaging/teams/:id/configuration-acceptance",
            get(configuration_status).post(configuration_accept),
        )
        .route(
            "/api/v1/messaging/teams/:id/configuration-acceptance-requests/:request",
            get(configuration_request),
        )
        .route("/api/v1/messaging/interactive-teams/bindings", post(bind))
        .route("/api/v1/messaging/interactive-teams/by-original-source/:source", get(original_source))
        .route(
            "/api/v1/messaging/interactive-teams/bindings/:id",
            get(binding),
        )
        .route(
            "/api/v1/messaging/interactive-teams/bindings/:id/recovery",
            get(recovery),
        )
        .route(
            "/api/v1/messaging/interactive-teams/by-native-session/:session",
            get(session),
        )
        .route(
            "/api/v1/messaging/interactive-teams/bindings/:id/sources/claim",
            post(claim),
        )
        .route("/api/v1/messaging/interactive-teams/bindings/:id/sources/interrupted",post(interrupted))
        .route(
            "/api/v1/messaging/interactive-teams/bindings/:id/sources/finish",
            post(finish),
        )
        .route(
            "/api/v1/messaging/interactive-teams/bindings/:id/outbox/:outbox/publish",
            post(publish),
        )
}
async fn bind(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(i): Json<Bind>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.bind_interactive_team(i)?))
}
async fn binding(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.interactive_team_binding(&id)?))
}
async fn original_source(State(h): State<Arc<Hub>>, headers: HeaderMap, Path(source): Path<String>) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    let id=h.store.interactive_team_original_source_binding(&source)?;
    Ok(Json(h.store.inspect_interactive_team_recovery(&id)?))
}
async fn recovery(State(h): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.inspect_interactive_team_recovery(&id)?))
}
async fn session(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.interactive_team_session(&id)?))
}
async fn claim(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(i): Json<Claim>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.claim_interactive_team_source(&id, i)?))
}
async fn interrupted(State(h):State<Arc<Hub>>,headers:HeaderMap,Path(id):Path<String>,Json(input):Json<Interrupted>)->Result<Json<Value>> {
    admin(&h,&headers)?;
    Ok(Json(h.store.interrupt_interactive_team_source(&id,input)?))
}
async fn finish(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(i): Json<Finish>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.finish_interactive_team_source(&id, i)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
async fn publish(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((id, outbox)): Path<(String, String)>,
    Json(_): Json<Empty>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.publish_interactive_team_reply(&id, &outbox)?))
}

async fn configuration_status(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.team_configuration_acceptance_status(&id)?))
}
async fn configuration_request(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<Option<Value>>> {
    admin(&h, &headers)?;
    Ok(Json(
        h.store
            .team_configuration_acceptance_request(&id, &request)?,
    ))
}
async fn configuration_accept(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(i): Json<crate::messaging::team_configuration_acceptance::Accept>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.accept_team_configuration(&id, i)?))
}
