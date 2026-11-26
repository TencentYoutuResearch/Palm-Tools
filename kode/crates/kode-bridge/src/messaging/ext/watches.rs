//! Bot watches ("关注"): a bot wakes up on events or at set times.
//!
//! One dispatcher follows the durable extension event log (session turns,
//! file/Git changes from [`fswatch`], events extensions publish) and a clock
//! for time triggers ([`schedule`]), matches each event against enabled
//! watches, folds bursts per watch, and runs the bot in
//! the watch's own session - in dsh when it is up, else in the GUI runtime.
//! Later runs of a watch continue that session while it stays open, so one
//! kind of event keeps one conversation. The run's first completed turn
//! after its task is its result; the run log is
//! the bot's 动态 feed. Loops are cut three ways: run sessions never trigger
//! watches, a bot's own file edits do not wake it again, and every watch has
//! an hourly budget.
use super::{
    caller, ctx, deliver_initial, fswatch::FsWatch, schedule::Cron, store::{RunRecord, WatchRecord}, watch_spec::{self, Spec},
    Error, Gateway, Result,
};
use chrono::{DateTime, Local, TimeZone};
use crate::messaging::Hub;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

const MAX_BATCH: usize = 20;
const HOUR_MS: u64 = 3_600_000;
/// A run's own edits keep arriving for a moment after it finishes.
const SELF_QUIET: Duration = Duration::from_secs(10);
const RETRY: Duration = Duration::from_secs(15);
const SUMMARY_CHARS: usize = 4000;
const MAX_PUBLISH_BYTES: usize = 16 * 1024;
/// Extra 30 s waits for a run session to start (about three minutes in all).
const START_PATIENCE: usize = 5;
/// A time trigger missed while Kode was off runs once if it is this recent.
const CATCH_UP_MS: i64 = 12 * 3_600_000;
/// How often stalled and late tasks, and held notifications, are looked at.
const TASK_CHECK: Duration = Duration::from_secs(60);

/// Shared between the dispatcher and the API.
pub struct Signals {
    pub wake: tokio::sync::Notify,
    dirty: std::sync::atomic::AtomicBool,
    /// Bumped on every change a viewer should see (watches, runs).
    revision: tokio::sync::watch::Sender<u64>,
    /// Watches the user asked to run now.
    manual: parking_lot::Mutex<Vec<String>>,
}
impl Default for Signals {
    fn default() -> Self {
        Self { wake: Default::default(), dirty: true.into(), revision: tokio::sync::watch::channel(0).0, manual: Default::default() }
    }
}
impl Signals {
    pub(super) fn changed(&self) {
        self.revision.send_modify(|r| *r += 1);
    }
    fn reload(&self) {
        self.dirty.store(true, Ordering::Relaxed);
        self.changed();
        self.wake.notify_one();
    }
}

struct Watch {
    id: String,
    bot: String,
    spec: Spec,
}

struct Batch {
    events: Vec<(String, Value)>,
    dropped: usize,
    due: Instant,
}

#[derive(Default)]
struct Dispatcher {
    watches: Vec<Watch>,
    pending: HashMap<String, Batch>,
    /// Bot → workspaces its runs are editing (`None` = still running).
    busy: HashMap<String, Vec<(PathBuf, Option<Instant>)>>,
    /// Time triggers: watch → (cron, next time it fires).
    clocks: HashMap<String, (String, DateTime<Local>)>,
    /// When stalled and late tasks were last looked for.
    checked: Option<Instant>,
}

pub fn spawn(hub: Arc<Hub>) {
    tokio::spawn(async move {
        let weak = Arc::downgrade(&hub);
        let fs = Arc::new(FsWatch::new(Arc::new(move |topic: &str, payload| {
            if let Some(hub) = weak.upgrade() {
                if let Err(e) = hub.ext.append(0, topic, payload) {
                    tracing::warn!(error=%e, "file event not recorded");
                }
            }
        })));
        let gateway = &hub.ext;
        let mut cursor = match gateway.store.state("watch_cursor") {
            Ok(Some(value)) => value.as_u64().unwrap_or(0),
            _ => gateway.store.latest_seq(),
        };
        let mut latest = gateway.latest.subscribe();
        let mut state = Dispatcher::default();
        recover(&hub, &mut state);
        while !gateway.stopped.load(Ordering::Relaxed) {
            if gateway.watches.dirty.swap(false, Ordering::Relaxed) {
                state.reload(gateway, &fs);
            }
            for id in std::mem::take(&mut *gateway.watches.manual.lock()) {
                let batch = state.pending.entry(id).or_insert_with(|| Batch { events: vec![], dropped: 0, due: Instant::now() });
                batch.events.push(("manual".into(), json!({})));
                batch.due = Instant::now();
            }
            latest.borrow_and_update();
            if let Err(e) = follow(&hub, &mut state, &mut cursor).await {
                tracing::warn!(error=%e, "bot watch dispatch failed");
            }
            state.tick_clocks(gateway, Local::now());
            if state.checked.map_or(true, |at| at.elapsed() >= TASK_CHECK) {
                state.checked = Some(Instant::now());
                super::tasks::check(&hub, crate::now_ms());
                super::attention::release_held(&hub);
            }
            fire(&hub, &mut state).await;
            let clock = state.clocks.values().map(|(_, next)| (*next - Local::now()).to_std().unwrap_or_default()).min();
            let wait = state.pending.values().map(|b| b.due.saturating_duration_since(Instant::now())).chain(clock).min().unwrap_or(Duration::MAX).min(Duration::from_secs(60));
            tokio::select! {
                changed = latest.changed() => if changed.is_err() { return },
                _ = tokio::time::sleep(wait) => {}
                _ = gateway.watches.wake.notified() => {}
                _ = gateway.wake.notified() => {}
            }
        }
    });
}

impl Dispatcher {
    fn reload(&mut self, gateway: &Gateway, fs: &Arc<FsWatch>) {
        let records = gateway.store.watches().unwrap_or_else(|e| {
            tracing::warn!(error=%e, "bot watches unreadable");
            vec![]
        });
        self.watches = records
            .into_iter()
            .filter(|w| w.enabled)
            .filter_map(|w| Some(Watch { spec: serde_json::from_value(w.spec).ok()?, id: w.id, bot: w.bot }))
            .collect();
        let live: HashSet<&str> = self.watches.iter().map(|w| w.id.as_str()).collect();
        self.pending.retain(|id, _| live.contains(id.as_str()));
        let roots = self
            .watches
            .iter()
            .filter(|w| w.spec.on.topic.starts_with("fs.") || w.spec.on.topic.starts_with("git."))
            .filter_map(|w| w.spec.on.conditions.get("workspace")?.as_str().map(PathBuf::from))
            .map(|p| p.canonicalize().unwrap_or(p))
            .collect();
        fs.sync(roots);
        self.reload_clocks(gateway, Local::now());
    }

    /// Next firing time of every time trigger. A slot missed while Kode was
    /// off runs once now if it is recent; older ones are skipped.
    fn reload_clocks(&mut self, gateway: &Gateway, now: DateTime<Local>) {
        let mut clocks = HashMap::new();
        for watch in &self.watches {
            let Some(expr) = watch.spec.cron() else { continue };
            if let Some(kept) = self.clocks.get(&watch.id).filter(|(old, _)| old == expr) {
                clocks.insert(watch.id.clone(), kept.clone());
                continue;
            }
            let Ok(cron) = Cron::parse(expr) else { continue };
            let key = format!("schedule:{}", watch.id);
            let last = gateway.store.state(&key).ok().flatten().and_then(|v| v.as_i64()).and_then(|ms| Local.timestamp_millis_opt(ms).single());
            if let Some(slot) = last.and_then(|last| cron.next_after(last)).filter(|slot| *slot <= now) {
                if (now - slot).num_milliseconds() <= CATCH_UP_MS {
                    let batch = self.pending.entry(watch.id.clone()).or_insert_with(|| Batch { events: vec![], dropped: 0, due: Instant::now() });
                    batch.events.push(("schedule".into(), json!({"cron":expr,"scheduled_at":slot.timestamp_millis(),"missed":true})));
                    batch.due = Instant::now();
                }
            }
            if last.is_none() || last.is_some_and(|last| cron.next_after(last).is_some_and(|slot| slot <= now)) {
                let _ = gateway.store.set_state(&key, &json!(now.timestamp_millis()));
            }
            if let Some(next) = cron.next_after(now) {
                clocks.insert(watch.id.clone(), (expr.to_owned(), next));
            }
        }
        self.clocks = clocks;
    }

    fn tick_clocks(&mut self, gateway: &Gateway, now: DateTime<Local>) {
        let Self { clocks, pending, .. } = self;
        for (id, (expr, next)) in clocks.iter_mut() {
            if *next > now {
                continue;
            }
            let batch = pending.entry(id.clone()).or_insert_with(|| Batch { events: vec![], dropped: 0, due: Instant::now() });
            batch.events.push(("schedule".into(), json!({"cron":expr,"scheduled_at":next.timestamp_millis()})));
            batch.due = Instant::now();
            let _ = gateway.store.set_state(&format!("schedule:{id}"), &json!(now.timestamp_millis()));
            *next = Cron::parse(expr).ok().and_then(|cron| cron.next_after(now)).unwrap_or(now + chrono::Duration::days(1));
        }
    }

    /// Is this file event the bot's own run at work?
    fn own_edit(&mut self, bot: &str, workspace: &str) -> bool {
        let now = Instant::now();
        let Some(list) = self.busy.get_mut(bot) else { return false };
        list.retain(|(_, until)| until.map_or(true, |at| at > now));
        let path = Path::new(workspace);
        list.iter().any(|(root, _)| path.starts_with(root) || root.starts_with(path))
    }

    fn settle(&mut self, bot: &str, workspace: Option<&str>) {
        let Some(workspace) = workspace else { return };
        if let Some(list) = self.busy.get_mut(bot) {
            for (root, until) in list.iter_mut() {
                if root.as_os_str() == workspace && until.is_none() {
                    *until = Some(Instant::now() + SELF_QUIET);
                    return;
                }
            }
        }
    }
}

/// Runs open across a restart: still-running sessions keep being followed
/// (the log cursor is durable); ones that never started or vanished end.
fn recover(hub: &Hub, state: &mut Dispatcher) {
    let Ok(runs) = hub.ext.store.open_runs() else { return };
    let ctx = hub.ctx.upgrade();
    for run in runs {
        let alive = run.session_id.zip(ctx.as_ref()).and_then(|(id, ctx)| ctx.runtimes.snapshot(id)).is_some_and(|dto| dto["status"] != "exited");
        if alive {
            if let Some(workspace) = &run.workspace {
                state.busy.entry(run.bot.clone()).or_default().push((workspace.into(), None));
            }
        } else if crate::now_ms().saturating_sub(run.started) > 120_000 {
            let _ = hub.ext.store.finish_run(&run.id, "failed", "", Some("Kode 重启时这次运行没有在继续"));
        }
    }
}

async fn follow(hub: &Arc<Hub>, state: &mut Dispatcher, cursor: &mut u64) -> anyhow::Result<()> {
    let gateway = &hub.ext;
    let start = *cursor;
    loop {
        let batch = gateway.store.events(*cursor, None, None, 500)?;
        for event in &batch {
            *cursor = event.seq;
            observe(hub, state, event.session_id, &event.kind, &event.payload);
        }
        if batch.len() < 500 {
            break;
        }
    }
    if *cursor != start {
        gateway.store.set_state("watch_cursor", &json!(*cursor))?;
    }
    Ok(())
}

fn observe(hub: &Hub, state: &mut Dispatcher, session: u64, topic: &str, payload: &Value) {
    let gateway = &hub.ext;
    let payload = if session == 0 {
        payload.clone()
    } else {
        super::tasks::observe(hub, session, topic, payload);
        if let Ok(Some(run)) = gateway.store.run_by_session(session) {
            follow_run(hub, state, &run, topic, payload);
            return;
        }
        if !matches!(topic, "session.turn_completed" | "session.awaiting" | "session.exited") {
            return;
        }
        enrich(hub, session, payload)
    };
    let workspace = payload["workspace"].as_str().map(str::to_owned);
    // A bot's own main conversation never wakes that bot: run results are
    // posted there, and its replies must not start another run.
    let own_bot = if session == 0 { None } else { main_owner(hub, session) };
    for index in 0..state.watches.len() {
        let watch = &state.watches[index];
        if !watch.spec.matches(topic, &payload) || own_bot.as_deref() == Some(watch.bot.as_str()) {
            continue;
        }
        let (id, bot, coalesce) = (watch.id.clone(), watch.bot.clone(), watch.spec.policy.coalesce_secs);
        if (topic.starts_with("fs.") || topic.starts_with("git.")) && workspace.as_deref().is_some_and(|w| state.own_edit(&bot, w)) {
            continue;
        }
        let batch = state.pending.entry(id).or_insert_with(|| Batch { events: vec![], dropped: 0, due: Instant::now() + Duration::from_secs(coalesce) });
        if batch.events.len() >= MAX_BATCH {
            batch.events.remove(0);
            batch.dropped += 1;
        }
        batch.events.push((topic.to_owned(), payload.clone()));
    }
}

fn main_owner(hub: &Hub, session: u64) -> Option<String> {
    let ctx = hub.ctx.upgrade()?;
    let (_, roster) = crate::messaging::bots::roster(hub).ok()?;
    roster.bots.into_iter().find(|bot| bot.main_session.as_ref().is_some_and(|m| ctx.runtimes.find(&m.runtime, &m.session_id) == Some(session))).map(|bot| bot.id)
}

/// Session events carry who and where, so watches can filter on them.
fn enrich(hub: &Hub, session: u64, payload: &Value) -> Value {
    let mut payload = payload.clone();
    payload["session_id"] = json!(session);
    if let Some(dto) = hub.ctx.upgrade().and_then(|ctx| ctx.runtimes.snapshot(session)) {
        for key in ["title", "cwd", "backend_key", "runtime"] {
            if !dto[key].is_null() {
                payload[key] = dto[key].clone();
            }
        }
    }
    if let Ok(Some(owner)) = hub.ext.store.owner(session) {
        payload["labels"] = json!(owner.labels);
        payload["extension"] = json!(owner.extension);
    }
    // An exit or a question carries what the session last concluded, so the
    // bot has something to work from.
    if payload["final_message"].is_null() {
        if let Ok(Some(last)) = hub.ext.store.last_final_message(session) {
            payload["final_message"] = last;
        }
    }
    payload
}

fn follow_run(hub: &Hub, state: &mut Dispatcher, run: &RunRecord, topic: &str, payload: &Value) {
    if run.finished.is_some() {
        return;
    }
    let store = &hub.ext.store;
    let watch = state.watches.iter().find(|w| w.id == run.watch_id);
    let policy = watch.map(|w| w.spec.policy.notify.clone()).unwrap_or_else(|| "attention".into());
    let report = watch.filter(|w| w.spec.policy.report_to_main).map(|w| w.spec.name.clone());
    let outcome = match topic {
        "session.turn_completed" if payload["outcome"] == "idle" => {
            let summary: String = payload["final_message"]["text"].as_str().unwrap_or_default().chars().take(SUMMARY_CHARS).collect();
            let _ = store.finish_run(&run.id, "completed", &summary, None);
            if let Some(name) = report.filter(|_| !summary.trim().is_empty()) {
                report_to_main(hub, run, &name, &summary);
            }
            Some(("completed", summary))
        }
        "session.turn_completed" | "session.exited" => {
            let _ = store.finish_run(&run.id, "failed", "", Some("运行会话提前结束了"));
            Some(("failed", String::new()))
        }
        "session.awaiting" => {
            let _ = store.set_run_status(&run.id, "needs_user");
            notify(hub, run, "needs_user", payload["summary"].as_str().unwrap_or("伙伴需要你确认一下"), &policy);
            hub.ext.watches.changed();
            return;
        }
        "session.awaiting_cleared" => {
            let _ = store.set_run_status(&run.id, "running");
            hub.ext.watches.changed();
            return;
        }
        _ => None,
    };
    if let Some((status, summary)) = outcome {
        state.settle(&run.bot, run.workspace.as_deref());
        notify(hub, run, status, &summary, &policy);
        hub.ext.watches.changed();
        // A batch held back while this run worked may go now.
        if let Some(batch) = state.pending.get_mut(&run.watch_id) {
            batch.due = batch.due.min(Instant::now());
        }
    }
}

/// The conclusion goes to the bot's main conversation as a queued message,
/// so the bot summarizes and reports what happened directly to the user.
fn report_to_main(hub: &Hub, run: &RunRecord, watch: &str, summary: &str) {
    let text = format!(
        "【关注 · {watch}】你在独立会话里完成了这次关注任务，原始结论如下。请提炼核心结论、关键改动/发现以及需要用户决定的事项，用简明清晰的话直接汇报给用户（无需重复派发或给子会话发回执）：\n\n{}",
        summary.chars().take(SUMMARY_CHARS).collect::<String>()
    );
    // The run itself never reports into itself.
    let except = run.session_id.map(|id| (id, run.session_uuid.clone()));
    super::attention::post_to_main(hub, &run.bot, text, format!("watch.{}.main", run.id), except);
}

fn notify(hub: &Hub, run: &RunRecord, status: &str, text: &str, policy: &str) {
    let wanted = match policy {
        "always" => true,
        "attention" => status != "completed",
        _ => false,
    };
    if !wanted {
        return;
    }
    let name = super::attention::bot_name(hub, &run.bot);
    let (title, severity) = match status {
        "completed" => (format!("{name} 完成了一次关注任务"), "success"),
        "needs_user" => (format!("{name} 在等你处理"), "warning"),
        _ => (format!("{name} 的关注任务没有完成"), "error"),
    };
    super::attention::notify(hub, &run.bot, title, text, severity, run.session_id);
}

/// Start runs for batches whose window closed, within each watch's budget.
async fn fire(hub: &Arc<Hub>, state: &mut Dispatcher) {
    let now = Instant::now();
    let due: Vec<String> = state.pending.iter().filter(|(_, b)| b.due <= now).map(|(id, _)| id.clone()).collect();
    for id in due {
        let Some(watch) = state.watches.iter().find(|w| w.id == id) else {
            state.pending.remove(&id);
            continue;
        };
        let store = &hub.ext.store;
        let running = store.open_runs().map(|runs| runs.iter().any(|r| r.watch_id == id)).unwrap_or(false);
        let spent = store.runs_since(&id, crate::now_ms().saturating_sub(HOUR_MS)).unwrap_or(0);
        if running || spent >= watch.spec.policy.max_runs_per_hour {
            // One run per watch at a time; the budget refills over the hour.
            if let Some(batch) = state.pending.get_mut(&id) {
                batch.due = now + if running { RETRY } else { Duration::from_secs(60) };
            }
            continue;
        }
        let batch = state.pending.remove(&id).unwrap();
        let (bot, spec) = (watch.bot.clone(), watch.spec.clone());
        match start(hub, &id, &bot, &spec, batch.events, batch.dropped).await {
            Ok(workspace) => state.busy.entry(bot).or_default().push((workspace, None)),
            Err(e) => tracing::warn!(error=%e, watch=%id, "bot watch run did not start"),
        }
        hub.ext.watches.changed();
    }
}

fn run_text(spec: &Spec, events: &[(String, Value)], dropped: usize, last: Option<String>) -> String {
    let kind = if events.iter().all(|(topic, _)| topic == "schedule") { "定时" } else { "由事件触发的" };
    let mut text = format!("【关注 · {}】这是一次{kind}自动运行，没有人在实时看着。\n\n发生了什么：\n", spec.name);
    for (topic, payload) in events {
        text.push_str(&format!("- {}\n", watch_spec::describe(topic, payload)));
    }
    if dropped > 0 {
        text.push_str(&format!("- ……另有 {dropped} 个更早的同类事件\n"));
    }
    if let Some(last) = last.filter(|_| spec.policy.carry_last_summary) {
        text.push_str(&format!("\n上一次运行的结论：\n{}\n", last.chars().take(1500).collect::<String>()));
    }
    text.push_str(&format!("\n你要做的：\n{}\n\n完成后用几句话写清结论；需要人来决定的事单独列出来。", spec.instructions.trim()));
    if let Some(chat) = &spec.policy.post_to_wecom {
        text.push_str(&format!("\n最后用 wecom_message_send 把这份汇报发到企业微信会话 chat_id={chat}（先结论后细节，适合在手机上读）。"));
    }
    text
}

/// Where the run works: the policy's choice, else where the event happened
/// (when that folder exists here), else the bot's own folder.
fn workspace_for(spec: &Spec, events: &[(String, Value)], bot: &crate::messaging::bots::Bot, root: &Path) -> anyhow::Result<PathBuf> {
    if let Some(path) = &spec.policy.workspace {
        return Ok(path.into());
    }
    let near = events.last().and_then(|(_, p)| p["workspace"].as_str().or(p["cwd"].as_str())).map(PathBuf::from).filter(|p| p.is_dir());
    match near {
        Some(path) => Ok(path),
        None => bot.ensure_workspace(root),
    }
}

async fn start(hub: &Arc<Hub>, watch: &str, bot_id: &str, spec: &Spec, events: Vec<(String, Value)>, dropped: usize) -> anyhow::Result<PathBuf> {
    let store = &hub.ext.store;
    let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
    let mut run = RunRecord {
        id: run_id.clone(),
        watch_id: watch.into(),
        bot: bot_id.into(),
        status: "starting".into(),
        trigger: json!({"events":events.iter().map(|(t, p)| json!({"topic":t,"summary":watch_spec::describe(t, p)})).collect::<Vec<_>>(),"dropped":dropped}),
        session_id: None,
        session_uuid: None,
        workspace: None,
        summary: String::new(),
        error: None,
        seen: false,
        started: crate::now_ms(),
        finished: None,
    };
    let prepared = (|| {
        let (bot, root) = crate::messaging::bots::resolve(hub, bot_id)?;
        let workspace = workspace_for(spec, &events, &bot, &root)?;
        Ok::<_, anyhow::Error>((bot, workspace))
    })();
    let (bot, workspace) = match prepared {
        Ok(prepared) => prepared,
        Err(e) => {
            store.insert_run(&run)?;
            store.finish_run(&run_id, "failed", "", Some(&e.to_string()))?;
            return Err(e);
        }
    };
    run.workspace = Some(workspace.to_string_lossy().into_owned());
    store.insert_run(&run)?;
    let reuse = reusable(hub, watch, &workspace);
    // A continued session already remembers the last conclusion.
    let last = if reuse.is_some() { None } else { store.last_summary(watch)? };
    let text = run_text(spec, &events, dropped, last);
    let launched = match reuse {
        Some(session) => resume(hub, session, text, &run_id).await,
        None => {
            // Never above the bot's ceiling: a lower ceiling wins.
            let permission = crate::messaging::bots::effective_permission(Some(&spec.policy.permission), &bot.permission_ceiling).unwrap_or_else(|_| bot.permission_ceiling.clone());
            let title = format!("{} · {}", bot.name, spec.name);
            launch(hub, &bot, &workspace, &permission, &title, text, &run_id).await
        }
    };
    match launched {
        Ok((session, uuid)) => {
            store.run_started(&run_id, session, uuid.as_deref())?;
            Ok(workspace)
        }
        Err(e) => {
            store.finish_run(&run_id, "failed", "", Some(&e.to_string()))?;
            Err(e)
        }
    }
}

/// One watch keeps one conversation: its earlier session, while it is still
/// open in the same folder and its runtime is up, takes the next run instead
/// of a new session.
fn reusable(hub: &Hub, watch: &str, workspace: &Path) -> Option<(u64, Option<String>)> {
    let last = hub.ext.store.last_session_run(watch).ok()??;
    let id = last.session_id?;
    if last.workspace.as_deref() != Some(&*workspace.to_string_lossy()) {
        return None;
    }
    let ctx = hub.ctx.upgrade()?;
    let dto = ctx.runtimes.snapshot(id).filter(|dto| dto["status"] != "exited")?;
    if !dto["runtime"].as_str().is_some_and(|runtime| ctx.runtimes.available(runtime)) {
        return None;
    }
    Some((id, last.session_uuid))
}

async fn resume(hub: &Arc<Hub>, (id, uuid): (u64, Option<String>), text: String, run: &str) -> anyhow::Result<(u64, Option<String>)> {
    let ctx = hub.ctx.upgrade().ok_or_else(|| anyhow::anyhow!("Kode is stopping"))?;
    ctx.runtimes.command(id, "input", json!({"text":text}), &format!("watch.{run}.in")).await?;
    Ok((id, uuid))
}

/// A fresh session for the run: dsh when it is running (where bots live),
/// else the GUI runtime.
async fn launch(hub: &Arc<Hub>, bot: &crate::messaging::bots::Bot, workspace: &Path, permission: &str, title: &str, text: String, run: &str) -> anyhow::Result<(u64, Option<String>)> {
    let ctx = hub.ctx.upgrade().ok_or_else(|| anyhow::anyhow!("Kode is stopping"))?;
    let rid = format!("watch.{run}");
    let cwd = workspace.to_string_lossy();
    if ctx.runtimes.available("dsh") {
        let payload = json!({"bot_id":bot.id,"task":text,"workspace":cwd,"permission":permission,"title":title});
        let value = request_patiently(&ctx, "dsh", "bot_run", payload, &rid).await?;
        let id = value["id"].as_u64().ok_or_else(|| anyhow::anyhow!("dsh did not return the run session"))?;
        return Ok((id, value["runtime_session_id"].as_str().map(str::to_owned)));
    }
    if !ctx.runtimes.available("gui") {
        anyhow::bail!("Kode 和 dsh 都没有在运行，伙伴没法开始");
    }
    std::fs::create_dir_all(workspace)?;
    let persona = bot.persona_prompt();
    let payload = json!({"backend_key":bot.backend_key,"cwd":cwd,"model":bot.model,"permission_mode":permission,"system_prompt":persona});
    let dto = request_patiently(&ctx, "gui", "create_session", payload, &rid).await?;
    let id = dto["id"].as_u64().ok_or_else(|| anyhow::anyhow!("runtime did not return a session"))?;
    let text = if dto["system_prompt"] == "applied" { text } else { format!("{persona}\n\n{text}") };
    tokio::spawn(deliver_initial(hub.clone(), ctx.clone(), id, text, format!("{rid}.in")));
    Ok((id, None))
}

/// Starting an Agent can outlast one runtime request (30 s). The same request
/// id is idempotent, so asking again picks up the outcome instead of
/// starting a second session.
async fn request_patiently(ctx: &crate::Ctx, runtime: &str, kind: &str, payload: Value, rid: &str) -> anyhow::Result<Value> {
    let mut attempt = 0;
    loop {
        match ctx.runtimes.request(runtime, None, kind, payload.clone(), rid).await {
            Err(e) if attempt < START_PATIENCE && e.to_string().contains("outcome unconfirmed") => attempt += 1,
            other => return other,
        }
    }
}

// ---- API ------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Publish {
    name: String,
    #[serde(default)]
    payload: Value,
}
/// `POST /api/ext/v1/events/publish`: an extension's own event, as topic
/// `<extension>/<name>`, for bots to watch.
pub(super) async fn publish(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(req): Json<Publish>) -> Result<Json<Value>> {
    let caller = caller(&hub, &h)?;
    caller.require("events.publish")?;
    let name_ok = !req.name.is_empty() && req.name.len() <= 64 && req.name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b));
    if !name_ok {
        return Err(Error(StatusCode::BAD_REQUEST, "event name: 1–64 of a-z 0-9 - _ .".into()));
    }
    let payload = if req.payload.is_null() { json!({}) } else { req.payload };
    if !payload.is_object() || payload.to_string().len() > MAX_PUBLISH_BYTES {
        return Err(Error(StatusCode::BAD_REQUEST, format!("payload must be an object under {MAX_PUBLISH_BYTES} bytes")));
    }
    let topic = format!("{}/{}", caller.extension, req.name);
    hub.ext.append(0, &topic, payload)?;
    Ok(Json(json!({"topic":topic})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkbenchPublish {
    topic: String,
    #[serde(default)]
    payload: Value,
}
/// `POST /api/v1/messaging/workbench/events`: host-owner bridge event ingress (e.g. `wecom/message`).
pub(super) async fn workbench_publish(
    State(hub): State<Arc<Hub>>,
    h: HeaderMap,
    Json(req): Json<WorkbenchPublish>,
) -> Result<Json<Value>> {
    super::admin(&hub, &h)?;
    let valid = req.topic.split_once('/').is_some_and(|(ns, name)| {
        crate::messaging::model::valid_id(ns)
            && !name.is_empty()
            && name.len() <= 64
            && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
    });
    if !valid {
        return Err(Error(StatusCode::BAD_REQUEST, "topic must be <namespace>/<name>".into()));
    }
    let payload = if req.payload.is_null() { json!({}) } else { req.payload };
    if !payload.is_object() || payload.to_string().len() > MAX_PUBLISH_BYTES {
        return Err(Error(StatusCode::BAD_REQUEST, format!("payload must be an object under {MAX_PUBLISH_BYTES} bytes")));
    }
    hub.ext.append(0, &req.topic, payload)?;
    Ok(Json(json!({"topic": req.topic})))
}

#[derive(Deserialize)]
pub(super) struct ListQuery {
    bot: Option<String>,
    /// Long poll: answer once the revision passes this (or after 25 s).
    after: Option<u64>,
}
pub(super) async fn list(State(hub): State<Arc<Hub>>, h: HeaderMap, Query(q): Query<ListQuery>) -> Result<Json<Value>> {
    super::admin(&hub, &h)?;
    if let Some(after) = q.after {
        let mut rx = hub.ext.watches.revision.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(25), rx.wait_for(|r| *r > after)).await;
    }
    Ok(Json(view(&hub, q.bot.as_deref())?))
}

fn view(hub: &Hub, bot: Option<&str>) -> anyhow::Result<Value> {
    let store = &hub.ext.store;
    let watches: Vec<Value> = store
        .watches()?
        .into_iter()
        .filter(|w| bot.map_or(true, |b| w.bot == b))
        .map(|w| json!({"id":w.id,"bot":w.bot,"enabled":w.enabled,"spec":w.spec,"updated":w.updated}))
        .collect();
    let unseen: serde_json::Map<String, Value> = store.unseen()?.into_iter().map(|(bot, n)| (bot, json!(n))).collect();
    Ok(json!({
        "revision": *hub.ext.watches.revision.borrow(),
        "watches": watches,
        "runs": store.runs(bot, 50)?,
        "tasks": super::tasks::view(hub, bot)?,
        "unseen": unseen,
        "topics": watch_spec::BUILTIN_TOPICS,
    }))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Change {
    Upsert {
        #[serde(default)]
        id: Option<String>,
        bot: String,
        spec: Value,
        #[serde(default = "enabled")]
        enabled: bool,
    },
    Toggle { id: String, enabled: bool },
    Delete { id: String },
    /// Run once now, as if the event had just happened.
    Run { id: String },
    Seen { bot: String },
}
fn enabled() -> bool {
    true
}

pub(super) async fn change(State(hub): State<Arc<Hub>>, h: HeaderMap, Json(change): Json<Change>) -> Result<Json<Value>> {
    super::admin(&hub, &h)?;
    let store = &hub.ext.store;
    let mut saved = None;
    let find = |id: &str| -> Result<WatchRecord> {
        store.watches()?.into_iter().find(|w| w.id == id).ok_or_else(|| Error(StatusCode::NOT_FOUND, "这个关注已不存在".into()))
    };
    match change {
        Change::Upsert { id, bot, spec, enabled } => {
            let mut parsed: Spec = serde_json::from_value(spec).map_err(|e| Error(StatusCode::BAD_REQUEST, format!("关注设置无效：{e}")))?;
            parsed.validate()?;
            // File events name the real path (macOS: /private/var, not /var).
            if let Some(Value::String(path)) = parsed.on.conditions.get_mut("workspace") {
                if let Ok(real) = Path::new(path.as_str()).canonicalize() {
                    *path = real.to_string_lossy().into_owned();
                }
            }
            crate::messaging::bots::resolve(&hub, &bot).map_err(|e| Error(StatusCode::NOT_FOUND, e.to_string()))?;
            let id = match id {
                Some(id) => {
                    if find(&id)?.bot != bot {
                        return Err(Error(StatusCode::BAD_REQUEST, "关注不能换给别的伙伴".into()));
                    }
                    id
                }
                None => format!("watch-{}", uuid::Uuid::new_v4().simple()),
            };
            store.set_state(&format!("schedule:{id}"), &json!(Local::now().timestamp_millis()))?;
            store.save_watch(&WatchRecord { id: id.clone(), bot, spec: serde_json::to_value(&parsed).map_err(anyhow::Error::from)?, enabled, updated: 0 })?;
            saved = Some(id);
        }
        Change::Toggle { id, enabled } => {
            let mut watch = find(&id)?;
            watch.enabled = enabled;
            // Paused time is not caught up after re-enabling.
            store.set_state(&format!("schedule:{id}"), &json!(Local::now().timestamp_millis()))?;
            store.save_watch(&watch)?;
        }
        Change::Delete { id } => {
            store.delete_watch(&id)?;
        }
        Change::Run { id } => {
            find(&id)?;
            ctx(&hub)?;
            // The dispatcher starts it, so its session is followed like any run.
            hub.ext.watches.manual.lock().push(id);
            hub.ext.watches.wake.notify_one();
            return Ok(Json(view(&hub, None)?));
        }
        Change::Seen { bot } => {
            store.mark_runs_seen(&bot)?;
            hub.ext.watches.changed();
            return Ok(Json(view(&hub, None)?));
        }
    }
    hub.ext.watches.reload();
    let mut view = view(&hub, None)?;
    if let Some(id) = saved {
        view["saved"] = json!(id);
    }
    Ok(Json(view))
}

#[cfg(test)]
mod clock_tests {
    use super::*;

    fn dispatcher(cron: &str) -> Dispatcher {
        let spec: Spec = serde_json::from_value(json!({"name":"站会","on":{"topic":"schedule","match":{"cron":cron}},"do":"写站会"})).unwrap();
        Dispatcher { watches: vec![Watch { id: "w1".into(), bot: "b1".into(), spec }], ..Default::default() }
    }
    fn gateway() -> Gateway {
        Gateway::with_store(super::super::store::Store::memory(), Duration::from_secs(1))
    }
    fn at(h: u32, m: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 11, 27, h, m, 0).earliest().unwrap()
    }

    #[test]
    fn a_new_time_trigger_waits_for_its_next_slot() {
        let (gateway, mut state) = (gateway(), dispatcher("0 9 * * *"));
        state.reload_clocks(&gateway, at(8, 0));
        assert!(state.pending.is_empty());
        assert_eq!(state.clocks["w1"].1, at(9, 0));
        state.tick_clocks(&gateway, at(8, 59));
        assert!(state.pending.is_empty());
        state.tick_clocks(&gateway, at(9, 0));
        let batch = &state.pending["w1"];
        assert_eq!(batch.events[0].0, "schedule");
        assert_eq!(batch.events[0].1["cron"], "0 9 * * *");
        assert!(state.clocks["w1"].1 > at(9, 0), "the next slot is tomorrow");
        assert_eq!(gateway.store.state("schedule:w1").unwrap(), Some(json!(at(9, 0).timestamp_millis())));
    }

    #[test]
    fn a_recent_missed_slot_runs_once_and_an_old_one_is_skipped() {
        let (gateway, mut state) = (gateway(), dispatcher("0 9 * * *"));
        gateway.store.set_state("schedule:w1", &json!(at(8, 0).timestamp_millis())).unwrap();
        state.reload_clocks(&gateway, at(10, 0));
        assert_eq!(state.pending["w1"].events[0].1["missed"], true);
        // Reloading again (another watch changed) does not queue it twice.
        state.pending.clear();
        state.reload_clocks(&gateway, at(10, 5));
        assert!(state.pending.is_empty());

        let (gateway, mut state) = (super::clock_tests::gateway(), dispatcher("0 9 * * *"));
        gateway.store.set_state("schedule:w1", &json!((at(9, 0) - chrono::Duration::days(2)).timestamp_millis())).unwrap();
        state.reload_clocks(&gateway, at(8, 0));
        assert!(state.pending.is_empty(), "yesterday's run is more than 12 hours old");
    }

    #[test]
    fn scheduled_runs_say_they_are_scheduled_and_where_to_post() {
        let mut spec: Spec = serde_json::from_value(json!({"name":"周报","on":{"topic":"schedule","match":{"cron":"0 17 * * 5"}},"do":"写周报"})).unwrap();
        spec.policy.post_to_wecom = Some("group_1".into());
        let text = run_text(&spec, &[("schedule".into(), json!({"cron":"0 17 * * 5"}))], 0, None);
        assert!(text.contains("定时自动运行") && text.contains("每周五 17:00") && text.contains("chat_id=group_1"), "{text}");
    }
}
