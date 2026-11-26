//! How bots get the user's attention: notifications (held during quiet hours
//! and released as one) and messages queued into a bot's main conversation.
use crate::messaging::Hub;
use chrono::{Local, Timelike};
use serde_json::{json, Value};

const HELD: &str = "held_notifications";
const MAX_HELD: usize = 30;

fn quiet_now(hub: &Hub) -> bool {
    let now = Local::now();
    crate::messaging::bots::roster(hub).ok().and_then(|(_, roster)| roster.quiet_hours).is_some_and(|quiet| quiet.contains(now.hour() * 60 + now.minute()))
}

pub fn bot_name(hub: &Hub, bot: &str) -> String {
    crate::messaging::bots::roster(hub).ok().and_then(|(_, r)| r.bots.into_iter().find(|b| b.id == bot)).map_or_else(|| bot.to_owned(), |b| b.name)
}

/// Show a notification now, or keep it for after quiet hours.
pub fn notify(hub: &Hub, bot: &str, title: String, body: &str, severity: &str, session: Option<u64>) {
    let note = json!({
        "type":"notify","extension":"kode","title":title,"body":body.chars().take(500).collect::<String>(),
        "severity":severity,"panel":null,"bot":bot,"session_id":session,
    });
    if quiet_now(hub) {
        let mut held = hub.ext.store.state(HELD).ok().flatten().and_then(|v| v.as_array().cloned()).unwrap_or_default();
        held.push(note);
        let excess = held.len().saturating_sub(MAX_HELD);
        held.drain(..excess);
        let _ = hub.ext.store.set_state(HELD, &Value::Array(held));
        return;
    }
    hub.ext.ui.send(note);
}

/// After quiet hours, everything that waited arrives as one notification.
pub fn release_held(hub: &Hub) {
    let Ok(Some(Value::Array(held))) = hub.ext.store.state(HELD) else { return };
    if held.is_empty() || quiet_now(hub) {
        return;
    }
    let _ = hub.ext.store.set_state(HELD, &json!([]));
    let severity = if held.iter().any(|n| n["severity"] != "success") { "warning" } else { "info" };
    let lines: Vec<String> = held.iter().take(8).map(|n| format!("• {}", n["title"].as_str().unwrap_or_default())).collect();
    let more = if held.len() > 8 { format!("\n……另有 {} 条", held.len() - 8) } else { String::new() };
    hub.ext.ui.send(json!({
        "type":"notify","extension":"kode","title":format!("免打扰期间伙伴有 {} 条消息", held.len()),
        "body":format!("{}{more}", lines.join("\n")),"severity":severity,"panel":null,"bot":null,"session_id":null,
    }));
}

/// Queue `text` into the bot's main conversation, where the bot reads it and
/// talks to the user. `except` is a session that must not receive it.
pub fn post_to_main(hub: &Hub, bot: &str, text: String, rid: String, except: Option<(u64, Option<String>)>) -> bool {
    let Some(ctx) = hub.ctx.upgrade() else { return false };
    let Ok((_, roster)) = crate::messaging::bots::roster(hub) else { return false };
    let Some(main) = roster.bots.iter().find(|b| b.id == bot).and_then(|b| b.main_session.clone()) else { return false };
    let (except_id, except_uuid) = except.unwrap_or_default();
    if let Some(id) = ctx.runtimes.find(&main.runtime, &main.session_id).filter(|id| *id != except_id) {
        tokio::spawn(async move {
            if let Err(e) = ctx.runtimes.command(id, "input", json!({"text":text}), &rid).await {
                tracing::warn!(error=%e, "message not posted to the bot's main conversation");
            }
        });
        return true;
    }
    // A dsh main session that is not loaded is woken by dsh itself.
    if main.runtime == "dsh" && ctx.runtimes.available("dsh") && except_uuid.as_deref() != Some(main.session_id.as_str()) {
        let session_id = main.session_id;
        tokio::spawn(async move {
            if let Err(e) = ctx.runtimes.request("dsh", None, "bot_report", json!({"session_id": session_id, "text": text}), &rid).await {
                tracing::warn!(error=%e, "message not delivered to the bot's unloaded main conversation");
            }
        });
        return true;
    }
    false
}
