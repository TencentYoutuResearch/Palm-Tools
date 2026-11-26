//! Extension → host UI feed: badges and notifications an extension backend
//! raises without a page open (an @mention while the team panel is closed).
//! Hosts (Kode GUI) follow it as admin over SSE; the latest badge per panel
//! is replayed to every new follower.
use super::{caller, Error, Result};
use crate::messaging::{model::valid_id, Hub};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::sse::{Event as SseEvent, KeepAlive, Sse},
    Json,
};
use futures_util::Stream;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, convert::Infallible, sync::Arc, time::Duration};

pub struct Feed {
    sender: tokio::sync::broadcast::Sender<Value>,
    badges: Mutex<BTreeMap<(String, String), u32>>,
}

impl Default for Feed {
    fn default() -> Self {
        Self { sender: tokio::sync::broadcast::channel(64).0, badges: Mutex::default() }
    }
}

impl Feed {
    /// Kode's own notifications (bot runs) ride the same feed as extension `kode`.
    pub(super) fn send(&self, message: Value) {
        let _ = self.sender.send(message);
    }

    #[cfg(test)]
    pub(super) fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.sender.subscribe()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Badge {
    panel: String,
    count: u32,
}
pub(super) async fn badge(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(req): Json<Badge>) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("ui.notify")?;
    if !valid_id(&req.panel) {
        return Err(Error(StatusCode::BAD_REQUEST, "invalid panel id".into()));
    }
    let count = req.count.min(9999);
    let feed = &hub.ext.ui;
    let key = (caller.extension.clone(), req.panel.clone());
    if feed.badges.lock().insert(key, count) != Some(count) {
        let _ = feed.sender.send(json!({"type":"badge","extension":caller.extension,"panel":req.panel,"count":count}));
    }
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Notify {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    severity: Option<String>,
    /// Panel to open when the user clicks the notification.
    #[serde(default)]
    panel: Option<String>,
}
pub(super) async fn notify(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(req): Json<Notify>) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("ui.notify")?;
    let severity = req.severity.as_deref().filter(|s| matches!(*s, "info" | "success" | "warning" | "error")).unwrap_or("info");
    if req.title.trim().is_empty() || req.panel.as_deref().is_some_and(|p| !valid_id(p)) {
        return Err(Error(StatusCode::BAD_REQUEST, "a title is required; panel must be a panel id".into()));
    }
    let title: String = req.title.chars().take(120).collect();
    let body: String = req.body.chars().take(500).collect();
    let _ = hub.ext.ui.sender.send(json!({"type":"notify","extension":caller.extension,"title":title,"body":body,"severity":severity,"panel":req.panel}));
    Ok(Json(json!({"ok":true})))
}

pub(super) async fn stream(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
) -> Result<Sse<impl Stream<Item = std::result::Result<SseEvent, Infallible>>>> {
    super::admin(&hub, &h)?;
    let feed = &hub.ext.ui;
    // Subscribe before taking the snapshot so no change falls between them.
    let receiver = feed.sender.subscribe();
    let snapshot: Vec<Value> = feed
        .badges
        .lock()
        .iter()
        .map(|((extension, panel), count)| json!({"type":"badge","extension":extension,"panel":panel,"count":count}))
        .collect();
    let replay = futures_util::stream::iter(snapshot);
    let live = futures_util::stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(message) => return Some((message, receiver)),
                // A slow host misses transient toasts, never a badge's final value
                // for long: the next change carries it.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    use futures_util::StreamExt;
    let events = replay.chain(live).map(|message| Ok(SseEvent::default().data(message.to_string())));
    Ok(Sse::new(events).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
