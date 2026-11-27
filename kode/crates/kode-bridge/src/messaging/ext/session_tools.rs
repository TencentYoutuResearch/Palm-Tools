//! Session-scoped orchestration and bot tools exposed to native CLI sessions
//! via `session_mcp` (`kode-shared-services`), as well as cross-runtime
//! delegation (`runtime: "tui"` / `"dsh"`).
//!
//! Keeping these tools in `kode-bridge` gives native TUI sessions full feature
//! parity with DSH sessions while enforcing permission non-escalation, bot
//! ownership checks, and durable idempotency in one place.

use super::{ctx, progress, store, tasks, watches, Error, Result};
use crate::messaging::{
    agents, bot_prompt, bots, integrations,
    model::{valid_id, Address, RegisterRequest, SendRequest},
    Hub,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const DAY_HOURS: f64 = 24.0;
const GENERIC_TITLES: &[&str] = &[
    "session",
    "new session",
    "task",
    "new task",
    "chat",
    "new chat",
    "untitled",
    "worker",
    "subtask",
];

#[derive(Clone, Debug)]
struct CallerCtx {
    session_id: String,
    runtime: String,
    runtime_id: Option<u64>,
    cwd: Option<String>,
    backend_key: Option<String>,
    permission_mode: Option<String>,
}

#[derive(Deserialize, Default)]
pub(super) struct CallReq {
    name: String,
    #[serde(default)]
    arguments: Value,
    /// Optional explicit caller session when invoked by the local Admin owner
    /// (e.g. DSH delegating `runtime: "tui"` subtask creation).
    #[serde(default)]
    caller_session: Option<String>,
}

fn bad(msg: impl Into<String>) -> Error {
    Error(StatusCode::BAD_REQUEST, msg.into())
}

fn forbidden(msg: impl Into<String>) -> Error {
    Error(StatusCode::FORBIDDEN, msg.into())
}

fn bearer_token(headers: &HeaderMap) -> Result<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "missing bearer token".into()))
}

fn resolve_caller(
    hub: &Hub,
    headers: &HeaderMap,
    explicit_session: Option<&str>,
) -> Result<CallerCtx> {
    let token = bearer_token(headers)?;
    let bridge_ctx = ctx(hub)?;
    let session_id = if crate::constant_eq(token, &bridge_ctx.token) {
        explicit_session
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| bad("caller_session is required for admin delegation"))?
    } else if let Some(sid) = hub.store.principal(token)? {
        if explicit_session.is_some_and(|s| s.trim() != sid) {
            return Err(forbidden("cannot impersonate another session"));
        }
        sid
    } else {
        return Err(Error(StatusCode::UNAUTHORIZED, "invalid session token".into()));
    };

    if !integrations::settings(hub)?.messaging_enabled {
        return Err(forbidden("Session messaging is disabled in Kode settings"));
    }

    Ok(inspect_session(hub, &bridge_ctx, session_id))
}

fn inspect_session(hub: &Hub, bridge_ctx: &crate::Ctx, session_id: String) -> CallerCtx {
    let snapshots = bridge_ctx.runtimes.snapshots();
    let index = hub
        .store
        .document("dsh-session-index")
        .map(|d| d["value"].clone())
        .unwrap_or_default();
    let aliases = bot_prompt::build_session_aliases(&index, &snapshots);

    if let Some(id) = session_id
        .strip_prefix("kode:runtime:gui:")
        .and_then(|n| n.parse::<u64>().ok())
    {
        if let Some(dto) = bridge_ctx.runtimes.snapshot(id) {
            return CallerCtx {
                session_id,
                runtime: "gui".into(),
                runtime_id: Some(id),
                cwd: dto["cwd"].as_str().map(str::to_owned),
                backend_key: dto["backend_key"]
                    .as_str()
                    .map(|s| s.strip_prefix("gui:").unwrap_or(s).to_owned()),
                permission_mode: dto["permission_mode"].as_str().map(str::to_owned),
            };
        }
    }

    if let Some(&local_id) = hub.native.lock().get(&session_id) {
        if let Some(s) = bridge_ctx.sessions.lock().get(&local_id) {
            let dto = crate::session_to_dto(s);
            let seed = dto.session_uuid.as_deref().unwrap_or_default();
            let expanded = bot_prompt::expand_session_key(seed, &aliases);
            return CallerCtx {
                session_id,
                runtime: "gui".into(),
                runtime_id: bridge_ctx.runtimes.resolve_any("gui", seed, &expanded),
                cwd: dto.cwd,
                backend_key: Some(dto.backend_key),
                permission_mode: None,
            };
        }
    }

    let expanded = bot_prompt::expand_session_key(&session_id, &aliases);
    if let Some(id) = bridge_ctx.runtimes.resolve_any("dsh", &session_id, &expanded) {
        if let Some(dto) = bridge_ctx.runtimes.snapshot(id) {
            let rt = dto["runtime"].as_str().unwrap_or("dsh").to_owned();
            return CallerCtx {
                session_id,
                runtime: rt,
                runtime_id: Some(id),
                cwd: dto["cwd"].as_str().map(str::to_owned),
                backend_key: dto["backend_key"]
                    .as_str()
                    .map(|s| s.strip_prefix("gui:").unwrap_or(s).to_owned()),
                permission_mode: dto["permission_mode"].as_str().map(str::to_owned),
            };
        }
    }

    CallerCtx {
        session_id,
        runtime: if bridge_ctx.runtimes.available("gui") {
            "gui".into()
        } else {
            "dsh".into()
        },
        runtime_id: None,
        cwd: None,
        backend_key: None,
        permission_mode: None,
    }
}

fn owner_bot(hub: &Hub, bridge_ctx: &crate::Ctx, caller: &CallerCtx) -> Option<bots::Bot> {
    let (_, roster) = bots::roster(hub).ok()?;
    let snapshots = bridge_ctx.runtimes.snapshots();
    let index = hub
        .store
        .document("dsh-session-index")
        .map(|d| d["value"].clone())
        .unwrap_or_default();
    let aliases = bot_prompt::build_session_aliases(&index, &snapshots);
    let (main_map, adopted_map) = bot_prompt::roster_session_maps(&roster, &aliases);

    let mut candidates = vec![caller.session_id.clone()];
    if let Some(id) = caller.runtime_id {
        candidates.push(format!("kode:runtime:gui:{id}"));
        if let Some(dto) = bridge_ctx.runtimes.snapshot(id) {
            for key in ["runtime_session_id", "session_uuid", "native_thread_id"] {
                if let Some(v) = dto[key].as_str().filter(|s| !s.is_empty()) {
                    candidates.push(v.to_owned());
                }
            }
        }
    }

    for candidate in &candidates {
        if let Some((bot_id, _)) = main_map.iter().find(|(_, arr)| {
            arr.as_array()
                .is_some_and(|list| list.iter().any(|v| v.as_str() == Some(candidate.as_str())))
        }) {
            if let Some(bot) = roster.bots.iter().find(|b| &b.id == bot_id) {
                return Some(bot.clone());
            }
        }
        if let Some(bot_id) = adopted_map.get(candidate) {
            if let Some(bot) = roster.bots.iter().find(|b| &b.id == bot_id) {
                return Some(bot.clone());
            }
        }
    }

    if let Some(id) = caller.runtime_id {
        if let Ok(Some(run)) = hub.ext.store.run_by_session(id) {
            if let Some(bot) = roster.bots.iter().find(|b| b.id == run.bot) {
                return Some(bot.clone());
            }
        }
    }

    if let Some(cwd) = caller.cwd.as_deref().filter(|s| !s.is_empty()) {
        let root = roster.root();
        let cwd_canon = Path::new(cwd)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(cwd));
        for bot in &roster.bots {
            let home = bot.home(&root);
            let home_canon = home.canonicalize().unwrap_or(home);
            if cwd_canon == home_canon || cwd_canon.starts_with(&home_canon) {
                return Some(bot.clone());
            }
        }
    }

    None
}

fn normalize_permission_alias(raw: &str) -> &str {
    match raw.trim() {
        "read-only" => "plan",
        "workspace-write" => "acceptEdits",
        "danger-full-access" | "bypass" => "bypassPermissions",
        other => other,
    }
}

fn permission_rank(mode: &str) -> usize {
    match normalize_permission_alias(mode) {
        "plan" => 0,
        "default" => 1,
        "acceptEdits" => 2,
        "bypassPermissions" => 3,
        _ => 1,
    }
}

fn validate_session_title(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 80
        || trimmed.chars().any(|c| matches!(c, '\r' | '\n' | '/' | '\\'))
    {
        return Err(bad(
            "title must be a concise single-line 1-4 word title without path separators",
        ));
    }
    if GENERIC_TITLES.contains(&trimmed.to_ascii_lowercase().as_str()) {
        return Err(bad(
            "title must describe the specific task rather than a generic placeholder",
        ));
    }
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if words.len() > 6 {
        return Err(bad("title must be concise (at most 4-6 words)"));
    }
    Ok(trimmed.to_owned())
}

fn workspace_catalog(hub: &Hub) -> Vec<Value> {
    let doc = hub
        .store
        .document("workspaces")
        .map(|d| d["value"].clone())
        .unwrap_or_default();
    doc["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|w| {
            let path = w["path"].as_str()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(json!({
                "id": w["id"].as_str().unwrap_or(path),
                "title": w["title"].as_str().or_else(|| w["name"].as_str()).unwrap_or(path),
                "path": path,
            }))
        })
        .collect()
}

fn agent_catalog(hub: &Hub) -> Vec<Value> {
    agents::catalog(hub)
        .map(|c| {
            let names = c.names;
            let mut rows: Vec<Value> = c
                .backends
                .into_iter()
                .filter(|(_, cfg)| cfg.is_enabled())
                .map(|(key, cfg)| {
                    let name = names.get(&key).cloned().unwrap_or_else(|| key.clone());
                    json!({
                        "key": key,
                        "name": name,
                        "default_model": cfg.default_model,
                    })
                })
                .collect();
            rows.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
            rows
        })
        .unwrap_or_default()
}

pub(super) fn session_naming_prompt() -> &'static str {
    "Use a specific 1-4 word noun-phrase title (e.g. 'Auth Token Refresh', 'TAPD Bug Triage', '订单超时排查'). Avoid generic placeholders like 'New Session' or 'Task'."
}

fn tool_definitions(has_bot: bool) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "kode_sessions_create",
            "description": "Create and dispatch a worker session in a target project directory (in native TUI or DSH), optionally linking it to a bot task item and delivering its initial assignment.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Concise 1-4 word title describing the subtask"},
                    "task": {"type": "string", "description": "Clear assignment, context, acceptance criteria, and expected deliverable"},
                    "idempotency_key": {"type": "string", "description": "Unique key for safe retry without spawning duplicate sessions"},
                    "workspace": {"type": "string", "description": "Target workspace id, title, or directory path (call kode_sessions_list to inspect workspaces)"},
                    "cwd": {"type": "string", "description": "Explicit working directory path if not using workspace"},
                    "agent": {"type": "string", "description": "Agent backend key or display name (defaults to caller/bot backend)"},
                    "model": {"type": "string", "description": "Optional model override"},
                    "permission_mode": {"type": "string", "enum": ["plan", "default", "acceptEdits", "bypassPermissions"]},
                    "task_id": {"type": "string", "description": "Optional bot_tasks id to bind so turns, questions, and exit are automatically reported back"},
                    "runtime": {"type": "string", "enum": ["tui", "dsh"], "description": "Target runtime surface: 'tui' for native Kode terminal tab or 'dsh' for structured chat view (defaults to caller's active runtime)"}
                },
                "required": ["title", "task", "idempotency_key"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "kode_progress_snapshot",
            "description": "Read a cross-session progress snapshot: recently active sessions and their conclusions, sessions waiting for input, recent Git commits across workspaces, and open bot tasks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since_hours": {"type": "number", "minimum": 0.25, "maximum": 336, "description": "Lookback window in hours (default 24, max 336)"},
                    "hours": {"type": "number", "minimum": 0.25, "maximum": 336, "description": "Alias for since_hours"},
                    "workspace": {"type": "string", "description": "Optional folder path filter"}
                },
                "additionalProperties": false
            }
        }),
    ];

    if has_bot {
        tools.extend([
            json!({
                "name": "bot_tasks_list",
                "description": "List the tasks on your (the bot's) task board: what you track for the user, with status and the conversation doing each one.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "include_closed": {"type": "boolean", "description": "Also list tasks finished or cancelled in the last 7 days."},
                        "status": {"type": "string", "enum": ["planned", "in_progress", "waiting", "needs_user", "done", "cancelled"]}
                    },
                    "additionalProperties": false
                }
            }),
            json!({
                "name": "bot_task_update",
                "description": "Add a task to your board or update one. Keep status honest: planned, in_progress, waiting (give reason), needs_user (the user must decide; give reason), done, cancelled. Link the conversation doing it with link_session.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "task_id": {"type": "string", "description": "Existing task to update; omit to add a new task."},
                        "id": {"type": "string", "description": "Alias for task_id"},
                        "title": {"type": "string", "description": "Short task title (required for a new task)."},
                        "detail": {"type": "string"},
                        "status": {"type": "string", "enum": ["planned", "in_progress", "waiting", "needs_user", "done", "cancelled"]},
                        "reason": {"type": "string", "description": "Why it waits or needs the user."},
                        "due": {"type": "string", "description": "Due date YYYY-MM-DD or ISO time; 'none' clears it."},
                        "due_hours": {"type": "number", "minimum": 0},
                        "link_session": {"type": "string", "description": "Session id of the conversation doing this task."},
                        "unlink_session": {"type": "boolean"}
                    },
                    "additionalProperties": false
                }
            }),
            json!({
                "name": "bot_plan_propose",
                "description": "Propose a multi-step plan for the user to approve before you dispatch work. When approved, Kode creates one task per step and tells you to start.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "summary": {"type": "string"},
                        "steps": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {"type": "string"},
                                    "detail": {"type": "string"}
                                },
                                "required": ["title"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["title", "steps"],
                    "additionalProperties": false
                }
            }),
            json!({
                "name": "bot_schedules_list",
                "description": "List your scheduled routines (time-triggered runs such as a daily standup).",
                "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
            }),
            json!({
                "name": "bot_schedule_upsert",
                "description": "Create or change one of your scheduled routines. cron is five fields in local time: minute hour day month weekday (e.g. '0 9 * * 1-5').",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "schedule_id": {"type": "string", "description": "Existing routine to change; omit to create."},
                        "id": {"type": "string", "description": "Alias for schedule_id"},
                        "name": {"type": "string"},
                        "cron": {"type": "string", "description": "5-field local-time cron expression, e.g. '0 9 * * 1-5'"},
                        "instructions": {"type": "string", "description": "What to do each time, e.g. call kode_progress_snapshot and write a standup."},
                        "do": {"type": "string", "description": "Alias for instructions"},
                        "permission": {"type": "string", "enum": ["plan", "default", "acceptEdits"]},
                        "notify": {"type": "string", "enum": ["always", "attention", "never"]},
                        "workspace": {"type": "string"},
                        "wecom_chat_id": {"type": "string", "description": "Also post each report to this WeCom chat."},
                        "post_to_wecom": {"type": "string", "description": "Alias for wecom_chat_id"},
                        "enabled": {"type": "boolean"}
                    },
                    "required": ["name", "cron"],
                    "additionalProperties": false
                }
            }),
            json!({
                "name": "bot_schedule_delete",
                "description": "Delete one of your scheduled routines.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "schedule_id": {"type": "string"},
                        "id": {"type": "string"}
                    },
                    "additionalProperties": false
                }
            }),
        ]);
    }

    tools
}

/// `GET /api/v1/messaging/session-tools`: dynamic tool descriptors for the caller session.
pub(super) async fn list(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Value>> {
    let Ok(caller) = resolve_caller(&hub, &headers, None) else {
        return Ok(Json(json!({"tools": []})));
    };
    let bridge_ctx = ctx(&hub)?;
    let has_bot = owner_bot(&hub, &bridge_ctx, &caller).is_some();
    Ok(Json(json!({
        "tools": tool_definitions(has_bot),
    })))
}

/// `GET /api/v1/messaging/session-tools/catalog`: workspaces, enabled agents, and naming policy.
pub(super) async fn catalog(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Result<Json<Value>> {
    let _caller = resolve_caller(&hub, &headers, None)?;
    Ok(Json(json!({
        "workspaces": workspace_catalog(&hub),
        "agentConfigurations": agent_catalog(&hub),
        "sessionNaming": session_naming_prompt(),
    })))
}

/// `POST /api/v1/messaging/session-tools/call`: execute a session orchestration or bot tool.
pub(super) async fn call(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Json(req): Json<CallReq>,
) -> Result<Json<Value>> {
    let caller = resolve_caller(&hub, &headers, req.caller_session.as_deref())?;
    let bridge_ctx = ctx(&hub)?;
    let bot = owner_bot(&hub, &bridge_ctx, &caller);
    let args = if req.arguments.is_null() {
        json!({})
    } else {
        req.arguments
    };

    let result = match req.name.as_str() {
        "kode_sessions_create" => {
            exec_sessions_create(&hub, &bridge_ctx, &caller, bot.as_ref(), &args).await?
        }
        "kode_progress_snapshot" => exec_progress_snapshot(&hub, bot.as_ref(), &args).await?,
        "bot_tasks_list" => {
            let bot = bot.ok_or_else(|| forbidden("bot_tasks_list is only available in bot sessions"))?;
            exec_bot_tasks_list(&hub, &bot, &args)?
        }
        "bot_task_update" => {
            let bot = bot.ok_or_else(|| forbidden("bot_task_update is only available in bot sessions"))?;
            exec_bot_task_update(&hub, &bot, &args)?
        }
        "bot_plan_propose" => {
            let bot = bot.ok_or_else(|| forbidden("bot_plan_propose is only available in bot sessions"))?;
            exec_bot_plan_propose(&hub, &bot, &args)?
        }
        "bot_schedules_list" => {
            let bot = bot.ok_or_else(|| forbidden("bot_schedules_list is only available in bot sessions"))?;
            exec_bot_schedules_list(&hub, &bot)?
        }
        "bot_schedule_upsert" => {
            let bot = bot.ok_or_else(|| forbidden("bot_schedule_upsert is only available in bot sessions"))?;
            exec_bot_schedule_upsert(&hub, &bot, &args)?
        }
        "bot_schedule_delete" => {
            let bot = bot.ok_or_else(|| forbidden("bot_schedule_delete is only available in bot sessions"))?;
            exec_bot_schedule_delete(&hub, &bot, &args)?
        }
        other => return Err(Error(StatusCode::NOT_FOUND, format!("unknown session tool: {other}"))),
    };

    Ok(Json(result))
}

fn resolve_target_cwd(
    hub: &Hub,
    caller: &CallerCtx,
    bot: Option<&bots::Bot>,
    args: &Value,
) -> Result<PathBuf> {
    let workspaces = workspace_catalog(hub);
    if let Some(ws) = args["workspace"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(found) = workspaces.iter().find(|row| {
            row["id"].as_str() == Some(ws)
                || row["path"].as_str() == Some(ws)
                || row["title"]
                    .as_str()
                    .is_some_and(|t| t.eq_ignore_ascii_case(ws))
        }) {
            if let Some(p) = found["path"].as_str() {
                let path = PathBuf::from(p);
                if path.is_dir() {
                    return Ok(path);
                }
            }
        }
        let direct = PathBuf::from(ws);
        if direct.is_absolute() && direct.is_dir() {
            return Ok(direct);
        }
        return Err(bad(format!(
            "unknown or unavailable workspace '{ws}'; call kode_sessions_list to inspect valid workspaces"
        )));
    }

    if let Some(raw_cwd) = args["cwd"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(raw_cwd);
        if !path.is_absolute() || !path.is_dir() {
            return Err(bad(format!(
                "cwd '{raw_cwd}' must be an existing absolute directory"
            )));
        }
        return Ok(path);
    }

    if let Some(caller_cwd) = caller.cwd.as_deref().filter(|s| !s.is_empty()) {
        let path = PathBuf::from(caller_cwd);
        if path.is_dir() {
            return Ok(path);
        }
    }

    if let Some(bot) = bot {
        let root = bots::roster(hub)
            .map(|(_, r)| r.root())
            .unwrap_or_else(|_| bots::default_root());
        let home = bot.home(&root);
        std::fs::create_dir_all(&home).map_err(anyhow::Error::from)?;
        return Ok(home);
    }

    dirs::home_dir().ok_or_else(|| bad("unable to determine working directory"))
}

fn resolve_backend_key(
    hub: &Hub,
    bridge_ctx: &crate::Ctx,
    caller: &CallerCtx,
    bot: Option<&bots::Bot>,
    requested: Option<&str>,
) -> Result<String> {
    let catalog = agents::catalog(hub)?;
    if let Some(req) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        let stripped = req
            .strip_prefix("gui:")
            .or_else(|| req.strip_prefix("dsh:"))
            .unwrap_or(req);
        let canonical = catalog.canonical_key(stripped);
        if let Some((found_key, _)) = catalog.backends.iter().find(|(key, cfg)| {
            cfg.is_enabled()
                && (*key == canonical
                    || key.eq_ignore_ascii_case(stripped)
                    || catalog
                        .names
                        .get(*key)
                        .is_some_and(|n| n.eq_ignore_ascii_case(stripped)))
        }) {
            return Ok(found_key.clone());
        }
        if bridge_ctx.config.backends.contains_key(stripped) {
            return Ok(stripped.to_owned());
        }
        return Err(bad(format!("agent backend '{req}' is not enabled or available")));
    }

    if let Some(bk) = bot
        .map(|b| b.backend_key.as_str())
        .filter(|s| !s.is_empty())
        .or(caller.backend_key.as_deref().filter(|s| !s.is_empty()))
    {
        return Ok(catalog.canonical_key(bk).to_owned());
    }

    let mut keys: Vec<String> = catalog
        .backends
        .into_iter()
        .filter(|(_, cfg)| cfg.is_enabled())
        .map(|(k, _)| k)
        .collect();
    keys.sort();
    keys.into_iter()
        .next()
        .ok_or_else(|| bad("no enabled agent backend configured"))
}

fn resolve_permission_mode(
    caller: &CallerCtx,
    bot: Option<&bots::Bot>,
    requested: Option<&str>,
) -> Result<String> {
    let mut ceiling = "bypassPermissions";
    if let Some(bot) = bot {
        ceiling = normalize_permission_alias(&bot.permission_ceiling);
    }
    if let Some(caller_mode) = caller.permission_mode.as_deref() {
        let normalized = normalize_permission_alias(caller_mode);
        if permission_rank(normalized) < permission_rank(ceiling) {
            ceiling = normalized;
        }
    }
    let normalized_req = requested
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(normalize_permission_alias);
    bots::effective_permission(normalized_req, ceiling)
        .map_err(|e| forbidden(format!("permission escalation refused: {e}")))
}

async fn exec_sessions_create(
    hub: &Arc<Hub>,
    bridge_ctx: &Arc<crate::Ctx>,
    caller: &CallerCtx,
    bot: Option<&bots::Bot>,
    args: &Value,
) -> Result<Value> {
    let title = validate_session_title(args["title"].as_str().unwrap_or_default())?;
    let task_text = args["task"].as_str().unwrap_or_default().trim();
    if task_text.is_empty() {
        return Err(bad("task must be a non-empty string"));
    }
    let idempotency_key = args["idempotency_key"].as_str().unwrap_or_default().trim();
    if !valid_id(idempotency_key) {
        return Err(bad(
            "idempotency_key must be 1-128 ASCII letters, digits, '.', '_', ':', or '-'",
        ));
    }

    let requested_runtime = match args["runtime"].as_str().map(str::trim) {
        Some("tui" | "gui") => "gui",
        Some("dsh" | "view") => "dsh",
        Some("") | None => {
            if caller.runtime == "dsh" && bridge_ctx.runtimes.available("dsh") {
                "dsh"
            } else if bridge_ctx.runtimes.available("gui") {
                "gui"
            } else if bridge_ctx.runtimes.available("dsh") {
                "dsh"
            } else {
                "gui"
            }
        }
        Some(other) => return Err(bad(format!("unsupported runtime '{other}' (expected 'tui' or 'dsh')"))),
    };

    let cwd = resolve_target_cwd(hub, caller, bot, args)?;
    let cwd_str = cwd.to_string_lossy().into_owned();
    let backend_key = resolve_backend_key(hub, bridge_ctx, caller, bot, args["agent"].as_str())?;
    let permission_mode =
        resolve_permission_mode(caller, bot, args["permission_mode"].as_str())?;
    let model = args["model"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let task_id = args["task_id"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    if let Some(tid) = task_id.as_deref() {
        let Some(bot_owner) = bot else {
            return Err(forbidden("task_id can only be linked from a bot session"));
        };
        let existing = hub
            .ext
            .store
            .task(tid)?
            .ok_or_else(|| Error(StatusCode::NOT_FOUND, format!("task '{tid}' not found")))?;
        if existing.bot != bot_owner.id {
            return Err(forbidden("cannot link a task belonging to another bot"));
        }
    }

    let fingerprint = store::digest(&serde_json::to_string(&json!({
        "title": title,
        "task": task_text,
        "cwd": cwd_str,
        "backend_key": backend_key,
        "model": model,
        "permission_mode": permission_mode,
        "runtime": requested_runtime,
        "task_id": task_id,
    })).unwrap_or_default());
    let state_key = format!(
        "session_create:{}",
        &store::digest(&format!("{}\n{idempotency_key}", caller.session_id))[..48]
    );
    if let Some(saved) = hub.ext.store.state(&state_key)? {
        if saved["fingerprint"].as_str() != Some(fingerprint.as_str()) {
            return Err(Error(
                StatusCode::CONFLICT,
                "Idempotency key reused with different parameters".into(),
            ));
        }
        if saved["status"] == "completed" {
            return Ok(saved["result"].clone());
        }
    }

    let rid = format!("st.{}", &store::digest(&state_key)[..40]);
    let mut create_payload = json!({
        "backend_key": backend_key,
        "cwd": cwd_str,
        "permission_mode": permission_mode,
        "title": title,
    });
    if let Some(m) = &model {
        create_payload["model"] = json!(m);
    }

    let (target_session_id, adopt_key, runtime_public_id, actual_runtime) = if requested_runtime == "dsh" {
        if !bridge_ctx.runtimes.available("dsh") {
            return Err(Error(
                StatusCode::SERVICE_UNAVAILABLE,
                "DSH runtime is not currently online".into(),
            ));
        }
        let dto = bridge_ctx
            .runtimes
            .request("dsh", None, "create_session", create_payload, &rid)
            .await
            .map_err(|e| Error(StatusCode::BAD_GATEWAY, e.to_string()))?;
        let dsh_sid = dto["runtime_session_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error(StatusCode::BAD_GATEWAY, "DSH did not return runtime_session_id".into()))?
            .to_owned();
        let pub_id = dto["id"].as_u64();
        // Wait briefly for DSH's agent/created hook to register the messaging principal.
        for _ in 0..40 {
            if hub
                .store
                .sessions()?
                .iter()
                .any(|s| s.address.session_id == dsh_sid)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        (dsh_sid.clone(), dsh_sid, pub_id, "dsh")
    } else if bridge_ctx.runtimes.available("gui") {
        let dto = bridge_ctx
            .runtimes
            .request("gui", None, "create_session", create_payload, &rid)
            .await
            .map_err(|e| Error(StatusCode::BAD_GATEWAY, e.to_string()))?;
        let pub_id = dto["id"]
            .as_u64()
            .ok_or_else(|| Error(StatusCode::BAD_GATEWAY, "GUI runtime did not return session id".into()))?;
        let sid = format!("kode:runtime:gui:{pub_id}");
        hub.store.register(RegisterRequest {
            session_id: sid.clone(),
            title: title.clone(),
            runtime: "kode".into(),
            owner_token: hub.store.db_token(&sid)?,
        })?;
        hub.native.lock().insert(sid.clone(), pub_id);
        let adopt_id = dto["session_uuid"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| sid.clone());
        (sid, adopt_id, Some(pub_id), "gui")
    } else {
        // Standalone headless kode-bridge fallback (no external GUI/DSH lease).
        let (status, dto) =
            crate::mobile_setup::execute(bridge_ctx.clone(), "create_session", create_payload).await;
        if status >= 400 {
            let msg = dto["error"]
                .as_str()
                .unwrap_or("failed to create local session");
            return Err(Error(StatusCode::BAD_REQUEST, msg.to_owned()));
        }
        let local_id = dto["id"]
            .as_u64()
            .ok_or_else(|| Error(StatusCode::INTERNAL_SERVER_ERROR, "missing local session id".into()))?;
        let uuid = dto["session_uuid"].as_str().filter(|s| !s.is_empty());
        let sid = uuid
            .map(|u| format!("kode:{backend_key}:{u}"))
            .filter(|s| valid_id(s))
            .unwrap_or_else(|| format!("kode:{}:{local_id}", hub.boot));
        hub.store.register(RegisterRequest {
            session_id: sid.clone(),
            title: title.clone(),
            runtime: "kode".into(),
            owner_token: hub.store.db_token(&sid)?,
        })?;
        hub.native.lock().insert(sid.clone(), local_id);
        let adopt_id = uuid.map(str::to_owned).unwrap_or_else(|| sid.clone());
        (sid, adopt_id, None, "gui")
    };

    if let Some(bot_owner) = bot {
        let _ = bots::change(
            hub,
            bots::Change::Adopt {
                session: adopt_key.clone(),
                id: Some(bot_owner.id.clone()),
            },
        );
    }

    if let Some(tid) = task_id.as_deref() {
        let _ = tasks::upsert(
            hub,
            tasks::Input {
                id: Some(tid.to_owned()),
                session: Some(tasks::SessionRef {
                    runtime: actual_runtime.to_owned(),
                    session_id: adopt_key.clone(),
                }),
                ..Default::default()
            },
        )?;
    }

    let task_body = if let Some(tid) = task_id.as_deref() {
        format!(
            "{task_text}\n\n——\n这是任务 {tid} 的一部分。做完后用 kode_sessions_send 回复派你来的会话（in_reply_to 上面的消息），第一行写「状态：完成」「状态：需要决定」或「状态：受阻」，再写结论和需要的决定。"
        )
    } else {
        task_text.to_owned()
    };
    let assignment = format!(
        "Task assigned by `{}` on node `{}`.\nTitle: {}\nWorking directory: {}\n\n{}\n\nWhen you have questions, progress updates, or your final summary, report back with `kode_sessions_send` to `node_id=\"{}\"`, `session_id=\"{}\"`.",
        caller.session_id,
        hub.node_id(),
        title,
        cwd_str,
        task_body,
        hub.node_id(),
        caller.session_id,
    );
    let msg_key = format!("create-{}", &store::digest(&state_key)[..32]);
    let message = hub.send(
        &caller.session_id,
        SendRequest {
            source: Some(caller.session_id.clone()),
            target: Address {
                node_id: hub.node_id().to_owned(),
                session_id: target_session_id.clone(),
            },
            content: assignment,
            title: Some(title.clone()),
            idempotency_key: msg_key,
            in_reply_to: None,
            interrupt: true,
            ttl_seconds: 86_400,
        },
    )?;

    let response = json!({
        "created": true,
        "runtime": if actual_runtime == "gui" { "tui" } else { "dsh" },
        "target": {
            "node_id": hub.node_id(),
            "session_id": target_session_id,
        },
        "runtime_session_id": runtime_public_id,
        "session_uuid": adopt_key,
        "title": title,
        "cwd": cwd_str,
        "agent": backend_key,
        "permission_mode": permission_mode,
        "task_id": task_id,
        "message_id": message.id,
        "delivery_status": message.status,
    });

    hub.ext.store.set_state(
        &state_key,
        &json!({
            "fingerprint": fingerprint,
            "status": "completed",
            "result": response,
        }),
    )?;

    Ok(response)
}

async fn exec_progress_snapshot(
    hub: &Hub,
    bot: Option<&bots::Bot>,
    args: &Value,
) -> Result<Value> {
    let hours = args["since_hours"]
        .as_f64()
        .or_else(|| args["hours"].as_f64())
        .unwrap_or(DAY_HOURS)
        .clamp(0.25, 14.0 * DAY_HOURS);
    let since = crate::now_ms().saturating_sub((hours * 3_600_000.0) as u64);
    let workspace = args["workspace"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Ok(progress::snapshot(hub, since, workspace, bot.map(|b| b.id.as_str())).await?)
}

fn exec_bot_tasks_list(hub: &Hub, bot: &bots::Bot, args: &Value) -> Result<Value> {
    let include_closed = args["include_closed"].as_bool().unwrap_or(false);
    let status_filter = args["status"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let items: Vec<_> = tasks::view(hub, Some(&bot.id))?
        .into_iter()
        .filter(|t| include_closed || status_filter.is_some() || t.closed.is_none())
        .filter(|t| status_filter.map_or(true, |st| t.status == st))
        .collect();
    Ok(json!({
        "bot": bot.name,
        "bot_id": bot.id,
        "tasks": items,
    }))
}

fn parse_due_arg(args: &Value) -> Result<Option<u64>> {
    use chrono::TimeZone as _;
    if let Some(hours) = args["due_hours"].as_f64() {
        return Ok(Some(if hours <= 0.0 {
            0
        } else {
            crate::now_ms().saturating_add((hours * 3_600_000.0) as u64)
        }));
    }
    let raw = args["due"]
        .as_str()
        .or_else(|| args["due_at"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let Some(s) = raw else {
        return Ok(None);
    };
    if s == "0" || s.eq_ignore_ascii_case("none") {
        return Ok(Some(0));
    }
    if s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' {
        let date = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|e| bad(format!("invalid due date '{s}': {e}")))?;
        let dt = date
            .and_hms_opt(18, 0, 0)
            .and_then(|ndt| chrono::Local.from_local_datetime(&ndt).earliest())
            .ok_or_else(|| bad(format!("invalid local due date '{s}'")))?;
        return Ok(Some(dt.timestamp_millis().max(0) as u64));
    }
    let parsed = chrono::DateTime::parse_from_rfc3339(s)
        .map_err(|e| bad(format!("due must be YYYY-MM-DD, RFC3339 timestamp, or 'none': {e}")))?;
    Ok(Some(parsed.timestamp_millis().max(0) as u64))
}

fn exec_bot_task_update(hub: &Hub, bot: &bots::Bot, args: &Value) -> Result<Value> {
    let due = parse_due_arg(args)?;
    let id = args["task_id"]
        .as_str()
        .or_else(|| args["id"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let session = args["link_session"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|sid| {
            let rt = if sid.starts_with("session-") || sid.starts_with("mobile-") {
                "dsh"
            } else {
                "gui"
            };
            tasks::SessionRef {
                runtime: rt.to_owned(),
                session_id: sid.to_owned(),
            }
        });
    let record = tasks::upsert(
        hub,
        tasks::Input {
            id,
            bot: Some(bot.id.clone()),
            kind: Some("task".into()),
            title: args["title"].as_str().map(str::to_owned),
            detail: args["detail"].as_str().map(str::to_owned),
            status: args["status"].as_str().map(str::to_owned),
            reason: args["reason"].as_str().map(str::to_owned),
            due,
            session,
            unlink: args["unlink_session"].as_bool().unwrap_or(false),
            ..Default::default()
        },
    )?;
    if record.bot != bot.id {
        return Err(forbidden("cannot modify a task belonging to another bot"));
    }
    Ok(json!({
        "task_id": record.id,
        "task": record,
    }))
}

fn exec_bot_plan_propose(hub: &Hub, bot: &bots::Bot, args: &Value) -> Result<Value> {
    let title = args["title"].as_str().unwrap_or_default().trim();
    if title.is_empty() {
        return Err(bad("plan title is required"));
    }
    let steps = args["steps"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 20)
        .ok_or_else(|| bad("steps must contain 1 to 20 items"))?;
    let clean_steps: Vec<Value> = steps
        .iter()
        .filter_map(|s| {
            let t = s["title"].as_str()?.trim();
            if t.is_empty() {
                return None;
            }
            Some(json!({
                "title": t,
                "detail": s["detail"].as_str().unwrap_or_default().trim(),
            }))
        })
        .collect();
    if clean_steps.is_empty() {
        return Err(bad("steps must contain at least one titled step"));
    }
    let record = tasks::upsert(
        hub,
        tasks::Input {
            bot: Some(bot.id.clone()),
            kind: Some("plan".into()),
            title: Some(title.to_owned()),
            detail: Some(args["summary"].as_str().unwrap_or_default().to_owned()),
            status: Some("needs_user".into()),
            payload: Some(json!({ "steps": clean_steps })),
            ..Default::default()
        },
    )?;
    Ok(json!({
        "plan_id": record.id,
        "status": "waiting_for_user",
        "plan": record,
        "note": "计划已交给用户批准。批准后你会收到一条「计划已批准」的消息，那时再开始派发。",
    }))
}

fn exec_bot_schedules_list(hub: &Hub, bot: &bots::Bot) -> Result<Value> {
    let schedules: Vec<Value> = hub
        .ext
        .store
        .watches()?
        .into_iter()
        .filter(|w| w.bot == bot.id && w.spec["on"]["topic"] == "schedule")
        .map(|w| {
            let cron = w.spec["on"]["match"]["cron"].as_str().unwrap_or_default();
            let desc = super::schedule::describe(cron);
            json!({
                "schedule_id": w.id,
                "id": w.id,
                "name": w.spec["name"],
                "cron": cron,
                "description": desc,
                "instructions": w.spec["do"],
                "do": w.spec["do"],
                "workspace": w.spec["policy"]["workspace"],
                "wecom_chat_id": w.spec["policy"]["post_to_wecom"],
                "enabled": w.enabled,
                "updated": w.updated,
            })
        })
        .collect();
    Ok(json!({
        "bot": bot.id,
        "schedules": schedules,
    }))
}

fn exec_bot_schedule_upsert(hub: &Hub, bot: &bots::Bot, args: &Value) -> Result<Value> {
    let name = args["name"].as_str().unwrap_or_default().trim();
    let cron = args["cron"].as_str().unwrap_or_default().trim();
    let do_text = args["instructions"]
        .as_str()
        .or_else(|| args["do"].as_str())
        .unwrap_or_default()
        .trim();
    if name.is_empty() || cron.is_empty() || do_text.is_empty() {
        return Err(bad("name, cron, and instructions are required"));
    }
    let _parsed_cron = super::schedule::Cron::parse(cron).map_err(|e| bad(e.to_string()))?;
    let requested_perm = args["permission"].as_str().unwrap_or("plan");
    let effective_perm = bots::effective_permission(Some(requested_perm), &bot.permission_ceiling)
        .unwrap_or_else(|_| bot.permission_ceiling.clone());
    let mut policy = json!({
        "coalesce_secs": 0,
        "max_runs_per_hour": 2,
        "permission": effective_perm,
        "carry_last_summary": true,
        "notify": args["notify"].as_str().unwrap_or("attention"),
        "report_to_main": true,
    });
    if let Some(ws) = args["workspace"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        policy["workspace"] = json!(ws);
    }
    if let Some(wecom) = args["wecom_chat_id"]
        .as_str()
        .or_else(|| args["post_to_wecom"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        policy["post_to_wecom"] = json!(wecom);
    }
    let spec = json!({
        "name": name,
        "on": {
            "topic": "schedule",
            "match": { "cron": cron },
        },
        "do": do_text,
        "policy": policy,
    });
    let enabled = args["enabled"].as_bool().unwrap_or(true);
    let schedule_id = args["schedule_id"]
        .as_str()
        .or_else(|| args["id"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if let Some(ref sid) = schedule_id {
        let existing = hub
            .ext
            .store
            .watches()?
            .into_iter()
            .find(|w| &w.id == sid)
            .ok_or_else(|| Error(StatusCode::NOT_FOUND, "schedule not found".into()))?;
        if existing.bot != bot.id || existing.spec["on"]["topic"] != "schedule" {
            return Err(forbidden("cannot modify a schedule not owned by this bot"));
        }
    }
    let view = watches::apply_change(
        hub,
        watches::Change::Upsert {
            id: schedule_id.clone(),
            bot: bot.id.clone(),
            spec,
            enabled,
        },
    )?;
    let saved = view["saved"].as_str().map(str::to_owned).or(schedule_id);
    Ok(json!({
        "schedule_id": saved,
        "id": saved,
        "name": name,
        "cron": cron,
        "description": super::schedule::describe(cron),
        "enabled": enabled,
    }))
}

fn exec_bot_schedule_delete(hub: &Hub, bot: &bots::Bot, args: &Value) -> Result<Value> {
    let id = args["schedule_id"]
        .as_str()
        .or_else(|| args["id"].as_str())
        .unwrap_or_default()
        .trim();
    if id.is_empty() {
        return Err(bad("schedule_id is required"));
    }
    let existing = hub
        .ext
        .store
        .watches()?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| Error(StatusCode::NOT_FOUND, "schedule not found".into()))?;
    if existing.bot != bot.id || existing.spec["on"]["topic"] != "schedule" {
        return Err(forbidden("cannot delete a watch not owned as a schedule by this bot"));
    }
    watches::apply_change(
        hub,
        watches::Change::Delete {
            id: id.to_owned(),
        },
    )?;
    Ok(json!({ "deleted": id }))
}
