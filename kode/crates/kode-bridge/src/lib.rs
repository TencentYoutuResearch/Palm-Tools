use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Read, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query,
    },
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Extension, Json, Router,
};
use base64::Engine;
use kode_core::{
    config::{BackendConfig, Config},
    session::{state::Status as CoreStatus, Session},
    CoreEvent, SessionId,
};
use kode_memory::{
    budget::{BudgetStore, PENALTY_BLACKLIST, PENALTY_REJECT, REWARD_APPROVE},
    git_sync,
    store::{ReviewOutcome, SearchOpts, Verdict},
    MemoryStore,
};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

pub mod backend_probe;
pub mod hook_relay;
pub mod semantic;

pub use hook_relay::{HookRelay, HOOK_SOCKET_PATH};

const DEFAULT_PORT: u16 = 47870;

#[derive(Clone)]
pub struct Ctx {
    pub config: Config,
    pub sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
    pub core_tx: mpsc::UnboundedSender<CoreEvent>,
    pub next_id: Arc<Mutex<SessionId>>,
    pub bus: Arc<BridgeBus>,
    pub token: Arc<String>,
    pub shells: Arc<ShellManager>,
    pub memory: Option<Arc<MemoryHandle>>,
    pub listen_addr: Arc<Mutex<Option<SocketAddr>>>,
    /// HookRelay UDS 路径。None = relay 未启用,create_session 不注入 KODE_HOOK_SOCK。
    /// GUI 通过 AppState::new 把自己的 HookRelay socket 传进来;headless binary 在 run() 里创建。
    pub hook_relay_socket: Option<PathBuf>,
}

pub struct MemoryHandle {
    pub root: PathBuf,
    pub store: tokio::sync::Mutex<MemoryStore>,
    pub budget: tokio::sync::Mutex<BudgetStore>,
}

impl MemoryHandle {
    pub fn open() -> Option<Arc<Self>> {
        let root = resolve_memory_root();
        let store = match MemoryStore::open(&root) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, root = %root.display(), "memory store disabled");
                return None;
            }
        };
        let budget = match BudgetStore::open(&root) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, root = %root.display(), "memory budget disabled");
                return None;
            }
        };
        Some(Arc::new(Self {
            root,
            store: tokio::sync::Mutex::new(store),
            budget: tokio::sync::Mutex::new(budget),
        }))
    }
}

const SHELL_RING_BUFFER_CAPACITY: usize = 50 * 1024;

pub struct ShellManager {
    shells: Arc<Mutex<HashMap<u32, BridgeShell>>>,
    next_id: Mutex<u32>,
}

struct BridgeShell {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    master: Box<dyn MasterPty + Send>,
    ring_buffer: VecDeque<u8>,
    cwd: String,
}

impl BridgeShell {
    fn push_bytes(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if self.ring_buffer.len() >= SHELL_RING_BUFFER_CAPACITY {
                self.ring_buffer.pop_front();
            }
            self.ring_buffer.push_back(b);
        }
    }
}

impl ShellManager {
    pub fn new() -> Self {
        Self {
            shells: Arc::new(Mutex::new(HashMap::new())),
            next_id: Mutex::new(1),
        }
    }

    fn alloc_id(&self) -> u32 {
        let mut g = self.next_id.lock();
        let id = *g;
        *g += 1;
        id
    }
}

impl Default for ShellManager {
    fn default() -> Self {
        Self::new()
    }
}

fn resolve_memory_root() -> PathBuf {
    if let Some(v) = std::env::var_os("KODE_MEMORY_ROOT") {
        return PathBuf::from(v);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".kode-memory")
}

#[derive(Debug, Clone, Serialize)]
pub struct EventEnvelope {
    pub protocol_version: &'static str,
    pub schema_version: u32,
    pub session_id: SessionId,
    pub ts: u64,
    #[serde(rename = "type")]
    pub r#type: String,
    pub payload: Value,
}

impl EventEnvelope {
    pub fn new(session_id: SessionId, typ: impl Into<String>, payload: Value) -> Self {
        Self {
            protocol_version: "v1",
            schema_version: 1,
            session_id,
            ts: now_ms(),
            r#type: typ.into(),
            payload,
        }
    }
}

pub struct BridgeBus {
    tx: broadcast::Sender<EventEnvelope>,
    history: Mutex<HashMap<SessionId, Vec<EventEnvelope>>>,
}

impl BridgeBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            tx,
            history: Mutex::new(HashMap::new()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.tx.subscribe()
    }

    pub fn emit(&self, env: EventEnvelope) {
        if env.r#type != "pty_bytes" && env.r#type != "shell.pty_bytes" {
            let mut h = self.history.lock();
            let list = h.entry(env.session_id).or_default();
            if env.r#type == "meta" {
                // Metadata is state, not timeline content. Long restored Codex
                // sessions can replay thousands of token_count records; keeping
                // every one evicts all message events from this 1000-item ring,
                // so cloud/mobile receives the session shell but no transcript.
                // Keep one merged snapshot in history while still broadcasting
                // every original event below for live consumers.
                let mut stored = env.clone();
                if let Some(index) = list.iter().rposition(|item| item.r#type == "meta") {
                    let previous = list.remove(index);
                    if let (Some(previous), Some(current)) =
                        (previous.payload.as_object(), stored.payload.as_object_mut())
                    {
                        let mut merged = previous.clone();
                        for (key, value) in current.iter() {
                            // JSON null means "this incremental event did not
                            // update the field", so retain the prior value.
                            if !value.is_null() {
                                merged.insert(key.clone(), value.clone());
                            }
                        }
                        *current = merged;
                    }
                }
                list.push(stored);
            } else {
                list.push(env.clone());
            }
            if list.len() > 1000 {
                let drop_n = list.len() - 1000;
                list.drain(0..drop_n);
            }
        }
        let _ = self.tx.send(env);
    }

    pub fn history_for(&self, id: SessionId, from: u64, limit: usize) -> Vec<EventEnvelope> {
        self.history
            .lock()
            .get(&id)
            .map(|v| {
                v.iter()
                    .filter(|e| e.ts >= from)
                    .take(limit)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Default for BridgeBus {
    fn default() -> Self {
        Self::new()
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Ctx {
    pub fn alloc_id(&self) -> SessionId {
        let mut g = self.next_id.lock();
        let id = *g;
        *g += 1;
        id
    }
}

pub async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,kode_bridge=debug,kode_core=debug")
            }),
        )
        .init();

    let token = load_or_init_bridge_token()?;
    let config = Config::load();
    let (core_tx, core_rx) = mpsc::unbounded_channel();

    // 创建 HookRelay(UDS /tmp/kode-hook.sock)。bind 失败(另一实例在跑)→ None,
    // 降级为无 hook(turn_finished 等功能静默不可用,不阻断启动)。
    let hook_relay = HookRelay::new().await.ok();
    let hook_relay_socket = hook_relay.as_ref().map(|r| r.socket_path().to_path_buf());

    let ctx = Arc::new(Ctx {
        config,
        sessions: Arc::new(Mutex::new(HashMap::new())),
        core_tx,
        next_id: Arc::new(Mutex::new(1)),
        bus: Arc::new(BridgeBus::new()),
        token: Arc::new(token),
        shells: Arc::new(ShellManager::new()),
        memory: MemoryHandle::open(),
        listen_addr: Arc::new(Mutex::new(None)),
        hook_relay_socket,
    });

    spawn_event_router(Arc::clone(&ctx), core_rx);
    spawn_status_ticker(Arc::clone(&ctx));
    spawn_memory_pending_watcher(Arc::clone(&ctx));

    // spawn HookRelay 主循环(需要 ctx.bus)。
    if let Some(relay) = hook_relay {
        let bus = Arc::clone(&ctx.bus);
        let core_tx = ctx.core_tx.clone();
        tokio::spawn(async move { relay.run(bus, core_tx).await });
    }

    // 注入 settings.json hook(幂等)。仅当 HookRelay 启用时才有意义 ——
    // 否则 hook command 会引用一个没人监听的 socket,codebuddy/claude hook 静默失败。
    if ctx.hook_relay_socket.is_some() {
        inject_hooks_into_settings();
    }

    let bind = bridge_bind();
    let router = build_router(Arc::clone(&ctx));
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let actual = listener.local_addr().unwrap_or(bind);
    *ctx.listen_addr.lock() = Some(actual);
    tracing::info!(addr = %actual, token_file = "~/.kode/state.json", "kode-bridge listening");
    axum::serve(listener, router).await?;
    Ok(())
}

/// 把 kode 管理的 hook 写入 codebuddy/claude settings.json + codex hooks.json。
/// 幂等(用 `_kode_managed` 标记去重),重复调用只更新不追加。与 GUI 的
/// `memory_mcp::spawn_startup_probe` 对称,确保远端 bridge 也能自动配置 hook。
fn inject_hooks_into_settings() {
    let relay_cmd = kode_memory::hook_setup::build_codebuddy_hook_command();
    for (label, path) in kode_memory::hook_setup::target_settings() {
        if let Err(e) = kode_memory::hook_setup::inject_stop_hook(&path, &relay_cmd) {
            tracing::warn!(label, error = %e, "stop hook inject failed");
        }
        if let Err(e) = kode_memory::hook_setup::inject_notification_hook(&path, &relay_cmd) {
            tracing::warn!(label, error = %e, "notification hook inject failed");
        }
        if let Err(e) = kode_memory::hook_setup::inject_user_prompt_submit_hook(&path, &relay_cmd) {
            tracing::warn!(label, error = %e, "user_prompt_submit hook inject failed");
        }
        if let Err(e) = kode_memory::hook_setup::inject_pretooluse_hook(&path, &relay_cmd) {
            tracing::warn!(label, error = %e, "pretooluse hook inject failed");
        }
        if let Err(e) = kode_memory::hook_setup::inject_session_start_hook(&path, &relay_cmd) {
            tracing::warn!(label, error = %e, "session_start hook inject failed");
        }
        if label == "codebuddy" {
            if let Err(e) = kode_memory::hook_setup::inject_config_change_hook(&path, &relay_cmd) {
                tracing::warn!(label, error = %e, "config_change hook inject failed");
            }
        }
    }
    if let Some(path) = kode_memory::hook_setup::codex_hooks_path() {
        let cmd = kode_memory::hook_setup::build_codex_hook_command();
        if let Err(e) = kode_memory::hook_setup::inject_codex_hooks(&path, &cmd) {
            tracing::warn!(error = %e, "codex hook inject failed");
        }
    }
}

/// 构建注入到子进程的 extra env。镜像本地 `transport/local.rs` 的逻辑:
/// - `KODE_HOOK_SOCK`:hook command 定位 relay socket(仅当 ctx 启用了 HookRelay)
/// - `KODE_SESSION_ID`:让 `kode-memory codebuddy-hook` 把 codebuddy 的 uuid session_id
///   改写成 kode tab id(u64),使 relay 能正确路由
/// - `KODE_MEMORY_ROOT`:让 hook 子进程与 bridge/MCP 使用同一份 memory root
/// - `TERM_THEME` / `COLORFGBG`:让 cursor-agent / Claude / 其它 TUI 跳过 OSC 11
fn build_session_env(
    ctx: &Ctx,
    id: SessionId,
    backend_key: &str,
    term_theme: Option<&str>,
) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(sock) = ctx.hook_relay_socket.as_deref() {
        env.push((
            "KODE_HOOK_SOCK".to_string(),
            sock.to_string_lossy().into_owned(),
        ));
    }
    env.push(("KODE_SESSION_ID".to_string(), id.to_string()));
    env.push(("KODE_BACKEND_KEY".to_string(), backend_key.to_string()));
    env.push((
        "KODE_MEMORY_ROOT".to_string(),
        resolve_memory_root().display().to_string(),
    ));
    let dark = kode_core::pty::parse_term_theme(term_theme).unwrap_or(true);
    env.extend(kode_core::pty::terminal_theme_env(dark));
    env
}

#[doc(hidden)]
pub fn build_test_ctx(config: Config, token: String) -> Arc<Ctx> {
    let (core_tx, core_rx) = mpsc::unbounded_channel();
    let ctx = Arc::new(Ctx {
        config,
        sessions: Arc::new(Mutex::new(HashMap::new())),
        core_tx,
        next_id: Arc::new(Mutex::new(1)),
        bus: Arc::new(BridgeBus::new()),
        token: Arc::new(token),
        shells: Arc::new(ShellManager::new()),
        memory: None,
        listen_addr: Arc::new(Mutex::new(None)),
        hook_relay_socket: None,
    });
    spawn_event_router(Arc::clone(&ctx), core_rx);
    spawn_status_ticker(Arc::clone(&ctx));
    spawn_memory_pending_watcher(Arc::clone(&ctx));
    ctx
}

fn bridge_bind() -> SocketAddr {
    let port = std::env::var("KODE_BRIDGE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let host = std::env::var("KODE_BRIDGE_BIND")
        .ok()
        .and_then(|s| s.parse::<Ipv4Addr>().ok())
        .unwrap_or(Ipv4Addr::new(127, 0, 0, 1));
    SocketAddr::new(host.into(), port)
}

fn state_path() -> anyhow::Result<PathBuf> {
    let dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("home dir not available"))?
        .join(".kode");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("state.json"))
}

fn load_or_init_bridge_token() -> anyhow::Result<String> {
    let path = state_path()?;
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(t) = v.get("bridge_token").and_then(|x| x.as_str()) {
                if !t.is_empty() {
                    return Ok(t.to_string());
                }
            }
        }
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let value = json!({ "schema_version": 1, "bridge_token": token });
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&value)?)?;
    std::fs::rename(tmp, path)?;
    Ok(value["bridge_token"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}

pub fn spawn_event_router(ctx: Arc<Ctx>, mut rx: mpsc::UnboundedReceiver<CoreEvent>) {
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CoreEvent::PtyBytes { id, bytes } => {
                    if let Some(s) = ctx.sessions.lock().get_mut(&id) {
                        s.feed(&bytes, false);
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    ctx.bus.emit(EventEnvelope::new(
                        id,
                        "pty_bytes",
                        json!({ "bytes_b64": b64 }),
                    ));
                }
                CoreEvent::PtyExited { id, code } => {
                    if let Some(s) = ctx.sessions.lock().get_mut(&id) {
                        s.mark_exited(code);
                    }
                    ctx.bus.emit(EventEnvelope::new(
                        id,
                        "session.exited",
                        json!({ "exit_code": code }),
                    ));
                }
                CoreEvent::JsonlMeta {
                    id,
                    model,
                    title,
                    session_uuid,
                    tokens,
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                    cost_usd,
                    context_pct,
                    ..
                } => {
                    let semantic_retarget = {
                        let mut sessions = ctx.sessions.lock();
                        if let Some(s) = sessions.get_mut(&id) {
                            if let Some(m) = &model {
                                s.state.model = m.clone();
                            }
                            if let Some(t) = &title {
                                s.state.title = t.clone();
                            }
                            let retarget = if let Some(sid) = &session_uuid {
                                let changed = s.session_id.as_deref() != Some(sid);
                                s.session_id = Some(sid.clone());
                                if changed {
                                    kode_core::session::jsonl_tail::Backend::from_backend_key(
                                        &s.backend_key,
                                    )
                                    .map(|backend| (backend, s.cwd.clone(), sid.clone()))
                                } else {
                                    None
                                }
                            } else {
                                None
                            };
                            if let Some(t) = tokens {
                                s.state.tokens = Some(t);
                            }
                            if let Some(t) = input_tokens {
                                s.state.tokens_input = Some(t);
                            }
                            if let Some(t) = output_tokens {
                                s.state.tokens_output = Some(t);
                            }
                            if let Some(t) = cached_tokens {
                                s.state.tokens_cached = Some(t);
                            }
                            s.state.cost_usd = cost_usd;
                            retarget
                        } else {
                            None
                        }
                    };
                    if let Some((backend, cwd, sid)) = semantic_retarget {
                        semantic::spawn(id, backend, cwd, sid, Arc::clone(&ctx.bus));
                    }
                    ctx.bus.emit(EventEnvelope::new(
                        id,
                        "meta",
                        json!({
                            "model": model,
                            "title": title,
                            "session_uuid": session_uuid,
                            "tokens": tokens,
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                            "cached_tokens": cached_tokens,
                            "cost_usd": cost_usd,
                            "context_pct": context_pct,
                        }),
                    ));
                }
                CoreEvent::BusEvent {
                    id,
                    event_type,
                    payload,
                } => {
                    ctx.bus.emit(EventEnvelope::new(id, event_type, payload));
                }
                CoreEvent::TurnHold { id, active } => {
                    if let Some(s) = ctx.sessions.lock().get_mut(&id) {
                        if active {
                            s.mark_turn_start();
                        } else {
                            s.mark_turn_end();
                        }
                    }
                }
            }
        }
    });
}

/// 周期(200ms)tick 所有 session 的状态(starting→idle / busy→idle),
/// 状态变化时通过 bus emit `session.status`,让远端 GUI 能实时看到状态。
/// GUI 端的 `spawn_prompt_scan_loop`(state.rs)做同样的事 —— bridge 端需要
/// 独立 tick,因为 GUI 端没有 bridge sessions 的引用。
fn spawn_status_ticker(ctx: Arc<Ctx>) {
    spawn_turn_hold_from_bus(Arc::clone(&ctx));
    tokio::spawn(async move {
        tracing::info!("status ticker started (200ms interval)");
        let mut last_status: HashMap<SessionId, &'static str> = HashMap::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let mut sessions = ctx.sessions.lock();
            for (id, s) in sessions.iter_mut() {
                // s.feed() 会在 event_router 里同步把 Starting/Idle 改成 Busy;
                // tick_status() 只负责 Busy→Idle 等超时翻转。这里不能只比较
                // tick 前后,否则会漏掉 feed() 造成的 Busy。
                s.tick_status();
                let current = status_label(s.state.status);
                if last_status.get(id).copied() != Some(current) {
                    tracing::info!(
                        session_id = id,
                        status = current,
                        "status changed → emit session.status"
                    );
                    last_status.insert(*id, current);
                    ctx.bus.emit(EventEnvelope::new(
                        *id,
                        "session.status",
                        json!({ "status": current }),
                    ));
                }
            }
        }
    });
}

/// jsonl `turn_ended` / semantic 发出的 turn_finished 不经过 HookRelay。
/// 这里把 bus 上的结束信号同步到 Session.turn_hold,否则 Cursor 思考期锁住的
/// busy 永远翻不回去。
fn spawn_turn_hold_from_bus(ctx: Arc<Ctx>) {
    tokio::spawn(async move {
        let mut rx = ctx.bus.subscribe();
        loop {
            match rx.recv().await {
                Ok(env) if env.r#type == "session.turn_finished" => {
                    if let Some(s) = ctx.sessions.lock().get_mut(&env.session_id) {
                        s.mark_turn_end();
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                _ => {}
            }
        }
    });
}

/// 远端 memory MCP 写入 pending 后,无头 bridge 需要主动把 pending 数推给 GUI。
/// GUI 通过 `memory.pending` 事件更新状态栏 badge,再用 HTTP API 拉取/审核详情。
fn spawn_memory_pending_watcher(ctx: Arc<Ctx>) {
    let Some(mem) = ctx.memory.clone() else {
        return;
    };
    tokio::spawn(async move {
        tracing::info!("memory pending watcher started (1500ms interval)");
        let mut last: Option<usize> = None;
        let mut tick = tokio::time::interval(Duration::from_millis(1500));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let count = {
                let store = mem.store.lock().await;
                match store.count_pending() {
                    Ok(n) => n,
                    Err(e) => {
                        tracing::warn!(error = %e, "memory.count_pending failed");
                        continue;
                    }
                }
            };
            if last != Some(count) {
                last = Some(count);
                ctx.bus.emit(EventEnvelope::new(
                    0,
                    "memory.pending",
                    json!({ "count": count }),
                ));
            }
        }
    });
}

pub fn build_router(ctx: Arc<Ctx>) -> Router {
    let protected = Router::new()
        .route("/api/v1/sessions", get(list_sessions).post(create_session))
        .route("/api/v1/sessions/history", get(list_sessions_history))
        .route(
            "/api/v1/sessions/:id",
            get(get_session).delete(kill_session),
        )
        .route("/api/v1/sessions/:id/history", get(get_history))
        .route("/api/v1/sessions/:id/transcript", get(get_transcript))
        .route("/api/v1/sessions/:id/input", post(post_input))
        .route("/api/v1/sessions/:id/focus", post(post_focus))
        .route("/api/v1/sessions/:id/answer", post(post_answer))
        .route(
            "/api/v1/sessions/:id/plan_response",
            post(post_plan_response),
        )
        .route("/api/v1/sessions/:id/mode", post(post_mode))
        .route("/api/v1/sessions/:id/resize", post(post_resize))
        .route("/api/v1/shells", post(shell_spawn))
        .route("/api/v1/shells/:id", delete(shell_kill))
        .route("/api/v1/shells/:id/input", post(shell_input))
        .route("/api/v1/shells/:id/resize", post(shell_resize))
        .route("/api/v1/shells/:id/snapshot", get(shell_snapshot))
        .route("/api/v1/backends", get(list_backends))
        .route("/api/v1/backends/:key/models", get(list_backend_models))
        .route("/api/v1/fs/list", get(fs_list))
        .route("/api/v1/fs/preview", get(fs_preview))
        .route("/api/v1/git/status", get(git_status))
        .route("/api/v1/git/diff", get(git_diff))
        .route("/api/v1/git/commit-diff", get(git_commit_diff))
        .route("/api/v1/git/commit-detail", get(git_commit_detail))
        .route("/api/v1/git/commit-file-diff", get(git_commit_file_diff))
        .route("/api/v1/memory/pending", get(memory_list_pending))
        .route("/api/v1/memory/pending/:id/review", post(memory_review))
        .route("/api/v1/memory/search", get(memory_search))
        .route("/api/v1/memory/recent", get(memory_recent))
        .route("/ws", get(ws_upgrade))
        .layer(middleware::from_fn(auth_layer));

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(protected)
        .layer(Extension(ctx))
}

async fn auth_layer(
    Extension(ctx): Extension<Arc<Ctx>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, ApiError> {
    let provided = if req.uri().path() == "/ws" {
        req.uri()
            .query()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")))
            .map(url_decode_simple)
            .or_else(|| bearer(req.headers().get(header::AUTHORIZATION)))
    } else {
        bearer(req.headers().get(header::AUTHORIZATION))
    };
    match provided {
        Some(p) if constant_eq(&p, &ctx.token) => Ok(next.run(req).await),
        _ => Err(ApiError::Unauthorized),
    }
}

fn bearer(v: Option<&header::HeaderValue>) -> Option<String> {
    v.and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").map(|x| x.to_string()))
}

fn constant_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn url_decode_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.bytes();
    while let Some(b) = it.next() {
        if b == b'%' {
            let h1 = it.next().and_then(|c| (c as char).to_digit(16));
            let h2 = it.next().and_then(|c| (c as char).to_digit(16));
            if let (Some(a), Some(b)) = (h1, h2) {
                out.push((a as u8 * 16 + b as u8) as char);
                continue;
            }
        }
        out.push(if b == b'+' { ' ' } else { b as char });
    }
    out
}

#[derive(Debug)]
enum ApiError {
    Unauthorized,
    NotFound(String),
    BadRequest(String),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, name, detail) = match self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", String::new()),
            ApiError::NotFound(d) => (StatusCode::NOT_FOUND, "not_found", d),
            ApiError::BadRequest(d) => (StatusCode::BAD_REQUEST, "bad_request", d),
            ApiError::Internal(d) => (StatusCode::INTERNAL_SERVER_ERROR, "internal", d),
        };
        (code, Json(json!({ "error": name, "detail": detail }))).into_response()
    }
}

#[derive(Serialize)]
struct SessionDto {
    id: SessionId,
    backend_key: String,
    title: String,
    model: String,
    status: &'static str,
    cwd: Option<String>,
    session_uuid: Option<String>,
    tokens: TokensDto,
    context_pct: Option<f32>,
    cost_usd: Option<f64>,
}

#[derive(Default, Serialize)]
struct TokensDto {
    total: u64,
    input: u64,
    output: u64,
    cached: u64,
}

fn status_label(s: CoreStatus) -> &'static str {
    match s {
        CoreStatus::Starting => "starting",
        CoreStatus::Idle => "idle",
        CoreStatus::Busy => "busy",
        CoreStatus::Exited(_) => "exited",
    }
}

fn session_to_dto(s: &Session) -> SessionDto {
    SessionDto {
        id: s.id,
        backend_key: s.backend_key.clone(),
        title: s.state.title.clone(),
        model: s.state.model.clone(),
        status: status_label(s.state.status),
        cwd: Some(s.cwd.to_string_lossy().into_owned()),
        session_uuid: s.session_id.clone(),
        tokens: TokensDto {
            total: s.state.tokens.unwrap_or(0),
            input: s.state.tokens_input.unwrap_or(0),
            output: s.state.tokens_output.unwrap_or(0),
            cached: s.state.tokens_cached.unwrap_or(0),
        },
        context_pct: None,
        cost_usd: s.state.cost_usd,
    }
}

async fn list_sessions(Extension(ctx): Extension<Arc<Ctx>>) -> Json<Value> {
    let sessions: Vec<_> = ctx.sessions.lock().values().map(session_to_dto).collect();
    Json(json!({ "sessions": sessions }))
}

#[derive(Deserialize)]
struct CreateSessionReq {
    backend_key: String,
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
    resume_session_uuid: Option<String>,
    permission_mode: Option<String>,
    model: Option<String>,
    memory_context: Option<String>,
    /// Additional CLI args appended to the backend command (e.g. `--add-dir`).
    /// Used by SpecOps to inject `--add-dir <worktree>` so codebuddy trusts the directory.
    extra_args: Option<Vec<String>>,
    /// Initial prompt passed as a positional arg to the backend CLI.
    /// Inserted BEFORE injected flags so variadic flags like --add-dir don't consume it.
    prompt: Option<String>,
    /// Headless session: a background agent the user never interacts with
    /// directly (e.g. SpecOps auto-review). When true, the bridge does NOT emit
    /// `session.created`, so the kode GUI opens no tab for it. The session still
    /// exists and is reachable via the HTTP API (get/transcript/kill).
    #[serde(default)]
    headless: bool,
    /// `light` / `dark`. When omitted the child gets Kode's dark default so
    /// cursor-agent skips the OSC 11 probe that times out over PTY IPC.
    #[serde(default)]
    term_theme: Option<String>,
}

async fn create_session(
    Extension(ctx): Extension<Arc<Ctx>>,
    Json(req): Json<CreateSessionReq>,
) -> Result<Json<SessionDto>, ApiError> {
    let mut backend: BackendConfig = ctx
        .config
        .backend(&req.backend_key)
        .ok_or_else(|| {
            ApiError::BadRequest(format!("backend not configured: {}", req.backend_key))
        })?
        .clone();
    // Append extra_args to the backend args (e.g. --add-dir for directory trust).
    if let Some(extra) = &req.extra_args {
        backend.args.extend(extra.iter().cloned());
    }
    let id = ctx.alloc_id();
    let cwd = req
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let model = sanitize_requested_model(req.model.as_deref());
    let extra_env = build_session_env(&ctx, id, &req.backend_key, req.term_theme.as_deref());
    let mut session = Session::new(
        id,
        &req.backend_key,
        &backend,
        req.cols.unwrap_or(80),
        req.rows.unwrap_or(24),
        Duration::from_millis(ctx.config.ui.idle_threshold_ms),
        ctx.config.ui.scrollback_lines,
        &cwd,
        ctx.core_tx.clone(),
        req.resume_session_uuid.as_deref(),
        req.permission_mode.as_deref(),
        model.as_deref(),
        true,
        req.memory_context.as_deref(),
        &extra_env,
        req.prompt.as_deref(),
    )
    .map_err(|e| ApiError::Internal(format!("spawn failed: {e}")))?;
    let resume_meta = resume_meta_snapshot(&req.backend_key, &cwd, session.session_id.as_deref());
    if let Some(meta) = &resume_meta {
        if let Some(model) = &meta.model {
            session.state.model = model.clone();
        }
        if let Some(title) = &meta.title {
            session.state.title = title.clone();
        }
        if let Some(tokens) = meta.total_tokens {
            session.state.tokens = Some(tokens);
        }
    }
    let dto = session_to_dto(&session);
    ctx.sessions.lock().insert(id, session);
    if let (Some(sid), Some(backend_kind)) = (
        dto.session_uuid.as_deref(),
        kode_core::session::jsonl_tail::Backend::from_backend_key(&req.backend_key),
    ) {
        semantic::spawn(
            id,
            backend_kind,
            cwd.clone(),
            sid.to_string(),
            Arc::clone(&ctx.bus),
        );
    }
    // Headless sessions (e.g. SpecOps auto-review agents) skip session.created
    // so the GUI opens no tab. The session is still fully usable via the HTTP
    // API. Non-headless sessions emit as before.
    if req.headless {
        tracing::info!(
            target: "bridge_create_session",
            id,
            "bridge create_session: headless session, suppressing session.created"
        );
    } else {
        tracing::info!(
            target: "bridge_create_session",
            id,
            "bridge create_session emitting session.created to bus"
        );
        ctx.bus.emit(EventEnvelope::new(
            id,
            "session.created",
            serde_json::to_value(&dto).unwrap_or_default(),
        ));
    }
    if let Some(meta) = resume_meta {
        ctx.bus.emit(EventEnvelope::new(
            id,
            "meta",
            json!({
                "model": meta.model,
                "title": meta.title,
                "session_uuid": dto.session_uuid.clone(),
                "tokens": meta.total_tokens,
            }),
        ));
    }
    Ok(Json(dto))
}

fn sanitize_requested_model(model: Option<&str>) -> Option<String> {
    model.and_then(|m| {
        let cleaned = kode_core::model_alias::sanitize_model_name(m);
        let cleaned = cleaned.trim();
        if cleaned.is_empty() || cleaned == "auto" {
            None
        } else {
            Some(cleaned.to_string())
        }
    })
}

#[derive(Debug)]
struct ResumeMetaSnapshot {
    title: Option<String>,
    model: Option<String>,
    total_tokens: Option<u64>,
}

fn resume_meta_snapshot(
    backend_key: &str,
    cwd: &std::path::Path,
    session_id: Option<&str>,
) -> Option<ResumeMetaSnapshot> {
    let sid = session_id?;
    let profile = kode_core::session::backend::profile_for_key(backend_key)?;
    let path = profile.find_session_path(cwd, sid)?;
    let snap = kode_core::session::backend::transcript_snapshot(&path);
    if snap.title.is_none() && snap.model.is_none() && snap.total_tokens.is_none() {
        return None;
    }
    Some(ResumeMetaSnapshot {
        title: snap.title,
        model: snap.model,
        total_tokens: snap.total_tokens,
    })
}

async fn get_session(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
) -> Result<Json<SessionDto>, ApiError> {
    let g = ctx.sessions.lock();
    let s = g
        .get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("session {id}")))?;
    Ok(Json(session_to_dto(s)))
}

async fn kill_session(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
) -> Result<StatusCode, ApiError> {
    let s = ctx.sessions.lock().remove(&id);
    let Some(s) = s else {
        return Err(ApiError::NotFound(format!("session {id}")));
    };
    if let Some(p) = &s.pty {
        p.kill();
    }
    ctx.bus.emit(EventEnvelope::new(
        id,
        "session.exited",
        json!({ "exit_code": null, "reason": "deleted_by_api" }),
    ));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct HistoryQuery {
    from: Option<u64>,
    limit: Option<usize>,
}

async fn get_history(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Query(q): Query<HistoryQuery>,
) -> Json<Value> {
    let from = q.from.unwrap_or(0);
    let events = ctx
        .bus
        .history_for(id, from, q.limit.unwrap_or(200).min(1000));
    let next_from = events.last().map(|e| e.ts + 1).unwrap_or(from);
    Json(json!({ "events": events, "next_from": next_from }))
}

/// Structured conversation transcript for a session, read from the backend's
/// jsonl session file (the bus history only carries pty_bytes/meta/status, not
/// the assistant/user text). Returns `{ messages: [{ role, text }] }` in file
/// order. Empty (not an error) when the session has no uuid yet or the jsonl
/// file doesn't exist — callers poll and it fills in once the backend writes.
async fn get_transcript(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
) -> Json<Value> {
    // Snapshot the routing info we need, then drop the lock before file I/O.
    let routing = {
        let guard = ctx.sessions.lock();
        guard.get(&id).and_then(|s| {
            let uuid = s.session_id.clone()?;
            let backend =
                kode_core::session::jsonl_tail::Backend::from_backend_key(&s.backend_key)?;
            Some((backend, s.cwd.clone(), uuid))
        })
    };
    let Some((backend, cwd, uuid)) = routing else {
        return Json(json!({ "messages": [] }));
    };
    let Some(path) = kode_core::session::jsonl_tail::resolve_session_path(backend, &cwd, &uuid)
    else {
        return Json(json!({ "messages": [] }));
    };
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return Json(json!({ "messages": [] })),
    };
    let reader = std::io::BufReader::new(file);
    let messages = parse_transcript_lines(reader.lines().map_while(Result::ok));
    Json(json!({ "messages": messages }))
}

/// Parse a codebuddy/claude jsonl session transcript into transcript messages.
///
/// Each line becomes one of:
/// - `{role, text, kind:"text"}` for `type:"message"` (user/assistant prose)
/// - `{role:"agent", kind:"tool_use", tool, tool_call_id, summary, status:"running"}`
///   for `type:"function_call"` (ordinary tool invocations only — protocol-level
///   tools like AskUserQuestion/ExitPlanMode/TaskCreate/TaskUpdate are skipped)
/// - `{role:"agent", kind:"tool_result", tool, tool_call_id, preview, status}`
///   for `type:"function_call_result"` (same protocol-level skip)
///
fn json_content_to_text(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = v.as_array() {
        let text = arr
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("input_text"))
                    .or_else(|| item.get("output_text"))
                    .or_else(|| item.get("content"))
                    .and_then(|x| x.as_str())
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    None
}

/// Extracted from `get_transcript` so it can be unit-tested without spinning up
/// a real PTY-backed Session.
fn parse_transcript_lines<S: AsRef<str>>(lines: impl IntoIterator<Item = S>) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    for line in lines {
        let line = line.as_ref();
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            // codebuddy/claude conversation lines: type=="message" with a role.
            "message" => {
                let out_role = match v.get("role").and_then(|r| r.as_str()) {
                    Some("assistant") => "agent",
                    Some("user") => "user",
                    _ => continue,
                };
                let Some(content) = v
                    .get("content")
                    .or_else(|| v.get("message").and_then(|m| m.get("content")))
                else {
                    continue;
                };
                let Some(text) = json_content_to_text(content) else {
                    continue;
                };
                let trimmed = text.trim();
                if is_control_line(out_role, trimmed) {
                    continue;
                }
                messages.push(json!({ "role": out_role, "text": trimmed, "kind": "text" }));
            }
            // Agent invoked a tool. Skip protocol-level tools (they have their
            // own cards); emit a tool_use entry so the UI can show a card.
            "function_call" => {
                let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                if tool_name_is_protocol(name) {
                    continue;
                }
                let call_id = v
                    .get("callId")
                    .and_then(|x| x.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("call-{}", semantic::fnv_hash(&v.to_string())));
                // arguments is a JSON string in codebuddy — parse to feed summarize.
                let args: Value = v
                    .get("arguments")
                    .and_then(|a| match a {
                        Value::String(s) => serde_json::from_str(s).ok(),
                        other => Some(other.clone()),
                    })
                    .unwrap_or(Value::Null);
                let summary = v
                    .get("providerData")
                    .and_then(|pd| pd.get("argumentsDisplayText"))
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| {
                        if args.is_null() {
                            name.to_string()
                        } else {
                            semantic::summarize_tool_input(name, &args)
                        }
                    });
                messages.push(json!({
                    "role": "agent",
                    "kind": "tool_use",
                    "tool": name,
                    "tool_call_id": call_id,
                    "summary": summary,
                    "status": "running",
                }));
            }
            // Tool result. Skip protocol-level tools (already surfaced as cards).
            "function_call_result" => {
                let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                if tool_name_is_protocol(name) {
                    continue;
                }
                let call_id = v
                    .get("callId")
                    .and_then(|x| x.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("call-{}", semantic::fnv_hash(&v.to_string())));
                let status_raw = v.get("status").and_then(|x| x.as_str()).unwrap_or("");
                let status = match status_raw {
                    "completed" | "ok" | "success" => "ok",
                    "failed" | "error" | "errored" | "incomplete" => "error",
                    _ => "ok",
                };
                let preview = v
                    .get("output")
                    .map(|o| semantic::value_to_preview(o, 4 * 1024))
                    .unwrap_or_default();
                messages.push(json!({
                    "role": "agent",
                    "kind": "tool_result",
                    "tool": name,
                    "tool_call_id": call_id,
                    "preview": preview,
                    "status": status,
                }));
            }
            _ => continue,
        }
    }
    messages
}

/// Protocol-level tools that have their own dedicated UI cards (AskUserQuestion,
/// ExitPlanMode, TaskCreate, TaskUpdate). They are excluded from the transcript
/// conversation flow to avoid noise — only ordinary tool calls (Read/Grep/Bash/…)
/// surface as tool_use cards.
fn tool_name_is_protocol(name: &str) -> bool {
    matches!(
        name,
        "AskUserQuestion" | "ExitPlanMode" | "TaskCreate" | "TaskUpdate"
    )
}

/// Decide whether a transcript line is a control/command line that should be
/// hidden from the conversation view.
///
/// Only genuine control noise is dropped:
/// - injected tags the harness adds (`<system-reminder>`, `<command-…>`,
///   `<local-command-…>`, `<user-prompt-…>`) — but NOT ordinary prose that
///   merely begins with `<` (XML, HTML, markdown quotes, code).
/// - slash commands and `C-b` tmux keys — but only from the USER. An assistant
///   reply that legitimately starts with `/path` or `C-b` is real content.
fn is_control_line(role: &str, trimmed: &str) -> bool {
    if trimmed.is_empty() {
        return true;
    }
    // Harness-injected tags (either role).
    const INJECTED_TAGS: [&str; 4] = [
        "<system-reminder",
        "<command-",
        "<local-command",
        "<user-prompt",
    ];
    if INJECTED_TAGS.iter().any(|tag| trimmed.starts_with(tag)) {
        return true;
    }
    // Slash commands and tmux prefix keys are control input — user role only.
    if role == "user" && (trimmed.starts_with('/') || trimmed.starts_with("C-b")) {
        return true;
    }
    false
}

#[derive(Deserialize)]
struct InputReq {
    text: Option<String>,
    bytes_b64: Option<String>,
}

const TEXT_INPUT_SUBMIT_DELAY: Duration = Duration::from_millis(50);

/// REST `text` 表示一条要提交的消息，不是原始 PTY 字节。
///
/// Mobile 会在正文末尾补 LF；这里去掉所有末尾 CR/LF，保留正文内部换行。
/// 正文和 Enter 必须分两次写入，否则 Ink 会把整批字节识别成 paste，导致文字
/// 出现在输入框里却没有触发 onSubmit。
fn text_input_body(text: &str) -> &str {
    text.trim_end_matches(['\r', '\n'])
}

#[derive(Debug)]
pub struct TextInputError {
    pub session_id: SessionId,
}

impl std::fmt::Display for TextInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "session {} not found", self.session_id)
    }
}

impl std::error::Error for TextInputError {}

/// Submit one logical text message to a local session.
///
/// The body and Enter are deliberately written separately. Ink-based CLI UIs
/// otherwise classify one combined write as a paste and leave the text in the
/// composer without submitting it. Cloud command routing calls this same path
/// so direct-bridge and centralized mobile input remain behaviorally identical.
pub fn submit_text_input(ctx: &Ctx, id: SessionId, text: &str) -> Result<(), TextInputError> {
    let body = text_input_body(text);
    let enter_writer = {
        let mut sessions = ctx.sessions.lock();
        let session = sessions
            .get_mut(&id)
            .ok_or(TextInputError { session_id: id })?;
        session.mark_turn_start();
        if body.is_empty() {
            session.write_input(b"\r");
            None
        } else {
            tracing::debug!(session = id, bytes = body.len(), "bridge input write text");
            session.write_input(body.as_bytes());
            session.pty.as_ref().map(|pty| Arc::clone(&pty.writer))
        }
    };

    if let Some(writer) = enter_writer {
        std::thread::spawn(move || {
            std::thread::sleep(TEXT_INPUT_SUBMIT_DELAY);
            tracing::debug!(session = id, "bridge input write enter");
            match writer.lock() {
                Ok(mut writer) => {
                    if let Err(error) = writer.write_all(b"\r") {
                        tracing::warn!(?error, session = id, "bridge input enter failed");
                    }
                    let _ = writer.flush();
                }
                Err(error) => {
                    tracing::warn!(?error, session = id, "bridge input writer poisoned");
                }
            }
        });
    }

    ctx.bus.emit(EventEnvelope::new(
        id,
        "session.attention_cleared",
        json!({
            "reason": if body.is_empty() {
                "user_enter_via_api"
            } else {
                "user_input_via_api"
            }
        }),
    ));
    Ok(())
}

async fn post_focus(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
) -> Result<StatusCode, ApiError> {
    // 带上 session DTO,让 GUI 在主窗口里没有该 tab 时(SpecOps headless 创建、
    // 主窗口错过 session.created)能用 payload 补建 tab,而不是静默忽略 focus。
    let dto = {
        let guard = ctx.sessions.lock();
        let session = guard
            .get(&id)
            .ok_or_else(|| ApiError::NotFound(format!("session {id}")))?;
        session_to_dto(session)
    };
    ctx.bus.emit(EventEnvelope::new(
        id,
        "session.focus_requested",
        serde_json::to_value(&dto).unwrap_or_default(),
    ));
    Ok(StatusCode::NO_CONTENT)
}

async fn post_input(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Json(req): Json<InputReq>,
) -> Result<StatusCode, ApiError> {
    let g = ctx.sessions.lock();
    let s = g
        .get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("session {id}")))?;

    match (req.bytes_b64, req.text) {
        // 原始字节路径用于控制键和高级序列，保持完全透传。
        (Some(b64), _) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| ApiError::BadRequest(format!("invalid base64: {e}")))?;
            s.write_input(&bytes);
        }
        (None, Some(text)) => {
            drop(g);
            submit_text_input(&ctx, id, &text)
                .map_err(|_| ApiError::NotFound(format!("session {id}")))?;
        }
        (None, None) => {
            return Err(ApiError::BadRequest("text or bytes_b64 required".into()));
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AnswerReq {
    #[serde(default)]
    question_id: Option<String>,
    choice_index: u32,
    #[serde(default)]
    free_text: Option<String>,
    #[serde(default)]
    submit: bool,
}

async fn post_answer(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Json(req): Json<AnswerReq>,
) -> Result<StatusCode, ApiError> {
    let _ = req.question_id;
    let _ = req.free_text;
    if req.choice_index > 8 {
        return Err(ApiError::BadRequest(format!(
            "choice_index out of range: {} (max 8)",
            req.choice_index
        )));
    }
    submit_answer(&ctx, id, req.choice_index, req.submit)
        .await
        .map_err(|_| ApiError::NotFound(format!("session {id}")))?;
    Ok(StatusCode::NO_CONTENT)
}

fn answer_input(choice_index: u32) -> Vec<u8> {
    let mut input = Vec::with_capacity(choice_index as usize * 3 + 1);
    for _ in 0..choice_index {
        input.extend_from_slice(b"\x1b[B");
    }
    input.push(b'\r');
    input
}

pub async fn submit_answer(
    ctx: &Ctx,
    id: SessionId,
    choice_index: u32,
    submit: bool,
) -> Result<(), TextInputError> {
    if choice_index > 8 {
        return Err(TextInputError { session_id: id });
    }
    let input = answer_input(choice_index);
    {
        let sessions = ctx.sessions.lock();
        let session = sessions.get(&id).ok_or(TextInputError { session_id: id })?;
        // AskPanel handles arrows plus Enter rather than number shortcuts.
        session.write_input(&input);
    }
    if submit {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let sessions = ctx.sessions.lock();
        let session = sessions.get(&id).ok_or(TextInputError { session_id: id })?;
        session.write_input(b"\r");
    }
    ctx.bus.emit(EventEnvelope::new(
        id,
        "session.attention_cleared",
        json!({ "reason": "user_answered_via_api" }),
    ));
    Ok(())
}

#[derive(Deserialize)]
struct PlanResponseReq {
    #[serde(default)]
    plan_id: Option<String>,
    accept: bool,
}

async fn post_plan_response(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Json(req): Json<PlanResponseReq>,
) -> Result<StatusCode, ApiError> {
    let _ = req.plan_id;
    submit_plan_response(&ctx, id, req.accept)
        .map_err(|_| ApiError::NotFound(format!("session {id}")))?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn submit_plan_response(ctx: &Ctx, id: SessionId, accept: bool) -> Result<(), TextInputError> {
    // accept=true → '1'（接受计划）, accept=false → '2'（拒绝/继续规划）
    // codebuddy ExitPlanMode 后弹出的选择题，标准按键为数字 1/2
    let digit: u8 = if accept { b'1' } else { b'2' };
    let g = ctx.sessions.lock();
    let s = g.get(&id).ok_or(TextInputError { session_id: id })?;
    s.write_input(&[digit]);
    drop(g);
    ctx.bus.emit(EventEnvelope::new(
        id,
        "session.attention_cleared",
        json!({ "reason": "plan_responded_via_api" }),
    ));
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    BypassPermissions,
}

impl PermissionMode {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "default" => Some(Self::Default),
            "acceptEdits" | "accept-edits" => Some(Self::AcceptEdits),
            "plan" => Some(Self::Plan),
            "bypass" | "bypassPermissions" | "bypass-permissions" => Some(Self::BypassPermissions),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::BypassPermissions => "bypassPermissions",
        }
    }
}

fn detect_mode(screen: &str) -> Option<PermissionMode> {
    let lower = screen.to_lowercase();
    if lower.contains("plan mode on") {
        return Some(PermissionMode::Plan);
    }
    if lower.contains("accept edits") || lower.contains("auto-accept edits") {
        return Some(PermissionMode::AcceptEdits);
    }
    if lower.contains("bypass permissions") || lower.contains("dangerously skip permissions") {
        return Some(PermissionMode::BypassPermissions);
    }
    if lower.contains("shift+tab to") {
        return Some(PermissionMode::Default);
    }
    None
}

#[derive(Deserialize)]
struct ModeReq {
    mode: String,
}

#[derive(Serialize)]
struct ModeResp {
    mode: String,
    cycles: u32,
}

async fn post_mode(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Json(req): Json<ModeReq>,
) -> Result<Json<ModeResp>, ApiError> {
    PermissionMode::from_str(&req.mode)
        .ok_or_else(|| ApiError::BadRequest(format!("invalid mode: {}", req.mode)))?;
    let (mode, cycles) = set_session_permission_mode(&ctx, id, &req.mode)
        .await
        .map_err(ApiError::Internal)?;
    Ok(Json(ModeResp { mode, cycles }))
}

pub async fn set_session_permission_mode(
    ctx: &Ctx,
    id: SessionId,
    mode: &str,
) -> Result<(String, u32), String> {
    let target = PermissionMode::from_str(mode).ok_or_else(|| format!("invalid mode: {mode}"))?;
    const SHIFT_TAB: &[u8] = b"\x1b[Z";

    {
        let g = ctx.sessions.lock();
        let s = g
            .get(&id)
            .ok_or_else(|| format!("session {id} not found"))?;
        if detect_mode(&s.screen_text()) == Some(target) {
            return Ok((target.as_str().to_string(), 0));
        }
    }

    for cycle in 1..=5u32 {
        {
            let g = ctx.sessions.lock();
            let s = g
                .get(&id)
                .ok_or_else(|| format!("session {id} not found"))?;
            s.write_input(SHIFT_TAB);
        }
        tokio::time::sleep(Duration::from_millis(180)).await;
        let cur = {
            let g = ctx.sessions.lock();
            let s = g
                .get(&id)
                .ok_or_else(|| format!("session {id} not found"))?;
            detect_mode(&s.screen_text())
        };
        if cur == Some(target) {
            ctx.bus.emit(EventEnvelope::new(
                id,
                "session.mode_changed",
                json!({ "mode": target.as_str() }),
            ));
            return Ok((target.as_str().to_string(), cycle));
        }
    }

    Err(format!(
        "could not reach mode {} after 5 cycles; CLI bundle layout may have changed",
        target.as_str()
    ))
}

#[derive(Deserialize)]
struct ResizeReq {
    cols: i32,
    rows: i32,
}

async fn post_resize(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<SessionId>,
    Json(req): Json<ResizeReq>,
) -> Result<StatusCode, ApiError> {
    if req.cols <= 0 || req.rows <= 0 || req.cols > 10000 || req.rows > 10000 {
        return Err(ApiError::BadRequest(format!(
            "invalid size: {}x{}",
            req.cols, req.rows
        )));
    }
    let mut g = ctx.sessions.lock();
    let s = g
        .get_mut(&id)
        .ok_or_else(|| ApiError::NotFound(format!("session {id}")))?;
    s.resize(req.cols as u16, req.rows as u16);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ShellSpawnReq {
    cwd: String,
    cols: u16,
    rows: u16,
}

#[derive(Serialize)]
struct ShellDto {
    id: u32,
    cwd: String,
}

#[derive(Deserialize)]
struct ShellInputReq {
    bytes_b64: String,
}

async fn shell_spawn(
    Extension(ctx): Extension<Arc<Ctx>>,
    Json(req): Json<ShellSpawnReq>,
) -> Result<Json<ShellDto>, ApiError> {
    if req.cwd.trim().is_empty() {
        return Err(ApiError::BadRequest("cwd is required".into()));
    }
    let id = ctx.shells.alloc_id();
    let pty_system = native_pty_system();
    let size = PtySize {
        cols: req.cols.max(1),
        rows: req.rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(size)
        .map_err(|e| ApiError::Internal(format!("openpty: {e}")))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(FsPath::new(&req.cwd));
    if std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }
    if std::env::var_os("COLORTERM").is_none() {
        cmd.env("COLORTERM", "truecolor");
    }
    let has_locale = std::env::var_os("LC_ALL").is_some()
        || std::env::var_os("LANG").is_some()
        || std::env::var_os("LC_CTYPE").is_some();
    if !has_locale {
        cmd.env("LANG", "en_US.UTF-8");
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| ApiError::Internal(format!("spawn shell: {e}")))?;
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| ApiError::Internal(format!("clone shell reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| ApiError::Internal(format!("take shell writer: {e}")))?;
    let writer = Arc::new(Mutex::new(writer));
    let cwd = req.cwd;
    ctx.shells.shells.lock().insert(
        id,
        BridgeShell {
            writer,
            killer: Mutex::new(killer),
            master: pair.master,
            ring_buffer: VecDeque::with_capacity(SHELL_RING_BUFFER_CAPACITY),
            cwd: cwd.clone(),
        },
    );

    let shells = Arc::clone(&ctx.shells.shells);
    let bus = Arc::clone(&ctx.bus);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = &buf[..n];
                    let mut g = shells.lock();
                    if let Some(shell) = g.get_mut(&id) {
                        shell.push_bytes(data);
                    } else {
                        break;
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
                    bus.emit(EventEnvelope::new(
                        id as u64,
                        "shell.pty_bytes",
                        json!({ "bytes_b64": b64 }),
                    ));
                }
            }
        }
    });

    let shells_reaper = Arc::clone(&ctx.shells.shells);
    let bus_reaper = Arc::clone(&ctx.bus);
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        shells_reaper.lock().remove(&id);
        bus_reaper.emit(EventEnvelope::new(
            id as u64,
            "shell.exited",
            json!({ "exit_code": code }),
        ));
    });

    Ok(Json(ShellDto { id, cwd }))
}

async fn shell_input(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<u32>,
    Json(req): Json<ShellInputReq>,
) -> Result<StatusCode, ApiError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(req.bytes_b64.as_bytes())
        .map_err(|e| ApiError::BadRequest(format!("invalid base64: {e}")))?;
    let g = ctx.shells.shells.lock();
    let shell = g
        .get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("shell {id}")))?;
    let mut writer = shell.writer.lock();
    writer
        .write_all(&bytes)
        .map_err(|e| ApiError::Internal(format!("shell write: {e}")))?;
    writer.flush().ok();
    Ok(StatusCode::NO_CONTENT)
}

async fn shell_resize(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<u32>,
    Json(req): Json<ResizeReq>,
) -> Result<StatusCode, ApiError> {
    if req.cols <= 0 || req.rows <= 0 || req.cols > 10000 || req.rows > 10000 {
        return Err(ApiError::BadRequest(format!(
            "invalid size: {}x{}",
            req.cols, req.rows
        )));
    }
    let mut g = ctx.shells.shells.lock();
    let shell = g
        .get_mut(&id)
        .ok_or_else(|| ApiError::NotFound(format!("shell {id}")))?;
    shell
        .master
        .resize(PtySize {
            cols: req.cols as u16,
            rows: req.rows as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| ApiError::Internal(format!("shell resize: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn shell_kill(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<u32>,
) -> Result<StatusCode, ApiError> {
    let mut g = ctx.shells.shells.lock();
    if let Some(shell) = g.get_mut(&id) {
        let mut killer = shell.killer.lock();
        let _ = killer.kill();
    }
    g.remove(&id);
    Ok(StatusCode::NO_CONTENT)
}

async fn shell_snapshot(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<u32>,
) -> Result<Json<Value>, ApiError> {
    let g = ctx.shells.shells.lock();
    let shell = g
        .get(&id)
        .ok_or_else(|| ApiError::NotFound(format!("shell {id}")))?;
    let snapshot: Vec<u8> = shell.ring_buffer.iter().copied().collect();
    let b64 = base64::engine::general_purpose::STANDARD.encode(snapshot);
    Ok(Json(json!({ "bytes_b64": b64, "cwd": shell.cwd })))
}

#[derive(Serialize)]
struct BackendInfo {
    key: String,
    display_name: String,
    supports_cwd: bool,
    default_cwd: Option<String>,
    model_flag: Option<String>,
    /// 该 backend 是否对客户端可见。server 端在响应时会再过一遍 PATH:`is_enabled()`
    /// 且 `command` 实际可执行才会返回。所以这里始终为 `true`(过滤后才会进响应)。
    /// `#[serde(default)]` 让旧客户端反序列化时不缺字段。
    #[serde(default)]
    enabled: bool,
}

async fn list_backends(Extension(ctx): Extension<Arc<Ctx>>) -> Json<Value> {
    // 只返回 server 端 PATH 上**实际可执行**的 backend。
    // 背景:config.toml 里默认带一批预设 backend(codebuddy / claude / codex / ...),
    // 但远端机器不一定装了。`enabled` flag 只反映用户在 Settings 里的开关,不能用来
    // 判断"装没装"。本地 GUI 端靠 `backend_admin::detect_known_backends` 在首次启动时
    // 探测 PATH 并把结果写回 config.toml;远端 bridge 没有这个落盘流程,所以这里在
    // 响应时即时探测一次,行为与本地一致:装了的才显示。
    //
    // PATH 扫描是 stat 调用,backend 数量通常 <10,放 spawn_blocking 不阻塞 runtime。
    let backends_snapshot = ctx.config.backends.clone();
    let out: Vec<BackendInfo> = tokio::task::spawn_blocking(move || {
        let mut v: Vec<BackendInfo> = backends_snapshot
            .iter()
            .filter(|(_, cfg)| {
                cfg.is_enabled() && crate::backend_probe::which(&cfg.command).is_some()
            })
            .map(|(k, cfg)| BackendInfo {
                key: k.clone(),
                display_name: k.clone(),
                supports_cwd: true,
                default_cwd: None,
                model_flag: cfg.model_flag.clone(),
                enabled: true,
            })
            .collect();
        v.sort_by(|a, b| a.key.cmp(&b.key));
        v
    })
    .await
    .unwrap_or_default();
    Json(json!({ "backends": out }))
}

async fn list_backend_models(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(key): Path<String>,
) -> Result<Json<model_discovery::ModelDiscoveryResult>, ApiError> {
    let cfg = ctx
        .config
        .backends
        .get(&key)
        .ok_or_else(|| ApiError::NotFound(format!("backend {key}")))?;
    model_discovery::discover_models(&key, &cfg.command)
        .await
        .map(Json)
        .map_err(ApiError::BadRequest)
}

#[derive(Deserialize)]
struct SessionHistoryQuery {
    backend_key: String,
    cwd: String,
}

#[derive(Debug, Serialize)]
struct SessionSummary {
    session_id: String,
    title: Option<String>,
    model: Option<String>,
    total_tokens: Option<u64>,
    last_modified_secs: u64,
}

async fn list_sessions_history(
    Query(q): Query<SessionHistoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let cwd = PathBuf::from(&q.cwd);
    if !cwd.is_absolute() {
        return Err(ApiError::BadRequest("cwd must be absolute".into()));
    }
    let profile = kode_core::session::backend::profile_for_key(&q.backend_key)
        .ok_or_else(|| ApiError::BadRequest(format!("unsupported backend: {}", q.backend_key)))?;
    let mut sessions: Vec<SessionSummary> = profile
        .list_sessions(&cwd)
        .into_iter()
        .map(|s| SessionSummary {
            session_id: s.session_id,
            title: s.title,
            model: s.model,
            total_tokens: s.total_tokens,
            last_modified_secs: s.last_modified_secs,
        })
        .collect();
    sessions.sort_by(|a, b| b.last_modified_secs.cmp(&a.last_modified_secs));
    Ok(Json(json!({ "sessions": sessions })))
}

#[derive(Deserialize)]
struct FsListQuery {
    path: String,
    #[serde(default)]
    show_hidden: bool,
    /// `false`(默认,RemoteCwdPicker 用)→ 只返回目录;
    /// `true`(workspace 面板用)→ 返回文件 + 目录。
    #[serde(default)]
    files: bool,
}

#[derive(Serialize)]
struct FsEntry {
    name: String,
    is_dir: bool,
    /// 完整路径(前端 tree 用作 key + 展开 children)。RemoteCwdPicker 不读此字段。
    path: String,
    is_symlink: bool,
    /// 文件大小(目录为 None)。RemoteCwdPicker 不读此字段。
    size: Option<u64>,
    /// mtime(Unix 秒)。RemoteCwdPicker 不读此字段。
    modified_secs: Option<u64>,
}

async fn fs_list(Query(q): Query<FsListQuery>) -> Result<Json<Value>, ApiError> {
    let req_path = PathBuf::from(&q.path);
    if !req_path.is_absolute() {
        return Err(ApiError::BadRequest("path must be absolute".into()));
    }
    let canonical = match std::fs::canonicalize(&req_path) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::NotFound(format!("path not found: {}", q.path)));
        }
        Err(e) => return Err(ApiError::Internal(format!("canonicalize: {e}"))),
    };
    let meta =
        std::fs::metadata(&canonical).map_err(|e| ApiError::Internal(format!("stat: {e}")))?;
    if !meta.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "not a directory: {}",
            canonical.display()
        )));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&canonical)
        .map_err(|e| ApiError::Internal(format!("readdir: {e}")))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().to_string();
        // .git 过滤(对齐 workspace.rs::list_workspace_entries)
        if name == ".git" {
            continue;
        }
        if !q.show_hidden && name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let is_dir = file_type.is_dir();
        // files=false(默认)→ 跳过非目录,保 RemoteCwdPicker 的"只列目录"语义
        if !q.files && !is_dir {
            continue;
        }
        let metadata = entry.metadata().ok();
        let modified_secs = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let size = metadata.as_ref().filter(|_| !is_dir).map(|m| m.len());
        entries.push(FsEntry {
            name,
            is_dir,
            path: entry.path().to_string_lossy().into_owned(),
            is_symlink: file_type.is_symlink(),
            size,
            modified_secs,
        });
    }
    // 排序:is_dir 降序 + name 升序(对齐 workspace.rs)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(160);
    let parent = canonical.parent().map(|p| p.to_string_lossy().to_string());
    Ok(Json(json!({
        "path": canonical.to_string_lossy(),
        "parent": parent,
        "entries": entries,
    })))
}

// ===== Workspace inspection 端点(对齐 apps/gui/src-tauri/src/workspace.rs)=====
//
// 这些 struct 的字段名 / 类型 / serde 形态与 `workspace.rs` 的 pub struct 完全一致,
// 让 GUI 端 `endpoint_workspace_*` 命令能直接 `serde_json::from_value` 反序列化成
// workspace.rs 的同名类型。serde 默认 snake_case,两端一致。
//
// 不提到共享 crate:bridge 不应依赖 GUI 端 workspace.rs,kode-core 也不应承载
// workspace inspection 类型(那会让 core ↔ workspace 耦合)。
//
// 注:fs_list 返回的 `FsEntry` 已含 path/is_symlink/size/modified_secs 字段,
// 与 workspace.rs 的 `WorkspaceEntry` 对齐,所以不需要单独的 WsEntry。

#[derive(Debug, Clone, Serialize)]
struct WsGitChange {
    path: String,
    status: String,
    bucket: String,
}

#[derive(Debug, Clone, Serialize)]
struct WsGitBranchInfo {
    name: String,
    display_name: String,
    current: bool,
    remote: bool,
}

#[derive(Debug, Clone, Serialize)]
struct WsGitCommitInfo {
    hash: String,
    short_hash: String,
    author: String,
    timestamp_secs: u64,
    subject: String,
    parents: Vec<String>,
    decorations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
struct WsGitSummary {
    is_repo: bool,
    root: Option<String>,
    branch: Option<String>,
    short_head: Option<String>,
    staged: u32,
    modified: u32,
    untracked: u32,
    conflicts: u32,
    ahead: u32,
    behind: u32,
    changes: Vec<WsGitChange>,
    branches: Vec<WsGitBranchInfo>,
    commits: Vec<WsGitCommitInfo>,
}

#[derive(Debug, Clone, Serialize)]
struct WsFilePreview {
    path: String,
    name: String,
    kind: String,
    content: String,
    size: u64,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
struct WsGitDiffPreview {
    path: String,
    bucket: String,
    content: String,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
struct WsGitCommitFileChange {
    path: String,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
struct WsGitCommitDetail {
    commit: String,
    message: String,
    files: Vec<WsGitCommitFileChange>,
}

#[derive(Deserialize)]
struct FsPreviewQuery {
    path: String,
}

/// `GET /api/v1/fs/preview?path=<abs>` — 读文件内容(220KB 截断,二进制检测)。
/// 对齐 `workspace.rs::preview_file_sync`。
async fn fs_preview(Query(q): Query<FsPreviewQuery>) -> Result<Json<WsFilePreview>, ApiError> {
    const MAX_BYTES: usize = 220 * 1024;
    let path = std::path::Path::new(q.path.trim());
    if !path.is_absolute() {
        return Err(ApiError::BadRequest("path must be absolute".into()));
    }
    if path.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "expected a file, got directory: {}",
            path.display()
        )));
    }
    let metadata = std::fs::metadata(path)
        .map_err(|e| ApiError::NotFound(format!("stat {}: {e}", path.display())))?;
    let size = metadata.len();
    let bytes = std::fs::read(path)
        .map_err(|e| ApiError::Internal(format!("read {}: {e}", path.display())))?;
    let truncated = bytes.len() > MAX_BYTES;
    let sample = &bytes[..bytes.len().min(MAX_BYTES)];
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    // 二进制检测:\0 字节(对齐 workspace.rs:189)
    let (kind, content) = if sample.iter().any(|b| *b == 0) {
        ("binary".to_string(), String::new())
    } else {
        (
            "text".to_string(),
            String::from_utf8_lossy(sample).into_owned(),
        )
    };

    Ok(Json(WsFilePreview {
        path: path.to_string_lossy().into_owned(),
        name,
        kind,
        content,
        size,
        truncated,
    }))
}

#[derive(Deserialize)]
struct GitStatusQuery {
    cwd: String,
}

/// `GET /api/v1/git/status?cwd=<abs>` — git 仓库摘要(best-effort)。
/// git 不在 / 非 repo → `is_repo: false`,不崩。
async fn git_status(Query(q): Query<GitStatusQuery>) -> Result<Json<WsGitSummary>, ApiError> {
    let path = std::path::Path::new(q.cwd.trim());
    if !path.is_absolute() {
        return Err(ApiError::BadRequest("cwd must be absolute".into()));
    }
    Ok(Json(read_git_summary_best_effort(path)))
}

/// `GET /api/v1/git/diff?cwd=<abs>&path=<rel>&bucket=<staged|modified|untracked|conflict>`
/// 对齐 `workspace.rs::git_diff_sync`。
#[derive(Deserialize)]
struct GitDiffQuery {
    cwd: String,
    path: String,
    bucket: String,
}

async fn git_diff(Query(q): Query<GitDiffQuery>) -> Result<Json<WsGitDiffPreview>, ApiError> {
    const MAX_CHARS: usize = 180_000;
    let cwd = std::path::Path::new(q.cwd.trim());
    if !cwd.is_absolute() {
        return Err(ApiError::BadRequest("cwd must be absolute".into()));
    }
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| ApiError::BadRequest("not a Git repository".into()))?;
    let root_path = PathBuf::from(&root);
    let rel = q.path.trim();
    if rel.is_empty() || rel.starts_with('/') || rel.contains("..") {
        return Err(ApiError::BadRequest(
            "git path must be a repository-relative path".into(),
        ));
    }

    // 路径可能落在 submodule 内 —— superproject root 跑 diff 拿不到子模块内部改动。
    // 探测文件所在的实际 repo toplevel,若与 superproject root 不同则重路由到子模块。
    let (diff_root, diff_rel) = resolve_diff_target(&root_path, rel);

    let output = if q.bucket == "staged" {
        run_git_raw(
            &diff_root,
            &["--no-pager", "diff", "--cached", "--", &diff_rel],
        )?
    } else if q.bucket == "untracked" {
        let full = diff_root.join(&diff_rel);
        run_diff_no_index(&full)?
    } else {
        run_git_raw(&diff_root, &["--no-pager", "diff", "--", &diff_rel])?
    };

    let (content, truncated) = truncate_chars(output, MAX_CHARS);
    Ok(Json(WsGitDiffPreview {
        path: rel.to_string(),
        bucket: q.bucket.clone(),
        content,
        truncated,
    }))
}

/// `GET /api/v1/git/commit-diff?cwd=<abs>&commit=<sha>`
#[derive(Deserialize)]
struct GitCommitDiffQuery {
    cwd: String,
    commit: String,
}

async fn git_commit_diff(
    Query(q): Query<GitCommitDiffQuery>,
) -> Result<Json<WsGitDiffPreview>, ApiError> {
    const MAX_CHARS: usize = 180_000;
    let cwd = std::path::Path::new(q.cwd.trim());
    if !cwd.is_absolute() {
        return Err(ApiError::BadRequest("cwd must be absolute".into()));
    }
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| ApiError::BadRequest("not a Git repository".into()))?;
    let commit = q.commit.trim();
    if !is_valid_commit_hash(commit) {
        return Err(ApiError::BadRequest(
            "commit must be a 7-40 character hex SHA".into(),
        ));
    }
    let output = run_git_raw(
        std::path::Path::new(&root),
        &[
            "--no-pager",
            "show",
            "--format=fuller",
            "--stat",
            "--patch",
            "--no-ext-diff",
            "--find-renames",
            commit,
        ],
    )?;
    let (content, truncated) = truncate_chars(output, MAX_CHARS);
    Ok(Json(WsGitDiffPreview {
        path: commit.to_string(),
        bucket: "commit".into(),
        content,
        truncated,
    }))
}

async fn git_commit_detail(
    Query(q): Query<GitCommitDiffQuery>,
) -> Result<Json<WsGitCommitDetail>, ApiError> {
    let cwd = std::path::Path::new(q.cwd.trim());
    if !cwd.is_absolute() {
        return Err(ApiError::BadRequest("cwd must be absolute".into()));
    }
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| ApiError::BadRequest("not a Git repository".into()))?;
    let commit = q.commit.trim();
    if !is_valid_commit_hash(commit) {
        return Err(ApiError::BadRequest(
            "commit must be a 7-40 character hex SHA".into(),
        ));
    }
    let output = run_git_raw(
        std::path::Path::new(&root),
        &[
            "--no-pager",
            "show",
            "--format=%B%x1e",
            "--name-status",
            "--no-renames",
            commit,
        ],
    )?;
    Ok(Json(parse_commit_detail(commit, &output)))
}

#[derive(Deserialize)]
struct GitCommitFileDiffQuery {
    cwd: String,
    commit: String,
    path: String,
}

async fn git_commit_file_diff(
    Query(q): Query<GitCommitFileDiffQuery>,
) -> Result<Json<WsGitDiffPreview>, ApiError> {
    const MAX_CHARS: usize = 180_000;
    let cwd = std::path::Path::new(q.cwd.trim());
    if !cwd.is_absolute() {
        return Err(ApiError::BadRequest("cwd must be absolute".into()));
    }
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| ApiError::BadRequest("not a Git repository".into()))?;
    let commit = q.commit.trim();
    if !is_valid_commit_hash(commit) {
        return Err(ApiError::BadRequest(
            "commit must be a 7-40 character hex SHA".into(),
        ));
    }
    let rel = validate_git_rel_path(&q.path)?;
    let output = run_git_raw(
        std::path::Path::new(&root),
        &[
            "--no-pager",
            "show",
            "--format=",
            "--patch",
            "--no-ext-diff",
            "--find-renames",
            commit,
            "--",
            rel,
        ],
    )?;
    let (content, truncated) = truncate_chars(output, MAX_CHARS);
    Ok(Json(WsGitDiffPreview {
        path: rel.to_string(),
        bucket: "commit-file".into(),
        content,
        truncated,
    }))
}

// ===== bridge 端 git 辅助(对齐 workspace.rs:211-404,best-effort 降级)=====

fn read_git_summary_best_effort(path: &std::path::Path) -> WsGitSummary {
    // git 不在 → 直接返回 default(is_repo=false),不崩
    if run_git(path, &["--version"]).is_none() {
        return WsGitSummary::default();
    }
    let Some(root) = run_git(path, &["rev-parse", "--show-toplevel"]) else {
        return WsGitSummary::default();
    };
    let branch = run_git(path, &["branch", "--show-current"]).filter(|s| !s.is_empty());
    let short_head = run_git(path, &["rev-parse", "--short", "HEAD"]).filter(|s| !s.is_empty());
    let mut summary = WsGitSummary {
        is_repo: true,
        root: Some(root),
        branch,
        short_head,
        branches: read_git_branches(path),
        commits: read_git_commits(path),
        ..Default::default()
    };
    if let Some(status) = run_git(path, &["status", "--porcelain=v1", "--branch"]) {
        parse_git_status(&status, &mut summary, "");
    }
    // porcelain v1 把 submodule 折叠成单个 M 条目,内部文件不可见。
    // 逐个进 submodule 跑 status,前缀聚合进来 —— 对齐 workspace.rs 的 collect_submodule_changes。
    collect_submodule_changes(path, &mut summary);
    summary
}

fn read_git_branches(path: &std::path::Path) -> Vec<WsGitBranchInfo> {
    let Some(output) = run_git(
        path,
        &[
            "branch",
            "--all",
            "--format=%(refname)%x1f%(refname:short)%x1f%(HEAD)",
        ],
    ) else {
        return Vec::new();
    };
    parse_git_branches(&output)
}

fn parse_git_branches(output: &str) -> Vec<WsGitBranchInfo> {
    let mut branches = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in output.lines() {
        let mut parts = line.split('\x1f');
        let Some(refname) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(short) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if refname.starts_with("refs/remotes/") && refname.ends_with("/HEAD") {
            continue;
        }
        if !seen.insert(short.to_string()) {
            continue;
        }
        branches.push(WsGitBranchInfo {
            name: short.to_string(),
            display_name: short.to_string(),
            current: parts.next().map(str::trim) == Some("*"),
            remote: refname.starts_with("refs/remotes/"),
        });
    }
    branches
}

fn read_git_commits(path: &std::path::Path) -> Vec<WsGitCommitInfo> {
    let Some(output) = run_git(
        path,
        &[
            "log",
            "--all",
            "-n",
            "80",
            "--date=unix",
            "--decorate=full",
            "--format=%H%x1f%h%x1f%an%x1f%ct%x1f%s%x1f%P%x1f%D",
        ],
    ) else {
        return Vec::new();
    };
    parse_git_commits(&output)
}

fn parse_git_commits(output: &str) -> Vec<WsGitCommitInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(7, '\x1f');
            let hash = parts.next()?.trim();
            let short_hash = parts.next()?.trim();
            let author = parts.next()?.trim();
            let timestamp_secs = parts.next()?.trim().parse().ok()?;
            let subject = parts.next().unwrap_or_default().trim();
            let parents = parse_commit_parents(parts.next().unwrap_or_default());
            let decorations = parse_commit_decorations(parts.next().unwrap_or_default());
            Some(WsGitCommitInfo {
                hash: hash.to_string(),
                short_hash: short_hash.to_string(),
                author: author.to_string(),
                timestamp_secs,
                subject: subject.to_string(),
                parents,
                decorations,
            })
        })
        .collect()
}

fn parse_commit_parents(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_commit_decorations(raw: &str) -> Vec<String> {
    let mut labels = Vec::new();
    for part in raw.split(',') {
        let label = part
            .trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .trim();
        if label.is_empty() {
            continue;
        }
        if let Some(branch) = label.strip_prefix("HEAD -> ") {
            labels.push("HEAD".to_string());
            if let Some(cleaned) = clean_decoration_label(branch) {
                labels.push(cleaned);
            }
        } else if let Some(cleaned) = clean_decoration_label(label) {
            labels.push(cleaned);
        }
    }
    labels
}

fn clean_decoration_label(label: &str) -> Option<String> {
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    let cleaned = label
        .strip_prefix("refs/heads/")
        .or_else(|| label.strip_prefix("refs/remotes/"))
        .map(str::to_string)
        .or_else(|| {
            label
                .strip_prefix("tag: refs/tags/")
                .map(|tag| format!("tag: {tag}"))
        })
        .or_else(|| {
            label
                .strip_prefix("refs/tags/")
                .map(|tag| format!("tag: {tag}"))
        })
        .unwrap_or_else(|| label.to_string());
    Some(cleaned)
}

fn parse_commit_detail(commit: &str, output: &str) -> WsGitCommitDetail {
    let (message, files_raw) = output.split_once('\x1e').unwrap_or((output, ""));
    WsGitCommitDetail {
        commit: commit.to_string(),
        message: message.trim().to_string(),
        files: parse_commit_file_changes(files_raw),
    }
}

fn parse_commit_file_changes(raw: &str) -> Vec<WsGitCommitFileChange> {
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let mut parts = trimmed.split('\t');
            let status = parts.next()?.trim();
            let path = parts.next_back().or_else(|| parts.next())?.trim();
            if status.is_empty() || path.is_empty() {
                return None;
            }
            Some(WsGitCommitFileChange {
                path: path.to_string(),
                status: status.to_string(),
            })
        })
        .collect()
}

/// 枚举已 checkout 的 submodule,在每个子模块内部跑 `git status --porcelain`,
/// 把改动以 `<sub_path>/<inner>` 前缀聚合进 superproject 的 summary。
/// `git submodule status --recursive` 递归覆盖嵌套子模块。
fn collect_submodule_changes(root: &std::path::Path, summary: &mut WsGitSummary) {
    let Some(out) = run_git(root, &["submodule", "status", "--recursive"]) else {
        return;
    };
    for line in out.lines() {
        // 行格式: " <sha> <path> (<desc>)"  /  "-<sha> <path>"(未初始化,跳过)
        if line.starts_with('-') {
            continue;
        }
        let trimmed = line.trim_start();
        let mut parts = trimmed.split_whitespace();
        let _sha = parts.next();
        let Some(sub_path) = parts.next() else {
            continue;
        };
        let sub_abs = root.join(sub_path);
        if !sub_abs.is_dir() {
            continue;
        }
        if let Some(sub_status) = run_git(&sub_abs, &["status", "--porcelain=v1", "--branch"]) {
            parse_git_status(&sub_status, summary, &format!("{sub_path}/"));
        }
    }
}

fn parse_git_status(status: &str, summary: &mut WsGitSummary, prefix: &str) {
    for line in status.lines() {
        if let Some(branch_line) = line.strip_prefix("## ") {
            parse_git_ahead_behind(branch_line, summary);
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let xy = &line[..2];
        let raw_path = line[3..].trim();
        let path = raw_path
            .rsplit_once(" -> ")
            .map(|(_, to)| to)
            .unwrap_or(raw_path)
            .to_string();
        // submodule 聚合时,prefix = "<sub_path>/" —— 把子模块内部路径前缀成
        // superproject 视角的完整路径,前端点击时才能拿对路径去 diff。
        let path = if prefix.is_empty() {
            path
        } else {
            format!("{prefix}{path}")
        };

        if xy == "??" {
            summary.untracked += 1;
            summary.changes.push(WsGitChange {
                path,
                status: "untracked".into(),
                bucket: "untracked".into(),
            });
            continue;
        }

        let mut chars = xy.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        if is_conflict(x, y) {
            summary.conflicts += 1;
            summary.changes.push(WsGitChange {
                path,
                status: xy.trim().into(),
                bucket: "conflict".into(),
            });
            continue;
        }
        if x != ' ' {
            summary.staged += 1;
            summary.changes.push(WsGitChange {
                path: path.clone(),
                status: git_status_label(x),
                bucket: "staged".into(),
            });
        }
        if y != ' ' {
            summary.modified += 1;
            summary.changes.push(WsGitChange {
                path,
                status: git_status_label(y),
                bucket: "modified".into(),
            });
        }
    }
}

fn is_conflict(x: char, y: char) -> bool {
    (matches!(x, 'U' | 'A' | 'D') && y == 'U')
        || x == 'U'
        || (matches!(y, 'U' | 'A' | 'D') && x == 'U')
}

fn git_status_label(c: char) -> String {
    match c {
        'A' => "added",
        'D' => "deleted",
        'M' => "modified",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type changed",
        _ => "changed",
    }
    .into()
}

fn parse_git_ahead_behind(branch_line: &str, summary: &mut WsGitSummary) {
    let Some(start) = branch_line.find('[') else {
        return;
    };
    let Some(end) = branch_line[start + 1..].find(']') else {
        return;
    };
    let detail = &branch_line[start + 1..start + 1 + end];
    for part in detail.split(',').map(str::trim) {
        if let Some(n) = part.strip_prefix("ahead ") {
            summary.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            summary.behind = n.parse().unwrap_or(0);
        }
    }
}

/// 判断 `rel` 是否落在某个 submodule 内。若是,返回 `(submodule_root, 子模块内相对路径)`;
/// 否则返回 `(root, rel)` 不变。做法:从文件父目录向上找第一个存在的目录,跑
/// `git rev-parse --show-toplevel` —— 子模块内的文件解析出的 toplevel 会不同于
/// superproject root。文件可能已删除,所以向上 walk 到第一个存在的目录再探测。
fn resolve_diff_target(root: &std::path::Path, rel: &str) -> (PathBuf, String) {
    let full = root.join(rel);
    let mut probe = full.parent();
    while let Some(p) = probe {
        if p.is_dir() {
            if let Some(sub_root) = run_git(p, &["rev-parse", "--show-toplevel"]) {
                let sub_root_path = PathBuf::from(&sub_root);
                if sub_root_path != root {
                    if let Ok(inner) = full.strip_prefix(&sub_root_path) {
                        return (sub_root_path, inner.to_string_lossy().into_owned());
                    }
                }
            }
            break;
        }
        probe = p.parent();
    }
    (root.to_path_buf(), rel.to_string())
}

/// shell-out `git -C <path> <args>`,成功返回 trimmed stdout。失败返 None。
fn run_git(path: &std::path::Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_raw(path: &std::path::Path, args: &[&str]) -> Result<String, ApiError> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| ApiError::Internal(format!("git failed: {e}")))?;
    if !output.status.success() {
        return Err(ApiError::Internal(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run_diff_no_index(path: &std::path::Path) -> Result<String, ApiError> {
    let output = std::process::Command::new("git")
        .args(["--no-pager", "diff", "--no-index", "--"])
        .arg("/dev/null")
        .arg(path)
        .output()
        .map_err(|e| ApiError::Internal(format!("git diff failed: {e}")))?;
    // git diff --no-index 对有差异的输入返 exit code 1,这是正常的
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(ApiError::Internal(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn truncate_chars(mut content: String, max_chars: usize) -> (String, bool) {
    if content.chars().count() <= max_chars {
        return (content, false);
    }
    let mut end = 0;
    for (idx, _) in content.char_indices().take(max_chars) {
        end = idx;
    }
    content.truncate(end);
    content.push_str("\n\n... truncated ...\n");
    (content, true)
}

fn validate_git_rel_path(path: &str) -> Result<&str, ApiError> {
    let rel = path.trim();
    if rel.is_empty() || rel.starts_with('/') || rel.contains("..") {
        return Err(ApiError::BadRequest(
            "git path must be a repository-relative path".into(),
        ));
    }
    Ok(rel)
}

fn is_valid_commit_hash(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn ws_upgrade(Extension(ctx): Extension<Arc<Ctx>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| ws_session(ctx, socket))
}

async fn ws_session(ctx: Arc<Ctx>, mut socket: WebSocket) {
    let active: Vec<SessionId> = ctx.sessions.lock().keys().copied().collect();
    let hello = EventEnvelope::new(
        0,
        "connection.hello",
        json!({
            "server_kind": "rust-bridge",
            "server_version": env!("CARGO_PKG_VERSION"),
            "active_sessions": active,
            "protocol_features": [
                "resize",
                "backends",
                "fs.list",
                "fs.preview",
                "git.status",
                "git.diff",
                "sessions.history",
                "pty_bytes",
                "memory"
            ],
        }),
    );
    if !ws_send(&mut socket, &hello).await {
        return;
    }
    let mut rx = ctx.bus.subscribe();
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(env) => {
                    if !ws_send(&mut socket, &env).await {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Ping(p))) => { let _ = socket.send(Message::Pong(p)).await; }
                Some(Ok(Message::Text(t))) if is_protocol_ping(&t) => {
                    let _ = socket
                        .send(Message::Text(json!({ "type": "pong" }).to_string()))
                        .await;
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

fn is_protocol_ping(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "ping"))
        .unwrap_or(false)
}

async fn ws_send(socket: &mut WebSocket, env: &EventEnvelope) -> bool {
    match serde_json::to_string(env) {
        Ok(s) => socket.send(Message::Text(s)).await.is_ok(),
        Err(_) => false,
    }
}

#[derive(Clone, Serialize)]
struct PendingDto {
    id: String,
    author: String,
    session: Option<String>,
    scope: String,
    created: String,
    confidence: f32,
    tags: Vec<String>,
    kind: String,
    subsystem: Option<String>,
    supersedes: Option<String>,
    body: String,
    rationale: Option<String>,
    author_energy: f32,
}

async fn memory_list_pending(Extension(ctx): Extension<Arc<Ctx>>) -> Result<Json<Value>, ApiError> {
    let mem = ctx
        .memory
        .as_ref()
        .ok_or_else(|| ApiError::Internal("memory vault not available".into()))?;
    let pending = mem
        .store
        .lock()
        .await
        .list_pending()
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let mut budget = mem.budget.lock().await;
    let out: Vec<_> = pending
        .into_iter()
        .map(|p| {
            let energy = budget.current_energy(&p.meta.author);
            PendingDto {
                id: p.meta.id,
                author: p.meta.author,
                session: p.meta.session,
                scope: p.meta.scope,
                created: p.meta.created,
                confidence: p.meta.confidence,
                tags: p.meta.tags,
                kind: p.meta.kind.as_str().to_string(),
                subsystem: p.meta.subsystem,
                supersedes: p.meta.supersedes,
                body: p.body,
                rationale: p.rationale,
                author_energy: energy,
            }
        })
        .collect();
    let items = out.clone();
    Ok(Json(json!({ "pending": out, "items": items })))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum VerdictDto {
    Approve,
    Reject {
        reason: String,
    },
    Blacklist {
        reason: String,
    },
    EditThenApprove {
        body: Option<String>,
        tags: Option<Vec<String>>,
        scope: Option<String>,
        confidence: Option<f32>,
        #[serde(default)]
        title: Option<String>,
    },
}

impl VerdictDto {
    fn into_verdict(self) -> anyhow::Result<Verdict> {
        Ok(match self {
            VerdictDto::Approve => Verdict::Approve,
            VerdictDto::Reject { reason } => Verdict::Reject { reason },
            VerdictDto::Blacklist { reason } => Verdict::Blacklist { reason },
            VerdictDto::EditThenApprove {
                body,
                tags,
                scope,
                confidence,
                title,
            } => Verdict::EditThenApprove {
                body,
                tags,
                scope: scope.map(|s| kode_memory::Scope::parse(&s)).transpose()?,
                confidence,
                related: None,
                contradicts: None,
                title,
            },
        })
    }
}

#[derive(Deserialize)]
struct RemoteReviewReq {
    verdict: VerdictDto,
}

async fn memory_review(
    Extension(ctx): Extension<Arc<Ctx>>,
    Path(id): Path<String>,
    Json(req): Json<RemoteReviewReq>,
) -> Result<Json<Value>, ApiError> {
    let mem = ctx
        .memory
        .as_ref()
        .ok_or_else(|| ApiError::Internal("memory vault not available".into()))?;
    let verdict = req
        .verdict
        .into_verdict()
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;
    let (outcome, author) = {
        let mut store = mem.store.lock().await;
        let p = store
            .read_pending(&id)
            .map_err(|e| ApiError::NotFound(e.to_string()))?;
        let author = p.meta.author.clone();
        let outcome = store
            .review(&id, verdict)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        (outcome, author)
    };
    let energy = {
        let mut budget = mem.budget.lock().await;
        match outcome {
            ReviewOutcome::Approved => {
                let _ = budget.add(&author, REWARD_APPROVE);
            }
            ReviewOutcome::Rejected => {
                let _ = budget.penalize(&author, PENALTY_REJECT);
            }
            ReviewOutcome::Blacklisted => {
                let _ = budget.penalize(&author, PENALTY_BLACKLIST);
            }
        }
        budget.current_energy(&author)
    };
    let remaining = mem
        .store
        .lock()
        .await
        .count_pending()
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    if matches!(outcome, ReviewOutcome::Approved) {
        let root = mem.root.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            if git_sync::is_enabled(&root) {
                let _ = git_sync::commit_and_push(&root, &format!("kode-memory: approve {id2}"));
            }
        });
    }
    Ok(Json(json!({
        "outcome": match outcome {
            ReviewOutcome::Approved => "approved",
            ReviewOutcome::Rejected => "rejected",
            ReviewOutcome::Blacklisted => "blacklisted",
        },
        "author_energy": energy,
        "remaining_pending": remaining,
    })))
}

#[derive(Deserialize)]
struct MemorySearchQuery {
    q: String,
    scope: Option<String>,
    top_k: Option<usize>,
}

async fn memory_search(
    Extension(ctx): Extension<Arc<Ctx>>,
    Query(q): Query<MemorySearchQuery>,
) -> Result<Json<Value>, ApiError> {
    let mem = ctx
        .memory
        .as_ref()
        .ok_or_else(|| ApiError::Internal("memory vault not available".into()))?;
    let store = mem.store.lock().await;
    let hits = store
        .search_with_opts(&SearchOpts {
            query: &q.q,
            top_k: q.top_k.unwrap_or(20).max(1),
            scope: q.scope.as_deref(),
            kinds: vec![],
            subsystem: None,
            include_deprecated: false,
            current_path: None,
        })
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let items = hits.clone();
    Ok(Json(json!({ "hits": hits, "items": items })))
}

#[derive(Deserialize)]
struct MemoryRecentQuery {
    scope: Option<String>,
    /// 回看窗口(小时);默认 30 天。
    since_hours: Option<u64>,
    /// 返回上限;默认 20。
    limit: Option<usize>,
}

/// 空 query 的「最近 fact」列表 —— 给 Browse 面板远端来源默认视图用。
/// 复用 store::list_recent(按 created 倒序),输出 hit 形态与 /search 一致。
async fn memory_recent(
    Extension(ctx): Extension<Arc<Ctx>>,
    Query(q): Query<MemoryRecentQuery>,
) -> Result<Json<Value>, ApiError> {
    let mem = ctx
        .memory
        .as_ref()
        .ok_or_else(|| ApiError::Internal("memory vault not available".into()))?;
    let store = mem.store.lock().await;
    let since = q.since_hours.unwrap_or(24 * 30);
    let lim = q.limit.unwrap_or(20).max(1);
    let hits: Vec<_> = store
        .list_recent(q.scope.as_deref(), since)
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .into_iter()
        .take(lim)
        .collect();
    let items = hits.clone();
    Ok(Json(json!({ "hits": hits, "items": items })))
}

pub mod model_discovery;
#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
