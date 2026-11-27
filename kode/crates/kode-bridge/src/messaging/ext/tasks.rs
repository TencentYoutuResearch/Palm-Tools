//! Bot tasks: what a bot is tracking for the user. A task may be linked to
//! the conversation doing it; that conversation's turns, questions and exit
//! are reported to the bot, and tasks that stall or run late are raised.
//! Plans (`kind: plan`) wait for the user to approve their steps; drafted
//! outbound messages (`kind: outbound`) wait for the user to send them.
use super::{attention, store::TaskRecord, Error, Result};
use crate::messaging::Hub;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const STATUSES: &[&str] = &["planned", "in_progress", "waiting", "needs_user", "done", "cancelled"];
const KINDS: &[&str] = &["task", "plan", "outbound"];
/// No word from the conversation doing a task for this long raises it.
pub const STALL_MS: u64 = 2 * 3_600_000;
const RECENT_CLOSED_MS: u64 = 7 * 24 * 3_600_000;
const MAX_OPEN: usize = 200;

pub fn status_label(status: &str) -> &'static str {
    match status {
        "planned" => "计划中",
        "in_progress" => "进行中",
        "waiting" => "等待中",
        "needs_user" => "待你处理",
        "done" => "已完成",
        _ => "已取消",
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(super) struct SessionRef {
    pub(super) runtime: String,
    pub(super) session_id: String,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
pub(super) struct Input {
    pub(super) id: Option<String>,
    pub(super) bot: Option<String>,
    pub(super) kind: Option<String>,
    pub(super) title: Option<String>,
    pub(super) detail: Option<String>,
    pub(super) status: Option<String>,
    pub(super) reason: Option<String>,
    pub(super) payload: Option<Value>,
    /// Milliseconds; `0` clears it.
    pub(super) due: Option<u64>,
    pub(super) session: Option<SessionRef>,
    /// Drop the linked conversation.
    pub(super) unlink: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Change {
    Upsert { task: Input },
    Delete { id: String },
    /// Approve a plan: its steps become tasks and the bot is told to start.
    Approve {
        id: String,
        #[serde(default)]
        note: String,
    },
    /// Turn down a plan or a drafted message; the bot is told why.
    Reject {
        id: String,
        #[serde(default)]
        note: String,
    },
}

fn bad(text: impl Into<String>) -> Error {
    Error(StatusCode::BAD_REQUEST, text.into())
}

fn text(value: Option<String>, max: usize, what: &str) -> Result<Option<String>> {
    match value {
        Some(v) if v.chars().count() > max => Err(bad(format!("{what}太长（最多 {max} 字）"))),
        other => Ok(other.map(|v| v.trim().to_owned())),
    }
}

pub(super) fn upsert(hub: &Hub, input: Input) -> Result<TaskRecord> {
    let store = &hub.ext.store;
    let now = crate::now_ms();
    let mut task = match &input.id {
        Some(id) => store.task(id)?.ok_or_else(|| Error(StatusCode::NOT_FOUND, "这个任务已不存在".into()))?,
        None => {
            let bot = input.bot.clone().ok_or_else(|| bad("新任务要指定伙伴"))?;
            let (bot, _) = crate::messaging::bots::resolve(hub, &bot).map_err(|e| Error(StatusCode::NOT_FOUND, e.to_string()))?;
            if store.tasks(Some(&bot.id), u64::MAX)?.len() >= MAX_OPEN {
                return Err(bad(format!("一个伙伴最多同时跟踪 {MAX_OPEN} 个未完成的任务")));
            }
            TaskRecord {
                id: format!("task-{}", uuid::Uuid::new_v4().simple()),
                bot: bot.id,
                kind: "task".into(),
                title: String::new(),
                detail: String::new(),
                status: "planned".into(),
                reason: String::new(),
                payload: json!({}),
                session_id: None,
                session_uuid: None,
                due: None,
                nudged: 0,
                last_activity: now,
                created: now,
                updated: now,
                closed: None,
            }
        }
    };
    if input.id.is_some() && input.bot.as_deref().is_some_and(|bot| bot != task.bot && bot != "default") {
        return Err(bad("任务不能换给别的伙伴"));
    }
    if let Some(kind) = input.kind.filter(|k| *k != task.kind) {
        if input.id.is_some() || !KINDS.contains(&kind.as_str()) {
            return Err(bad("任务类型无效"));
        }
        task.kind = kind;
    }
    if let Some(title) = text(input.title, 200, "标题")? {
        task.title = title;
    }
    if task.title.is_empty() {
        return Err(bad("任务需要标题"));
    }
    if let Some(detail) = text(input.detail, 8000, "说明")? {
        task.detail = detail;
    }
    if let Some(reason) = text(input.reason, 500, "原因")? {
        task.reason = reason;
    }
    if let Some(mut payload) = input.payload {
        if !payload.is_object() || payload.to_string().len() > 16 * 1024 {
            return Err(bad("payload 必须是 16 KiB 以内的对象"));
        }
        if let Some(runtime) = task.payload.get("session_runtime").cloned() {
            payload["session_runtime"] = runtime;
        }
        task.payload = payload;
    }
    if let Some(due) = input.due {
        task.due = (due > 0).then_some(due);
    }
    if input.unlink {
        task.session_id = None;
        task.session_uuid = None;
        if let Some(payload) = task.payload.as_object_mut() {
            payload.remove("session_runtime");
        }
    }
    if let Some(session) = input.session {
        if !crate::messaging::model::valid_id(&session.runtime) || session.session_id.is_empty() || session.session_id.len() > 160 {
            return Err(bad("要关联的会话无效"));
        }
        // A conversation created a moment ago may not be published yet; the
        // link is kept and resolved on the next check (across TUI <-> DSH aliases).
        task.session_id = hub.ctx.upgrade().and_then(|ctx| {
            let snapshots = ctx.runtimes.snapshots();
            let index = hub
                .store
                .document("dsh-session-index")
                .map(|d| d["value"].clone())
                .unwrap_or_default();
            let aliases = crate::messaging::bot_prompt::build_session_aliases(&index, &snapshots);
            let expanded = crate::messaging::bot_prompt::expand_session_key(&session.session_id, &aliases);
            ctx.runtimes.resolve_any(&session.runtime, &session.session_id, &expanded)
        });
        task.payload["session_runtime"] = json!(session.runtime);
        task.session_uuid = Some(session.session_id);
        task.last_activity = now;
        if task.status == "planned" && input.status.is_none() {
            task.status = "in_progress".into();
        }
    }
    let was = task.status.clone();
    if let Some(status) = input.status {
        if !STATUSES.contains(&status.as_str()) {
            return Err(bad(format!("状态只能是 {}", STATUSES.join(", "))));
        }
        task.status = status;
    }
    task.closed = match (task.status.as_str(), task.closed) {
        ("done" | "cancelled", Some(at)) => Some(at),
        ("done" | "cancelled", None) => Some(now),
        _ => None,
    };
    task.updated = now;
    store.save_task(&task)?;
    if task.status == "needs_user" && (was != "needs_user" || input.id.is_none()) {
        let what = match task.kind.as_str() {
            "plan" => "有个计划等你批准",
            "outbound" => "有条消息等你确认发送",
            _ => "需要你处理",
        };
        attention::notify(hub, &task.bot, format!("{} {what}", attention::bot_name(hub, &task.bot)), &task.title, "warning", task.session_id);
    }
    hub.ext.watches.changed();
    Ok(task)
}

fn approve(hub: &Hub, id: &str, note: &str, approved: bool) -> Result<TaskRecord> {
    let store = &hub.ext.store;
    let mut task = store.task(id)?.ok_or_else(|| Error(StatusCode::NOT_FOUND, "这个任务已不存在".into()))?;
    if task.status != "needs_user" {
        return Err(bad("这件事已经处理过了"));
    }
    let note = note.trim().chars().take(2000).collect::<String>();
    let said = if note.is_empty() { String::new() } else { format!("用户说：{note}\n") };
    let now = crate::now_ms();
    let message = if approved {
        if task.kind != "plan" {
            return Err(bad("只有计划可以在这里批准"));
        }
        let mut created = vec![];
        for step in task.payload["steps"].as_array().cloned().unwrap_or_default().iter().take(20) {
            let title: String = step["title"].as_str().unwrap_or_default().trim().chars().take(200).collect();
            if title.is_empty() {
                continue;
            }
            let detail: String = step["detail"].as_str().unwrap_or_default().chars().take(8000).collect();
            let step = upsert(hub, Input { bot: Some(task.bot.clone()), title: Some(title.clone()), detail: Some(detail), ..Default::default() })?;
            created.push(format!("- {}（task_id={}）", title, step.id));
        }
        task.status = "done".into();
        task.reason = "已批准".into();
        format!(
            "【计划已批准 · {}】{said}任务板上已建好这些任务：\n{}\n请按顺序推进：需要别的会话做的，用 kode_sessions_create 派发并填上对应 task_id；随时用 bot_task_update 更新状态，完成后向用户汇报。",
            task.title,
            created.join("\n")
        )
    } else {
        task.status = "cancelled".into();
        task.reason = if note.is_empty() { "用户没有同意".into() } else { note.clone() };
        let what = if task.kind == "outbound" { "你起草的消息没有发送" } else { "这个计划没有被批准" };
        format!("【{what} · {}】{said}请按用户的意见调整；需要的话重新起草或重新提出计划。", task.title)
    };
    task.closed = Some(now);
    task.updated = now;
    store.save_task(&task)?;
    attention::post_to_main(hub, &task.bot, message, format!("task.{}.{}", task.id, task.status), None);
    hub.ext.watches.changed();
    Ok(task)
}

/// A turn, a question or an exit of a conversation doing a task.
pub(super) fn observe(hub: &Hub, session: u64, topic: &str, payload: &Value) {
    if !matches!(topic, "session.turn_completed" | "session.awaiting" | "session.awaiting_cleared" | "session.exited") {
        return;
    }
    let store = &hub.ext.store;
    let Ok(tasks) = store.tasks_by_session(session) else { return };
    if tasks.is_empty() {
        return;
    }
    let title = hub.ctx.upgrade().and_then(|ctx| ctx.runtimes.snapshot(session)).and_then(|dto| dto["title"].as_str().map(str::to_owned)).unwrap_or_else(|| "执行会话".into());
    for mut task in tasks {
        if task.kind != "task" {
            continue;
        }
        let now = crate::now_ms();
        task.last_activity = now;
        let said = |p: &Value| p["final_message"]["text"].as_str().unwrap_or_default().chars().take(1500).collect::<String>();
        let message = match topic {
            "session.awaiting" => {
                task.status = "waiting".into();
                task.reason = format!("「{title}」在等人处理");
                let asked = payload["summary"].as_str().unwrap_or_default();
                Some(format!("【任务 · {}】执行它的会话「{title}」在等人处理：{asked}\n能直接回答的，用 kode_sessions_send 回复它；需要用户决定的，用 bot_task_update 把任务标为 needs_user 并说明，再告诉用户。", task.title))
            }
            "session.awaiting_cleared" if task.status == "waiting" => {
                task.status = "in_progress".into();
                task.reason.clear();
                None
            }
            "session.turn_completed" if payload["outcome"] == "idle" && !said(payload).trim().is_empty() => Some(format!(
                "【任务 · {}】执行它的会话「{title}」完成了一轮，它说：\n{}\n请核对：完成了就用 bot_task_update 标为 done 并向用户汇报结论；没完成就继续跟进。",
                task.title,
                said(payload)
            )),
            "session.exited" => {
                task.status = "waiting".into();
                task.reason = format!("「{title}」已结束");
                let last = store.last_final_message(session).ok().flatten().and_then(|m| m["text"].as_str().map(|t| t.chars().take(1500).collect::<String>())).unwrap_or_default();
                Some(format!("【任务 · {}】执行它的会话「{title}」已经结束。{}\n请判断任务是否完成并更新状态；没完成的话重新派发或告诉用户。", task.title, if last.is_empty() { String::new() } else { format!("它最后说：\n{last}\n") }))
            }
            _ => None,
        };
        task.updated = now;
        let _ = store.save_task(&task);
        if let Some(message) = message {
            attention::post_to_main(hub, &task.bot, message, format!("task.{}.{topic}.{now}", task.id), Some((session, task.session_uuid.clone())));
        }
    }
    hub.ext.watches.changed();
}

/// Raise tasks that ran past their due time or whose conversation went quiet.
pub(super) fn check(hub: &Hub, now: u64) {
    let store = &hub.ext.store;
    let Ok(tasks) = store.tasks(None, u64::MAX) else { return };
    let ctx = hub.ctx.upgrade();
    let aliases = ctx.as_ref().map(|ctx| {
        let snapshots = ctx.runtimes.snapshots();
        let index = hub
            .store
            .document("dsh-session-index")
            .map(|d| d["value"].clone())
            .unwrap_or_default();
        crate::messaging::bot_prompt::build_session_aliases(&index, &snapshots)
    });
    for mut task in tasks.into_iter().filter(|t| t.kind == "task") {
        if task.session_id.is_none() {
            let found = task
                .session_uuid
                .as_deref()
                .zip(task.payload["session_runtime"].as_str())
                .zip(ctx.as_ref())
                .zip(aliases.as_ref())
                .and_then(|(((native, runtime), ctx), aliases)| {
                    let expanded = crate::messaging::bot_prompt::expand_session_key(native, aliases);
                    ctx.runtimes.resolve_any(runtime, native, &expanded)
                });
            if let Some(id) = found {
                task.session_id = Some(id);
                task.last_activity = now;
                let _ = store.save_task(&task);
            }
        }
        let overdue = task.due.is_some_and(|due| due <= now && task.nudged < due);
        let stalled = task.status == "in_progress" && task.session_id.is_some() && now.saturating_sub(task.last_activity) >= STALL_MS && now.saturating_sub(task.nudged) >= STALL_MS;
        if !overdue && !stalled {
            continue;
        }
        let hours = now.saturating_sub(task.last_activity) / 3_600_000;
        let (headline, message) = if overdue {
            ("任务已到期", format!("【任务到期 · {}】这个任务的截止时间已到，状态还是「{}」。请看看进展，能推进就推进；推进不了就告诉用户原因和新的预计时间。", task.title, status_label(&task.status)))
        } else {
            ("任务卡住了", format!("【任务卡住 · {}】执行它的会话已经 {hours} 小时没有动静。请用 kode_sessions_send 问问进展或换个办法推进；需要用户的话标为 needs_user 并告诉用户。", task.title))
        };
        task.nudged = now;
        let _ = store.save_task(&task);
        attention::post_to_main(hub, &task.bot, message, format!("task.{}.nudge.{now}", task.id), None);
        attention::notify(hub, &task.bot, format!("{}：{headline}", attention::bot_name(hub, &task.bot)), &task.title, "warning", task.session_id);
        hub.ext.watches.changed();
    }
}

pub(super) fn view(hub: &Hub, bot: Option<&str>) -> anyhow::Result<Vec<TaskRecord>> {
    hub.ext.store.tasks(bot, crate::now_ms().saturating_sub(RECENT_CLOSED_MS))
}

#[derive(Deserialize)]
pub(super) struct ListQuery {
    bot: Option<String>,
}

pub(super) async fn list(State(hub): State<Arc<Hub>>, h: HeaderMap, Query(q): Query<ListQuery>) -> Result<Json<Value>> {
    super::admin(&hub, &h)?;
    Ok(Json(json!({"tasks": view(&hub, q.bot.as_deref())?})))
}

pub(super) async fn change(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(change): Json<Change>) -> Result<Json<Value>> {
    super::admin(&hub, &h)?;
    let task = match change {
        Change::Upsert { task } => upsert(&hub, task)?,
        Change::Approve { id, note } => approve(&hub, &id, &note, true)?,
        Change::Reject { id, note } => approve(&hub, &id, &note, false)?,
        Change::Delete { id } => {
            if !hub.ext.store.delete_task(&id)? {
                return Err(Error(StatusCode::NOT_FOUND, "这个任务已不存在".into()));
            }
            hub.ext.watches.changed();
            return Ok(Json(json!({"deleted": id})));
        }
    };
    Ok(Json(json!({"task": task})))
}
