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
    let Some(bot_def) = roster.bots.iter().find(|b| b.id == bot).cloned() else { return false };
    let Some(main) = bot_def.main_session.clone() else { return false };
    let (except_id, except_uuid) = except.unwrap_or_default();

    let snapshots = ctx.runtimes.snapshots();
    let index = hub
        .store
        .document("dsh-session-index")
        .map(|d| d["value"].clone())
        .unwrap_or_default();
    let aliases = crate::messaging::bot_prompt::build_session_aliases(&index, &snapshots);
    let expanded = crate::messaging::bot_prompt::expand_session_key(&main.session_id, &aliases);

    if let Some(ex_uuid) = except_uuid.as_deref() {
        if expanded.iter().any(|k| k == ex_uuid) {
            return false;
        }
    }

    if let Some(id) = ctx
        .runtimes
        .resolve_live(&main.runtime, &main.session_id, &expanded)
        .filter(|id| *id != except_id)
    {
        tokio::spawn(async move {
            if let Err(e) = ctx.runtimes.command(id, "input", json!({"text": text}), &rid).await {
                tracing::warn!(error=%e, "message not posted to the bot's main conversation");
            }
        });
        return true;
    }

    // A dsh main session (or session bridged to dsh when GUI is down) is woken by dsh itself.
    let dsh_sid = if main.runtime == "dsh" {
        Some(main.session_id.clone())
    } else {
        expanded.iter().find(|k| k.starts_with("session-")).cloned()
    };
    if let Some(session_id) = dsh_sid.filter(|_| ctx.runtimes.available("dsh") && (main.runtime == "dsh" || !ctx.runtimes.available("gui"))) {
        tokio::spawn(async move {
            if let Err(e) = ctx
                .runtimes
                .request("dsh", None, "bot_report", json!({"session_id": session_id, "text": text}), &rid)
                .await
            {
                tracing::warn!(error=%e, "message not delivered to the bot's unloaded dsh conversation");
            }
        });
        return true;
    }

    // A GUI (TUI) main session that was closed/unloaded is resumed directly in GUI.
    if ctx.runtimes.available("gui") && !bot_def.backend_key.is_empty() {
        let resume_uuid = if main.runtime == "gui" && !main.session_id.starts_with("kode:runtime:") {
            Some(main.session_id.clone())
        } else {
            expanded
                .iter()
                .find(|k| !k.starts_with("session-") && !k.starts_with("kode:runtime:"))
                .cloned()
        };
        let root = roster.root();
        let home = bot_def.home(&root);
        let _ = std::fs::create_dir_all(&home);
        let _ = crate::messaging::bot_prompt::repair_bot_skill_links(&home, &bot_def.skills);
        let persona = crate::messaging::bot_prompt::effective_prompt(hub, &bot_def);
        let cwd = home.to_string_lossy().into_owned();
        tokio::spawn(async move {
            let wake_rid = format!("{rid}.wake");
            let mut payload = json!({
                "backend_key": bot_def.backend_key,
                "cwd": cwd,
                "permission_mode": bot_def.permission_ceiling,
                "system_prompt": persona,
                "title": bot_def.name,
            });
            if let Some(model) = &bot_def.model {
                payload["model"] = json!(model);
            }
            if let Some(uuid) = &resume_uuid {
                payload["resume_session_uuid"] = json!(uuid);
            }
            let dto = match ctx.runtimes.request("gui", None, "create_session", payload, &wake_rid).await {
                Ok(dto) => dto,
                Err(e) => {
                    tracing::warn!(error=%e, "failed to wake unloaded GUI main conversation");
                    return;
                }
            };
            let Some(id) = dto["id"].as_u64() else { return };
            let final_text = if resume_uuid.is_some() || dto["system_prompt"] == "applied" {
                text
            } else {
                format!("{persona}\n\n{text}")
            };
            let mut bus = ctx.bus.subscribe();
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
            loop {
                match ctx
                    .runtimes
                    .snapshot(id)
                    .as_ref()
                    .and_then(|s| s["status"].as_str().map(str::to_owned))
                    .as_deref()
                {
                    Some("idle") => {
                        if let Err(e) = ctx.runtimes.command(id, "input", json!({"text": final_text}), &rid).await {
                            tracing::warn!(error=%e, "message not delivered to woken GUI main conversation");
                        }
                        return;
                    }
                    Some("exited") | None => return,
                    _ => {}
                }
                tokio::select! {
                    _ = bus.recv() => {}
                    _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
                    _ = tokio::time::sleep_until(deadline) => return,
                }
            }
        });
        return true;
    }

    false
}
