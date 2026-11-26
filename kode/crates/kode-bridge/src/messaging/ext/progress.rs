//! A read-only picture of recent work for bots that track progress: which
//! conversations moved and what they concluded, who is waiting for someone,
//! the Git commits in those folders, and the bots' open tasks.
use super::{tasks, Result};
use crate::messaging::Hub;
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

const MAX_SESSIONS: usize = 40;
const MAX_REPOS: usize = 12;
const MAX_COMMITS: usize = 30;
const DAY_MS: u64 = 24 * 3_600_000;

#[derive(Deserialize)]
pub(super) struct ProgressQuery {
    /// Milliseconds; default the last 24 hours, at most 14 days back.
    since: Option<u64>,
    /// Only work in this folder (and below).
    workspace: Option<String>,
    /// Only this bot's tasks.
    bot: Option<String>,
}

fn inside(path: &str, folder: &str) -> bool {
    path == folder || path.starts_with(&format!("{}/", folder.trim_end_matches('/')))
}

async fn git(dir: &str, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(Duration::from_secs(5), tokio::process::Command::new("git").arg("-C").arg(dir).args(args).output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn commits(folders: Vec<String>, since: u64) -> Vec<Value> {
    let mut repos = BTreeMap::new();
    for folder in folders.into_iter().filter(|f| Path::new(f).is_dir()) {
        if repos.len() >= MAX_REPOS {
            break;
        }
        if let Some(top) = git(&folder, &["rev-parse", "--show-toplevel"]).await {
            repos.entry(top).or_insert(());
        }
    }
    let mut out = vec![];
    let after = format!("--since=@{}", since / 1000);
    for repo in repos.into_keys() {
        let branch = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await.unwrap_or_default();
        let log = git(&repo, &["log", &after, "--no-merges", &format!("-n{MAX_COMMITS}"), "--pretty=format:%h%x1f%an%x1f%ct%x1f%s"]).await.unwrap_or_default();
        let list: Vec<Value> = log
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\u{1f}');
                Some(json!({"hash":parts.next()?,"author":parts.next()?,"time":parts.next()?.parse::<u64>().ok()? * 1000,"subject":parts.next()?}))
            })
            .collect();
        if !list.is_empty() {
            out.push(json!({"repo":repo,"branch":branch,"commits":list}));
        }
    }
    out
}

pub(super) async fn snapshot(hub: &Hub, since: u64, workspace: Option<&str>, bot: Option<&str>) -> anyhow::Result<Value> {
    let now = crate::now_ms();
    let since = since.clamp(now.saturating_sub(14 * DAY_MS), now);
    let ctx = hub.ctx.upgrade();
    let store = &hub.ext.store;
    let mut sessions: BTreeMap<u64, Value> = BTreeMap::new();
    for (session, kind, payload, ts) in store.activity_since(since, 2000)? {
        let entry = sessions.entry(session).or_insert_with(|| json!({"session_id":session,"turns":0,"asked":0,"last_activity":0,"last_said":Value::Null}));
        entry["last_activity"] = json!(ts);
        match kind.as_str() {
            "session.turn_completed" => {
                entry["turns"] = json!(entry["turns"].as_u64().unwrap_or(0) + 1);
                if let Some(text) = payload["final_message"]["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    entry["last_said"] = json!(text.chars().take(600).collect::<String>());
                }
            }
            "session.awaiting" => entry["asked"] = json!(entry["asked"].as_u64().unwrap_or(0) + 1),
            _ => entry["exited"] = json!(true),
        }
    }
    let mut active = vec![];
    for (id, mut row) in sessions {
        let Some(dto) = ctx.as_ref().and_then(|ctx| ctx.runtimes.snapshot(id)) else { continue };
        let cwd = dto["cwd"].as_str().unwrap_or_default().to_owned();
        if workspace.is_some_and(|w| !inside(&cwd, w)) {
            continue;
        }
        for key in ["title", "cwd", "backend_key", "status", "runtime"] {
            row[key] = dto[key].clone();
        }
        row["bot_run"] = json!(store.run_by_session(id).ok().flatten().is_some());
        active.push(row);
    }
    active.sort_by_key(|row| std::cmp::Reverse(row["last_activity"].as_u64().unwrap_or(0)));
    active.truncate(MAX_SESSIONS);
    let waiting: Vec<Value> = store
        .waiting_sessions(now.saturating_sub(14 * DAY_MS))?
        .into_iter()
        .filter_map(|(id, summary, ts)| {
            let dto = ctx.as_ref()?.runtimes.snapshot(id).filter(|dto| dto["status"] != "exited")?;
            let cwd = dto["cwd"].as_str().unwrap_or_default();
            if workspace.is_some_and(|w| !inside(cwd, w)) {
                return None;
            }
            Some(json!({"session_id":id,"title":dto["title"],"cwd":cwd,"backend_key":dto["backend_key"],"asked":summary.chars().take(300).collect::<String>(),"waiting_since":ts}))
        })
        .take(MAX_SESSIONS)
        .collect();
    let mut folders: Vec<String> = active.iter().filter_map(|row| row["cwd"].as_str().map(str::to_owned)).collect();
    folders.extend(workspace.map(str::to_owned));
    folders.dedup();
    let open: Vec<Value> = tasks::view(hub, bot)?
        .into_iter()
        .filter(|t| t.kind == "task")
        .map(|t| json!({"id":t.id,"bot":t.bot,"title":t.title,"status":t.status,"status_label":tasks::status_label(&t.status),"reason":t.reason,"due":t.due,"session_id":t.session_id,"updated":t.updated,"closed":t.closed}))
        .collect();
    Ok(json!({
        "since": since,
        "now": now,
        "sessions": active,
        "waiting_for_someone": waiting,
        "git": commits(folders, since).await,
        "tasks": open,
    }))
}

pub(super) async fn progress(State(hub): State<Arc<Hub>>, h: HeaderMap, Query(q): Query<ProgressQuery>) -> Result<Json<Value>> {
    super::admin(&hub, &h)?;
    let since = q.since.unwrap_or_else(|| crate::now_ms().saturating_sub(DAY_MS));
    Ok(Json(snapshot(&hub, since, q.workspace.as_deref(), q.bot.as_deref()).await?))
}
