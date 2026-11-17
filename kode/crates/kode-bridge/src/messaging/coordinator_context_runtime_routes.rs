//! Dedicated exact-context routes. Owner preparation is not worker execution.
use super::{admin, auth, Error, Principal};
use crate::messaging::{
    collaboration::scoped_thread_create::Create,
    coordinator_context_host_binding as host,
    coordinator_context_inbox::{Claim, Enqueue},
    coordinator_context_input::RecordInput,
    coordinator_context_native_input as native, coordinator_control, Hub,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
type Result<T> = std::result::Result<T, Error>;
fn worker(hub: &Hub, h: &HeaderMap, key: &str) -> Result<String> {
    let Principal::Session(id) = auth(hub, h)? else {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "worker session credential required".into(),
        ));
    };
    hub.store
        .context_worker_identity(key, &id)
        .map_err(|_| Error(StatusCode::FORBIDDEN, "foreign scoped worker".into()))?;
    Ok(id)
}
pub(super) fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/api/v1/messaging/context-v2/threads", post(create))
        .route("/api/v1/messaging/context-v2/contexts/:key", get(context))
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/control",
            get(control).post(bind_control),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/inputs",
            post(input),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/inbox",
            post(enqueue),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/host-binding",
            get(binding).post(bind),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/host-binding/revoke",
            post(revoke),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/source-authority",
            get(authority),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/inbox/claim",
            post(claim),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/inbox/:entry/source",
            get(source),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/native-inputs",
            post(begin),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/native-inputs/:id",
            get(status),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/native-requests/:request",
            get(request_status),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/native-inputs/:id/finish",
            post(finish),
        )
        .route(
            "/api/v1/messaging/context-v2/contexts/:key/native-inputs/:id/publish",
            post(publish),
        )
}
async fn create(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(i): Json<Create>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(h.store.create_scoped_thread(i)?))
}
async fn context(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(k): Path<String>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(json!({"context":h.store.coordinator_context(&k)?})))
}
async fn control(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(k): Path<String>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(
        json!({"control":h.store.context_coordinator_control(&k)?}),
    ))
}
async fn binding(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(k): Path<String>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    Ok(Json(
        json!({"host_binding":h.store.context_host_binding(&k)?}),
    ))
}
macro_rules! owner_write {
    ($name:ident,$dto:ty,$method:ident) => {
        async fn $name(
            State(h): State<Arc<Hub>>,
            headers: HeaderMap,
            Path(k): Path<String>,
            Json(i): Json<$dto>,
        ) -> Result<Json<Value>> {
            admin(&h, &headers)?;
            Ok(Json(h.store.$method(&k, i)?))
        }
    };
}
owner_write!(
    bind_control,
    coordinator_control::Bind,
    bind_context_coordinator_control
);
owner_write!(input, RecordInput, record_context_input);
owner_write!(enqueue, Enqueue, enqueue_context_input);
owner_write!(revoke, host::Revoke, revoke_context_host);
async fn bind(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(k): Path<String>,
    Json(i): Json<host::Bind>,
) -> Result<Json<Value>> {
    admin(&h, &headers)?;
    if i.context_key != k {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "context path mismatch".into(),
        ));
    }
    Ok(Json(h.store.bind_context_host(i)?))
}
async fn authority(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(k): Path<String>,
) -> Result<Json<Value>> {
    let s = worker(&h, &headers, &k)?;
    Ok(Json(h.store.context_source_authority(&k, &s)?))
}
async fn claim(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(k): Path<String>,
    Json(i): Json<Claim>,
) -> Result<Json<Value>> {
    let s = worker(&h, &headers, &k)?;
    Ok(Json(h.store.claim_context_input_for_worker(&k, &s, i)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceQuery {
    claim_id: String,
}
async fn source(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((k, e)): Path<(String, String)>,
    Query(q): Query<SourceQuery>,
) -> Result<Json<Value>> {
    let s = worker(&h, &headers, &k)?;
    Ok(Json(h.store.context_source_for_worker(
        &k,
        &s,
        &e,
        &q.claim_id,
    )?))
}
async fn begin(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(k): Path<String>,
    Json(i): Json<native::Begin>,
) -> Result<Json<Value>> {
    let s = worker(&h, &headers, &k)?;
    if i.context_key != k || i.session_id != s {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "native worker identity mismatch".into(),
        ));
    }
    Ok(Json(h.store.begin_native_context_input(i)?))
}
async fn status(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((k, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    worker(&h, &headers, &k)?;
    Ok(Json(h.store.native_context_input_status(&k, &id)?))
}
async fn request_status(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((k, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    worker(&h, &headers, &k)?;
    Ok(Json(h.store.native_context_request_status(&k, &id)?))
}
async fn finish(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((k, id)): Path<(String, String)>,
    Json(i): Json<native::Finish>,
) -> Result<Json<Value>> {
    worker(&h, &headers, &k)?;
    if i.admission_id != id {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "native admission path mismatch".into(),
        ));
    }
    Ok(Json(h.store.finish_native_context_input(&k, i)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
async fn publish(
    State(h): State<Arc<Hub>>,
    headers: HeaderMap,
    Path((k, id)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    worker(&h, &headers, &k)?;
    if !body.is_empty() {
        serde_json::from_slice::<Empty>(&body).map_err(|_| {
            Error(
                StatusCode::BAD_REQUEST,
                "publication accepts no destination or payload".into(),
            )
        })?;
    }
    Ok(Json(h.store.publish_native_context_reply(&k, &id)?))
}
