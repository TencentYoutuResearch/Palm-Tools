//! Owner-authenticated Host identity administration. Registration never grants runtime authority.
use super::{admin, Error};
use crate::messaging::{
    runtime_host_enrollment::{Challenge, Register, Revoke},
    Hub,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use std::sync::Arc;
type Result<T> = std::result::Result<T, Error>;

pub(in crate::messaging) fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route(
            "/api/v1/messaging/runtime-host-v1/challenges",
            post(challenge),
        )
        .route(
            "/api/v1/messaging/runtime-host-v1/enrollments",
            post(register),
        )
        .route(
            "/api/v1/messaging/runtime-host-v1/revocations",
            post(revoke),
        )
        .route(
            "/api/v1/messaging/runtime-host-v1/enrollments/:id",
            get(status),
        )
        .route(
            "/api/v1/messaging/runtime-host-v1/register-requests/:id",
            get(register_status),
        )
}
async fn challenge(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(input): Json<Challenge>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.challenge_runtime_host(input)?))
}
async fn register(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(input): Json<Register>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.register_runtime_host(input)?))
}
async fn revoke(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(input): Json<Revoke>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.revoke_runtime_host(input)?))
}
async fn status(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.runtime_host_status(&id)?))
}
async fn register_status(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    admin(&hub, &headers)?;
    Ok(Json(hub.store.runtime_host_register_status(&id)?))
}
