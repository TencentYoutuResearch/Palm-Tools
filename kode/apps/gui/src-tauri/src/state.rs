//! AppState — 后端会话状态。
//!
//! 持有所有活跃 Session,管理 CoreEvent 路由(PtyBytes 走 channel,
//! 其余走 emit),以及每 session 的字节合并 buffer。
//!
//! Phase 9.1:CoreEvent 路由额外 fan-out 到 `BridgeBus`(供远程 WS / REST 用)。
//! 共享数据封装在 `Arc<BridgeCtx>`,既给 Tauri 命令也给 axum router 用,
//! 这样集成测试可以脱离 Tauri runtime 直接构造 ctx 跑 router。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use kode_core::{
    config::Config, session::Session, CoreEvent, EndpointId, SessionId, SessionTransport,
};
use parking_lot::Mutex;
use tauri::{ipc::Channel, AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::bridge::ctx::BridgeCtx;
use crate::bridge::events::{BridgeBus, EventEnvelope};
use crate::bridge::prompt_detect::{self, PermissionMode, PromptState};
use crate::persistence;
use crate::transport::{LocalTransport, RemoteTransport};

/// Coalesce 窗口:每 8ms tick 一次,把 PTY 字节合并成大块发出去
pub const COALESCE_TICK_MS: u64 = 8;

/// 一个 session 的字节累积 buffer + 订阅 channel
pub struct SessionByteBuffer {
    /// 待发出的字节
    pub pending: Vec<u8>,
    /// 前端订阅的 channel(如有,channel 在 subscribe_session_bytes 命令里设置)
    pub channel: Option<Channel<Vec<u8>>>,
    /// 当前订阅的唯一 id。组件销毁时只允许取消自己创建的订阅,避免旧组件的
    /// 异步 unsubscribe 晚到一步,把刚挂载的新 Terminal channel 清掉。
    pub subscriber_id: Option<String>,
    /// 上次发送时末尾截断的 UTF-8 字节(防御纵深:确保 xterm.js 不收到不完整序列)
    pub utf8_remnant: Vec<u8>,
}

impl SessionByteBuffer {
    pub fn new() -> Self {
        Self {
            pending: Vec::with_capacity(16 * 1024),
            channel: None,
            subscriber_id: None,
            utf8_remnant: Vec::with_capacity(8),
        }
    }

    /// 首次订阅时取走 spawn 至今积累的原始 PTY 字节。
    ///
    /// 不能在这里改用 vt100 screen snapshot:快照只包含已经落到 cell 上的状态,
    /// 如果 PTY chunk 恰好截在半条 ANSI/OSC 序列中,parser 内部的中间状态无法被
    /// `contents_formatted()` 序列化,后续半条序列就会失去前缀。直接回放原始字节
    /// 能完整保留颜色、样式、光标和 startup scrollback。
    pub fn take_initial_bytes(&mut self) -> Vec<u8> {
        if !self.utf8_remnant.is_empty() {
            let mut merged = std::mem::take(&mut self.utf8_remnant);
            merged.append(&mut self.pending);
            self.pending = merged;
        }

        let (complete, remnant) = kode_core::session::split_at_complete_utf8(&self.pending);
        let initial = complete.to_vec();
        self.utf8_remnant = remnant;
        self.pending.clear();
        initial
    }

    /// 只取消调用方自己创建的订阅。返回是否真的清掉了当前 channel。
    pub fn unsubscribe_if_current(&mut self, subscription_id: &str) -> bool {
        if self.subscriber_id.as_deref() != Some(subscription_id) {
            return false;
        }
        self.channel = None;
        self.subscriber_id = None;
        true
    }
}

pub struct AppState {
    pub ctx: Arc<BridgeCtx>,
    /// Shared protocol ctx used by the HTTP/WS bridge server. It shares the
    /// same sessions/core_tx/bus/token with `ctx`, but lives in the pure
    /// `kode-bridge` crate so the remote headless binary and GUI bridge use
    /// the same router implementation.
    pub protocol_ctx: Arc<kode_bridge::Ctx>,
    /// debounced 持久化写入(GUI 独占,不需要进 ctx)
    pub persist: Arc<crate::persistence::PersistWriter>,
    /// Phase 11.2:endpoint → transport 映射。
    ///
    /// 启动时只注册 `EndpointId::Local` → `LocalTransport`;Phase 11.3 之后用户加远端
    /// endpoint 时,对应 `EndpointId::Remote { id }` 的 RemoteTransport 会被插入这里。
    ///
    /// 用 `parking_lot::Mutex` 而不是 `RwLock`:写入只在配 endpoint 时,读路径多
    /// 但每次只是 Arc::clone,用 Mutex 拿锁微秒级,比 RwLock 简单可靠。
    pub transports: Arc<Mutex<HashMap<EndpointId, Arc<dyn SessionTransport>>>>,
    /// Phase 11.4 远端 transport 的具类型 map,供 `endpoint_workspace_*` 命令
    /// 调 `RemoteTransport::rest_get`(复用长连接 SSH 隧道)。与 `transports` 同步
    /// 维护:`register_transport` 同时插,`endpoint_remove` 同时删。key 是 endpoint id。
    pub remote_transports: Arc<Mutex<HashMap<String, Arc<RemoteTransport>>>>,
    /// Hook Relay UDS socket 路径,用于注入到 codebuddy/claude settings.json 的 hook command 中。
    /// None = HookRelay 未启用(fallback 到纯 PTY scan loop)。
    pub hook_relay_socket: Option<Arc<std::path::PathBuf>>,
    /// One managed `specops serve` child per canonical workspace.
    pub specops: Arc<crate::specops::SpecOpsManager>,
}

impl AppState {
    pub fn new(app: AppHandle, hook_relay_socket: Option<std::path::PathBuf>) -> Self {
        let persisted = persistence::load();
        // config.toml:用户在 GUI 设过自定义路径 → 从那里加载;否则走默认。
        let config_path_override = persisted
            .config_path
            .as_deref()
            .map(std::path::PathBuf::from);
        let config = match config_path_override.as_deref() {
            Some(p) => Config::load_from(p),
            None => Config::load(),
        };
        let session_cwd_override = persisted
            .session_cwd
            .as_deref()
            .map(std::path::PathBuf::from);

        let (core_tx, core_rx) = mpsc::unbounded_channel::<CoreEvent>();
        let byte_buffers = Arc::new(Mutex::new(HashMap::new()));
        let sessions: Arc<Mutex<HashMap<SessionId, Session>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let bus = Arc::new(BridgeBus::new());
        // bridge_token:复用 persisted 的;没有就生成并补写
        let bridge_token = match persisted.bridge_token.as_deref() {
            Some(t) if !t.is_empty() => Arc::new(t.to_string()),
            _ => Arc::new(persistence::load_or_init_bridge_token()),
        };

        // 在构造 BridgeCtx 前打开 memory vault，让 bridge memory 路由可用。
        // lib.rs setup 钩子里还会再调一次 try_open()，两个实例指向同一 vault 目录，
        // SQLite WAL 模式支持并发读写，行为与 MCP server / CLI 并发访问一致。
        let memory_handle = crate::memory::try_open();

        let backend_configs = Arc::new(parking_lot::RwLock::new(config.backends.clone()));
        let ctx = Arc::new(BridgeCtx {
            config,
            backend_configs,
            sessions: Arc::clone(&sessions),
            byte_buffers: Arc::clone(&byte_buffers),
            core_tx,
            next_id: Arc::new(Mutex::new(1)),
            bus: Arc::clone(&bus),
            token: bridge_token,
            listen_addr: Arc::new(Mutex::new(None)),
            prompt_states: Arc::new(Mutex::new(HashMap::new())),
            session_cwd_override: Arc::new(Mutex::new(session_cwd_override)),
            config_path: Arc::new(Mutex::new(config_path_override)),
            memory: memory_handle,
        });
        let protocol_ctx = Arc::new(kode_bridge::Ctx {
            config: ctx.config.clone(),
            sessions: Arc::clone(&ctx.sessions),
            core_tx: ctx.core_tx.clone(),
            next_id: Arc::clone(&ctx.next_id),
            bus: Arc::clone(&ctx.bus),
            token: Arc::clone(&ctx.token),
            shells: Arc::new(kode_bridge::ShellManager::new()),
            memory: kode_bridge::MemoryHandle::open(),
            listen_addr: Arc::clone(&ctx.listen_addr),
            hook_relay_socket: hook_relay_socket.clone(),
        });

        // 后台任务:消费 CoreEvent,字节同时 feed 进 vt100 parser、写入 send buffer、推到 bus
        spawn_event_router(
            Some(app.clone()),
            core_rx,
            Arc::clone(&byte_buffers),
            Arc::clone(&sessions),
            Arc::clone(&bus),
            Arc::clone(&ctx.prompt_states),
        );
        // 后台任务:8ms tick 把 buffer 一次性 send 出去
        spawn_coalesce_loop(Arc::clone(&byte_buffers));
        // 后台任务:每 200ms 扫描每 session 的 vt100 屏幕,识别 PTY-prompt
        spawn_prompt_scan_loop(
            Arc::clone(&sessions),
            Arc::clone(&bus),
            Arc::clone(&ctx.prompt_states),
        );
        // 后台任务:订阅 bus,把"需要用户操作"的事件 (ask_user_question / plan_proposed)
        // 转发到桌面 webview 触发 sidebar tab 动效。
        spawn_attention_forwarder(
            app,
            Arc::clone(&bus),
            Arc::clone(&ctx.prompt_states),
            Arc::clone(&sessions),
        );

        // Phase 11.2:注册本地 transport。
        // 远端 transport 在启动时从持久化恢复(下面 restore_persisted_endpoints),
        // 用户运行时再加 / 删通过 `endpoints` 模块的 Tauri 命令。
        // hook_sock 传给 LocalTransport,spawn 子进程时注入 KODE_HOOK_SOCK env。
        let hook_sock = hook_relay_socket
            .as_deref()
            .map(|p| p.to_string_lossy().into_owned());

        let mut transports: HashMap<EndpointId, Arc<dyn SessionTransport>> = HashMap::new();
        transports.insert(
            EndpointId::Local,
            Arc::new(LocalTransport::new(Arc::clone(&ctx), hook_sock)) as Arc<dyn SessionTransport>,
        );

        let app_state = Self {
            ctx,
            protocol_ctx,
            persist: Arc::new(crate::persistence::PersistWriter::new()),
            transports: Arc::new(Mutex::new(transports)),
            remote_transports: Arc::new(Mutex::new(HashMap::new())),
            hook_relay_socket: hook_relay_socket.map(Arc::new),
            specops: Arc::new(crate::specops::SpecOpsManager::default()),
        };

        // Phase 11.4:启动时恢复持久化的远端 endpoints。**不阻塞启动** —
        // RemoteTransport::new 不做网络 IO,WS 后台 task spawn 后异步重连。
        // 启动期间网络没通也无所谓,后台 task 自己会重试到通为止。
        crate::endpoints::restore_persisted_endpoints(&app_state, &persisted);

        app_state
    }
}

#[cfg(test)]
pub(crate) fn build_test_ctx(config: Config, token: String) -> Arc<BridgeCtx> {
    let (core_tx, core_rx) = mpsc::unbounded_channel::<CoreEvent>();
    let byte_buffers = Arc::new(Mutex::new(HashMap::new()));
    let sessions: Arc<Mutex<HashMap<SessionId, Session>>> = Arc::new(Mutex::new(HashMap::new()));
    let bus = Arc::new(BridgeBus::new());
    let prompt_states = Arc::new(Mutex::new(HashMap::new()));

    let backend_configs = Arc::new(parking_lot::RwLock::new(config.backends.clone()));
    let ctx = Arc::new(BridgeCtx {
        config,
        backend_configs,
        sessions: Arc::clone(&sessions),
        byte_buffers: Arc::clone(&byte_buffers),
        core_tx,
        next_id: Arc::new(Mutex::new(1)),
        bus: Arc::clone(&bus),
        token: Arc::new(token),
        listen_addr: Arc::new(Mutex::new(None)),
        prompt_states: Arc::clone(&prompt_states),
        session_cwd_override: Arc::new(Mutex::new(None)),
        config_path: Arc::new(Mutex::new(None)),
        memory: None,
    });

    spawn_event_router(None, core_rx, byte_buffers, sessions, bus, prompt_states);
    ctx
}

fn spawn_event_router(
    app: Option<AppHandle>,
    mut rx: mpsc::UnboundedReceiver<CoreEvent>,
    byte_buffers: Arc<Mutex<HashMap<SessionId, SessionByteBuffer>>>,
    sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
    bus: Arc<BridgeBus>,
    prompt_states: Arc<Mutex<HashMap<SessionId, PromptState>>>,
) {
    let has_app = app.is_some();
    let task = async move {
        let mut pty_session_scan: HashMap<SessionId, String> = HashMap::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                CoreEvent::PtyBytes { id, bytes } => {
                    {
                        let mut sg = sessions.lock();
                        if let Some(s) = sg.get_mut(&id) {
                            s.feed(&bytes, false);
                        }
                    }
                    if let Some(session_uuid) =
                        scan_pty_change_session(&mut pty_session_scan, id, &bytes)
                    {
                        apply_session_uuid_retarget_from_pty(
                            id,
                            &session_uuid,
                            &sessions,
                            &bus,
                            app.as_ref(),
                        );
                    }
                    // 收到新字节 = 用户/子进程在交互;清掉 prompt 去重状态,
                    // 同 prompt 再次稳定时(用户没回应又出现)可以再 emit 一次。
                    {
                        let mut g = prompt_states.lock();
                        if let Some(st) = g.get_mut(&id) {
                            st.clear();
                        }
                    }
                    {
                        let mut g = byte_buffers.lock();
                        let buf = g.entry(id).or_insert_with(SessionByteBuffer::new);
                        buf.pending.extend_from_slice(&bytes);
                    }
                    // 11.1.4 协议补丁:同时把字节流推 BridgeBus 当 `pty_bytes` 事件,
                    // 远端 WS 客户端(Phase 11 RemoteTransport / 调试用 wscat)能拿到。
                    // 本地 GUI 已通过上面 byte_buffers + Channel 直送,不依赖此事件。
                    // History 层会在 push 时跳过 pty_bytes(events.rs::History::push),
                    // 不持久化到 ring 也不进 store。
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    bus.emit(EventEnvelope::new(
                        id,
                        "pty_bytes",
                        serde_json::json!({ "bytes_b64": b64 }),
                    ));
                }
                CoreEvent::PtyExited { id, code } => {
                    if let Some(a) = &app {
                        let _ = a.emit(
                            "session-exited",
                            serde_json::json!({ "id": id, "code": code }),
                        );
                    }
                    bus.emit(EventEnvelope::new(
                        id,
                        "session.exited",
                        serde_json::json!({ "exit_code": code }),
                    ));
                }
                CoreEvent::JsonlMeta {
                    id,
                    model,
                    title,
                    session_uuid,
                    tokens_reset,
                    tokens,
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                    cost_usd,
                    context_pct,
                } => {
                    let semantic_retarget = {
                        let mut g = sessions.lock();
                        match g.get_mut(&id) {
                            Some(s) => {
                                let binding_changed = session_uuid
                                    .as_ref()
                                    .is_some_and(|sid| s.session_id.as_deref() != Some(sid));
                                if let Some(m) = model.as_ref() {
                                    s.state.model = m.clone();
                                }
                                if let Some(t) = title.as_ref() {
                                    if !s.state.title_pinned {
                                        s.state.title = t.clone();
                                    }
                                }
                                if tokens_reset || binding_changed {
                                    s.state.tokens = None;
                                    s.state.tokens_input = None;
                                    s.state.tokens_output = None;
                                    s.state.tokens_cached = None;
                                    s.state.cost_usd = None;
                                }
                                if binding_changed && title.is_none() && !s.state.title_pinned {
                                    s.state.title = format!("tab · {}", s.backend_key);
                                }
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
                                if let Some(c) = cost_usd {
                                    s.state.cost_usd = Some(c);
                                }

                                if let Some(sid) = session_uuid.as_ref() {
                                    let changed = binding_changed;
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
                                }
                            }
                            None => None,
                        }
                    };
                    if let Some((backend, cwd, sid)) = semantic_retarget {
                        kode_bridge::semantic::spawn(id, backend, cwd, sid, Arc::clone(&bus));
                    }
                    let payload = serde_json::json!({
                        "id": id,
                        "model": model,
                        "title": title,
                        "session_id": session_uuid,
                        "tokens_reset": tokens_reset,
                        "tokens": tokens,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "cached_tokens": cached_tokens,
                        "cost_usd": cost_usd,
                        "context_pct": context_pct,
                    });
                    if let Some(a) = &app {
                        let _ = a.emit("session-meta", payload.clone());
                    }
                    let mut bus_payload = payload;
                    bus_payload.as_object_mut().map(|o| o.remove("id"));
                    bus.emit(EventEnvelope::new(id, "meta", bus_payload));
                }
                CoreEvent::BusEvent {
                    id,
                    event_type,
                    payload,
                } => {
                    bus.emit(EventEnvelope::new(id, event_type, payload));
                }
                CoreEvent::TurnHold { id, active } => {
                    if let Some(s) = sessions.lock().get_mut(&id) {
                        if active {
                            s.mark_turn_start();
                        } else {
                            s.mark_turn_end();
                        }
                    }
                }
            }
        }
    };
    if has_app {
        tauri::async_runtime::spawn(task);
    } else {
        tokio::spawn(task);
    }
}

fn scan_pty_change_session(
    buffers: &mut HashMap<SessionId, String>,
    id: SessionId,
    bytes: &[u8],
) -> Option<String> {
    let buf = buffers.entry(id).or_default();
    append_printable_pty_text(buf, bytes);
    let found = extract_change_session_uuid_from_text(buf);
    if found.is_some() {
        buf.clear();
    }
    found
}

fn append_printable_pty_text(buf: &mut String, bytes: &[u8]) {
    let chunk = String::from_utf8_lossy(bytes);
    let mut in_escape = false;
    for ch in chunk.chars() {
        if in_escape {
            if ('@'..='~').contains(&ch) {
                in_escape = false;
            }
            continue;
        }
        if ch == '\x1b' {
            in_escape = true;
            continue;
        }
        match ch {
            '\u{0008}' => {
                buf.pop();
            }
            '\r' => buf.push('\n'),
            '\n' | '\t' => buf.push(ch),
            c if !c.is_control() => buf.push(c),
            _ => {}
        }
    }

    const MAX_SCAN_CHARS: usize = 2048;
    let char_count = buf.chars().count();
    if char_count > MAX_SCAN_CHARS {
        *buf = buf.chars().skip(char_count - MAX_SCAN_CHARS).collect();
    }
}

fn extract_change_session_uuid_from_text(text: &str) -> Option<String> {
    const MARKER: &str = "change session ";
    let idx = text.rfind(MARKER)?;
    let rest = text[idx + MARKER.len()..].trim_start();
    let candidate: String = rest
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
        .take(36)
        .collect();
    if is_uuid_like(&candidate) {
        Some(candidate)
    } else {
        None
    }
}

fn is_uuid_like(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    parts.len() == lens.len()
        && parts
            .iter()
            .zip(lens)
            .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

fn apply_session_uuid_retarget_from_pty(
    id: SessionId,
    session_uuid: &str,
    sessions: &Arc<Mutex<HashMap<SessionId, Session>>>,
    bus: &Arc<BridgeBus>,
    app: Option<&AppHandle>,
) {
    let semantic_retarget = {
        let mut g = sessions.lock();
        let Some(s) = g.get_mut(&id) else {
            return;
        };
        if s.session_id.as_deref() == Some(session_uuid) {
            return;
        }

        let retargeted = s.retarget_tail_to_session_id(session_uuid);
        tracing::info!(
            target: "kode_hook_probe",
            %id,
            %session_uuid,
            retargeted,
            "session uuid retargeted from PTY change-session output"
        );
        s.session_id = Some(session_uuid.to_string());

        kode_core::session::jsonl_tail::Backend::from_backend_key(&s.backend_key)
            .map(|backend| (backend, s.cwd.clone(), session_uuid.to_string()))
    };

    if let Some((backend, cwd, sid)) = semantic_retarget {
        kode_bridge::semantic::spawn(id, backend, cwd, sid, Arc::clone(bus));
    }

    let payload = serde_json::json!({
        "id": id,
        "model": null,
        "title": null,
        "session_id": session_uuid,
        "tokens_reset": true,
        "tokens": null,
        "input_tokens": null,
        "output_tokens": null,
        "cached_tokens": null,
        "cost_usd": null,
        "context_pct": null,
    });
    if let Some(a) = app {
        let _ = a.emit("session-meta", payload.clone());
    }
    let mut bus_payload = payload;
    bus_payload.as_object_mut().map(|o| o.remove("id"));
    bus.emit(EventEnvelope::new(id, "meta", bus_payload));
}

fn spawn_coalesce_loop(byte_buffers: Arc<Mutex<HashMap<SessionId, SessionByteBuffer>>>) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(COALESCE_TICK_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let drained: Vec<(SessionId, Vec<u8>, Channel<Vec<u8>>)> = {
                let mut g = byte_buffers.lock();
                g.iter_mut()
                    .filter_map(|(id, buf)| {
                        // 先把上次截断的 UTF-8 remnant 拼到 pending 前面
                        if !buf.utf8_remnant.is_empty() {
                            let mut merged = std::mem::take(&mut buf.utf8_remnant);
                            merged.append(&mut buf.pending);
                            buf.pending = merged;
                        }
                        if buf.pending.is_empty() {
                            return None;
                        }
                        let ch = buf.channel.clone()?;
                        // UTF-8 边界保护:从末尾分离不完整序列,保留到下次
                        let (complete, remnant) =
                            kode_core::session::split_at_complete_utf8(&buf.pending);
                        let bytes = complete.to_vec();
                        buf.utf8_remnant = remnant;
                        buf.pending.clear();
                        Some((*id, bytes, ch))
                    })
                    .collect()
            };
            for (_id, bytes, ch) in drained {
                let _ = ch.send(bytes);
            }
        }
    });
}

/// PTY-prompt 扫描循环:每 200ms 遍历每个 session,只处理 idle ≥ 300ms 的(屏幕已稳定)。
/// 命中时合成一个 `ask_user_question` envelope 推到 bus,Flutter 直接显示卡片。
///
/// 实现要点:
/// - 复用 `Session::busy::is_busy()` 反推 idle(BusyHeuristic 默认 idle 阈值 = 300ms,见 config 默认)
/// - 同 prompt 反复扫描 → PromptState::should_emit 去重
/// - PTY 收到新字节 → spawn_event_router 已清空 PromptState,允许再次 emit
/// - **prompt 真的从屏幕消失(false → true 翻转)→ emit `session.attention_cleared`**
///   前端据此把 sidebar 脉冲动效关掉。区别于普通的 PTY-bytes 清 last_emitted —
///   那只是"允许下次同 key 再 emit",并不代表用户已经回应完。这里的 has_prompt
///   只在 scan_loop 完整观察到 detect=None 时才翻 false,所以是"屏幕真稳定且没 prompt"
///   的可靠信号。
/// - 顺手 `tick_status` 把 BusyHeuristic 的 busy/idle 翻转应用到 SessionState,并在
///   状态变化时 emit `session-status` 给桌面前端(sidebar tab 颜色用)。
fn spawn_prompt_scan_loop(
    sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
    bus: Arc<BridgeBus>,
    prompt_states: Arc<Mutex<HashMap<SessionId, PromptState>>>,
) {
    let task = async move {
        // 200ms 扫一次:既不抢 CPU,也不会让 prompt 出现到 emit 之间延迟过大
        let mut tick = tokio::time::interval(Duration::from_millis(200));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // 上次推给前端的状态(per session)— 用来去重 emit
        let mut last_status: HashMap<SessionId, &'static str> = HashMap::new();
        loop {
            tick.tick().await;

            // 1. 拍快照 —— 分两阶段,把锁持有时间压到最短,避免阻塞 write_input
            //    带来的按键乱序/卡顿。
            //
            //    阶段 A:短锁,只跑 tick_status 并采集 (id, is_running, is_busy, status_str)。
            //            注意 `is_running()` 必须在 `tick_status()` **之前**读 — tick_status
            //            会把刚退出的 session 翻成 Exited,放后面读就再也走不到 Phase B
            //            的 `screen_text` 路径,而 attention 清除依赖屏幕文本里 prompt 消失
            //            (`detect=None` 触发 has_prompt=true→false)。换序会导致最后一帧
            //            attention 永远清不掉 → sidebar 一直假装"待你回应"。
            //
            //    阶段 B:对每个 idle 的 session 再单独短锁一次取 screen_text()。
            //            screen_text 是 vt100 全屏 cell 拼字符串,虽然单次也只有亚毫秒,
            //            但若放在阶段 A 里,n 个 session 串起来 + 同时被前端 write_input
            //            和 PtyBytes feed 争锁时会抖出可感的输入卡顿/乱序。逐 session 拿锁
            //            就给按键路径插入了大量公平窗口。
            #[derive(Default)]
            struct ScanRow {
                is_running: bool,
                is_busy: bool,
                status_str: &'static str,
            }
            let rows: Vec<(SessionId, ScanRow)> = {
                let mut g = sessions.lock();
                g.iter_mut()
                    .map(|(id, s)| {
                        // is_running 先读!tick_status 之前的快照,见上面注释。
                        let is_running = s.is_running();
                        s.tick_status();
                        let status_str = match s.state.status {
                            kode_core::session::state::Status::Starting => "starting",
                            kode_core::session::state::Status::Idle => "idle",
                            kode_core::session::state::Status::Busy => "busy",
                            kode_core::session::state::Status::Exited(_) => "exited",
                        };
                        (
                            *id,
                            ScanRow {
                                is_running,
                                is_busy: s.busy.is_pty_busy(),
                                status_str,
                            },
                        )
                    })
                    .collect()
            };

            // 阶段 B:逐 session 短锁取 screen_text。
            // - 已退出 / busy → 不取屏幕文本(detector 不能工作于中间态)
            // - 其它 → 单独 lock + 立刻 drop,留出按键拿锁的公平窗口
            let snapshots: Vec<(SessionId, Option<String>, &'static str)> = rows
                .into_iter()
                .map(|(id, row)| {
                    if !row.is_running || row.is_busy {
                        return (id, None, row.status_str);
                    }
                    let text = {
                        let g = sessions.lock();
                        g.get(&id).map(|s| s.screen_text())
                    };
                    (id, text, row.status_str)
                })
                .collect();

            // 2. 逐 session 调 detector,命中且未 emit 过 → 推 bus
            for (id, maybe_screen, status_str) in snapshots {
                // 2.0 status 变化 → emit
                if last_status.get(&id).copied() != Some(status_str) {
                    last_status.insert(id, status_str);
                    bus.emit(EventEnvelope::new(
                        id,
                        "session.status",
                        serde_json::json!({ "status": status_str }),
                    ));
                }

                let Some(screen) = maybe_screen else {
                    // busy / 已退出 → 不动 has_prompt,也不动 last_emitted。等 idle 后再判断。
                    continue;
                };

                let detected = prompt_detect::detect(&screen);

                // —— 运行期可观测:detect 状态翻转时打一行 INFO,带屏幕底 6 行作为现场。
                //    平时同状态(都 None / 都 Some)不打,避免 200ms × N session 的刷屏;
                //    翻转时(无→有 / 有→无)既能看到 detector 看到了什么,也对得上 UI 是否点亮黄色。
                //    排查"待用户回应不亮 / 一直不消"时这是关键 ground truth。
                {
                    let mut g = prompt_states.lock();
                    let st = g.entry(id).or_default();
                    let was = st.has_prompt;
                    let now = detected.is_some();
                    if was != now {
                        let tail = screen
                            .lines()
                            .rev()
                            .take(6)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect::<Vec<_>>()
                            .join(" │ ");
                        tracing::info!(
                            %id,
                            from = was,
                            to = now,
                            tail = %tail,
                            "PTY detect flip"
                        );
                    }
                }

                // 2a. PTY-prompt(approval 选择题)
                if let Some(prompt) = detected.as_ref() {
                    // HookRelay 已通过 Notification(permission_prompt) 即时点亮 attention,
                    // scan_loop 这里负责补充结构化选项列表。
                    let should_emit = {
                        let mut g = prompt_states.lock();
                        let st = g.entry(id).or_default();
                        st.has_prompt = true;
                        st.should_emit(&prompt.dedup_key)
                    };
                    if should_emit {
                        // question_id 在 Flutter 端做 _Item key — 必须每次 emit 都是新值,
                        // 否则同 prompt 第二次出现时 Flutter 用旧 widget state(`_submitted=true`),
                        // 用户看到的还是已答的旧卡。
                        // 加 ts 让两次相同形态的 prompt 也是不同 question_id;PromptState
                        // 用 dedup_key 保证 200ms 扫描循环不会同 prompt 内反复 emit。
                        let now = crate::bridge::events::now_ms();
                        let qid = format!("pty-{}-{}-{}", id, simple_hash(&prompt.dedup_key), now);
                        let payload = serde_json::json!({
                            "question_id": qid,
                            "question": prompt.question,
                            "header": prompt.header,
                            "multi_select": false,
                            "options": prompt.options.iter().map(|o| serde_json::json!({
                                "label": o.label,
                                "description": null,
                                "value": o.value,
                            })).collect::<Vec<_>>(),
                            "source": "pty_prompt",
                        });
                        tracing::info!(
                            %id,
                            n_options = prompt.options.len(),
                            "synthesized ask_user_question from PTY prompt"
                        );
                        bus.emit(EventEnvelope::new(id, "ask_user_question", payload));
                    }
                } else {
                    // 当前屏幕没 prompt — 如果之前 has_prompt=true,这是"用户已回应"
                    // 的确凿信号:emit attention_cleared。
                    let was_present = {
                        let mut g = prompt_states.lock();
                        let st = g.entry(id).or_default();
                        let prev = st.has_prompt;
                        if prev {
                            st.has_prompt = false;
                            // last_emitted 同时清掉,允许同 key 的 prompt 之后再次出现时重发
                            st.last_emitted = None;
                        }
                        prev
                    };
                    if was_present {
                        tracing::info!(%id, "PTY prompt cleared from screen");
                        bus.emit(EventEnvelope::new(
                            id,
                            "session.attention_cleared",
                            serde_json::json!({ "reason": "prompt_resolved" }),
                        ));
                    }

                    // Backstop: plan_active 但屏幕上既没有 approval prompt(detect=None)
                    // 也不在 plan mode → JSONL 滞后留下的 stale plan,直接清掉。
                    {
                        let mut g = prompt_states.lock();
                        let st = g.entry(id).or_default();
                        if st.plan_active
                            && prompt_detect::detect_mode(&screen) != Some(PermissionMode::Plan)
                        {
                            st.plan_active = false;
                            tracing::info!(%id, "PTY scan backstop: clearing stale plan_active (no prompt, not in plan mode)");
                            bus.emit(EventEnvelope::new(
                                id,
                                "session.attention_cleared",
                                serde_json::json!({ "reason": "plan_backstop" }),
                            ));
                        }
                    }
                }

                // 2b. PermissionMode 变化(plan / acceptEdits / bypass / default)
                if let Some(mode) = prompt_detect::detect_mode(&screen) {
                    let changed = {
                        let mut g = prompt_states.lock();
                        let st = g.entry(id).or_default();
                        let prev = st.last_mode;
                        if prev == Some(mode) {
                            false
                        } else {
                            st.last_mode = Some(mode);
                            true
                        }
                    };
                    if changed {
                        tracing::info!(%id, mode = mode.as_str(), "permission mode changed");
                        bus.emit(EventEnvelope::new(
                            id,
                            "session.mode_changed",
                            serde_json::json!({ "mode": mode.as_str() }),
                        ));
                    }
                }
            }
        }
    };
    // 用 tauri::async_runtime::spawn — 跟其它后台 task 一样,setup 钩子里没有
    // tokio current-thread runtime,直接 tokio::spawn 会 panic("there is no reactor running")
    tauri::async_runtime::spawn(task);
}

/// 订阅 BridgeBus,把"需要用户操作"的事件转发到桌面 webview。
///
/// 桌面前端 sidebar 收到 `session-attention { id, kind }` 后给对应 tab 加脉冲动效;
/// 收到 `session-attention-clear { id }` 后关掉动效。这里关心五类事件:
///   - `ask_user_question_hint`(hook relay 即时通知)→ 立即点亮(不等 scan loop)
///   - `ask_user_question`(PTY scan loop / AskUserQuestion)→ set
///   - `plan_proposed`(ExitPlanMode)→ set
///   - `session.attention_cleared`(hook relay 或 scan_loop)→ clear
///   - `session.status`(scan_loop 同步的 starting/idle/busy/exited)→ 转发
///
/// 注意:不要把 `tool_use` 等普通流量也广播进来 — 那会让 sidebar 一直在闪。
fn spawn_attention_forwarder(
    app: AppHandle,
    bus: Arc<crate::bridge::events::BridgeBus>,
    prompt_states: Arc<Mutex<HashMap<SessionId, PromptState>>>,
    sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut rx = bus.subscribe();
        loop {
            match rx.recv().await {
                Ok(env) => {
                    if env.session_id == 0 {
                        if env.r#type == "memory.pending" {
                            let _ = app.emit("memory-pending-remote", env.payload.clone());
                        }
                        continue;
                    }
                    match env.r#type.as_str() {
                        "session.created" => {
                            tracing::info!(
                                target: "bridge_forwarder",
                                id = env.session_id,
                                payload = %env.payload,
                                "forwarder received session.created"
                            );
                            let r = app.emit("session-created", &env.payload);
                            if let Err(e) = r {
                                tracing::warn!(
                                    target: "bridge_forwarder",
                                    id = env.session_id,
                                    error = %e,
                                    "failed to emit session-created Tauri event"
                                );
                            } else {
                                tracing::info!(
                                    target: "bridge_forwarder",
                                    id = env.session_id,
                                    "emitted session-created Tauri event"
                                );
                            }
                        }
                        "session.session_uuid_mapped" => {
                            // SessionStart hook 权威绑定:tab(env.session_id)当前真实 session 是
                            // session_uuid,jsonl 文件是 transcript_path。普通 backend 重定向
                            // meta+semantic tail;Cursor 的 meta.json watcher 保持不动,只单独启动
                            // transcript semantic tail。
                            let transcript = env.payload["transcript_path"].as_str();
                            let uuid = env.payload["session_uuid"].as_str();
                            let source = env.payload["source"].as_str().unwrap_or("");
                            tracing::info!(
                                target: "kode_hook_probe",
                                id = env.session_id,
                                ?uuid,
                                ?transcript,
                                %source,
                                "session_uuid_mapped received"
                            );
                            if let Some(path) = transcript {
                                let known = sessions.lock().contains_key(&env.session_id);
                                let path_buf = std::path::PathBuf::from(path);
                                let cursor_semantic = uuid.and_then(|uuid| {
                                    let mut locked = sessions.lock();
                                    let session = locked.get_mut(&env.session_id)?;
                                    let backend =
                                        kode_core::session::jsonl_tail::Backend::from_backend_key(
                                            &session.backend_key,
                                        )?;
                                    if backend != kode_core::session::jsonl_tail::Backend::Cursor
                                        || !session.accepts_transcript_path(&path_buf)
                                    {
                                        return None;
                                    }
                                    let should_spawn = session.session_id.as_deref() != Some(uuid);
                                    session.session_id = Some(uuid.to_string());
                                    Some((backend, should_spawn))
                                });
                                let retargeted =
                                    if let Some((backend, should_spawn)) = cursor_semantic {
                                        if should_spawn {
                                            kode_bridge::semantic::spawn_path(
                                                env.session_id,
                                                backend,
                                                path_buf.clone(),
                                                Arc::clone(&bus),
                                            );
                                        }
                                        Some(true)
                                    } else {
                                        sessions
                                            .lock()
                                            .get(&env.session_id)
                                            .map(|s| s.retarget_tail(path_buf))
                                    };
                                if retargeted == Some(true) {
                                    if let Some(uuid) = uuid {
                                        kode_core::session::backend::bind_hook_conversation(
                                            uuid,
                                            env.session_id,
                                        );
                                    }
                                }
                                tracing::info!(
                                    target: "kode_hook_probe",
                                    id = env.session_id,
                                    path,
                                    tab_known = known,
                                    ?retargeted,
                                    "session_uuid_mapped → retarget tail result"
                                );
                            }
                            // 普通 backend 的 session.session_id 由重定向后 JsonlMeta 更新;
                            // Cursor 在上面直接绑定 UUID，meta watcher 后续仍可更新 title。
                        }
                        "ask_user_question_hint" => {
                            // Hook relay 即时通知:有权限请求出现,立即点亮 attention。
                            // 不等待 200ms scan loop + detect()。
                            let plan_active = {
                                let mut g = prompt_states.lock();
                                let st = g.entry(env.session_id).or_default();
                                if !st.plan_active {
                                    st.ask_attention_active = true;
                                }
                                st.plan_active
                            };
                            if plan_active {
                                continue;
                            }
                            let _ = app.emit(
                                "session-attention",
                                serde_json::json!({ "id": env.session_id, "kind": "ask" }),
                            );
                        }
                        "ask_user_question" => {
                            // plan 活跃时,同一 approval prompt 的 PTY ask 不点亮 —
                            // plan 拥有该 prompt,避免 ask/plan 竞态覆盖。
                            let plan_active = {
                                let mut g = prompt_states.lock();
                                let st = g.entry(env.session_id).or_default();
                                if !st.plan_active {
                                    st.ask_attention_active = true;
                                }
                                st.plan_active
                            };
                            if plan_active {
                                continue;
                            }
                            let _ = app.emit(
                                "session-attention",
                                serde_json::json!({ "id": env.session_id, "kind": "ask" }),
                            );
                        }
                        "plan_proposed" => {
                            {
                                let mut g = prompt_states.lock();
                                if let Some(st) = g.get_mut(&env.session_id) {
                                    st.plan_active = true;
                                }
                            }
                            let _ = app.emit(
                                "session-attention",
                                serde_json::json!({ "id": env.session_id, "kind": "plan" }),
                            );
                        }
                        "session.attention_cleared" => {
                            {
                                let mut g = prompt_states.lock();
                                if let Some(st) = g.get_mut(&env.session_id) {
                                    st.has_prompt = false;
                                    st.ask_attention_active = false;
                                    st.last_emitted = None;
                                    st.plan_active = false;
                                }
                            }
                            let _ = app.emit(
                                "session-attention-clear",
                                serde_json::json!({ "id": env.session_id }),
                            );
                        }
                        "session.status" => {
                            let _ = app.emit(
                                "session-status",
                                serde_json::json!({
                                    "id": env.session_id,
                                    "status": env.payload["status"],
                                }),
                            );
                        }
                        "session.turn_finished" => {
                            {
                                let mut g = sessions.lock();
                                if let Some(s) = g.get_mut(&env.session_id) {
                                    s.mark_turn_end();
                                }
                            }
                            let mut payload = env.payload.clone();
                            match payload.as_object_mut() {
                                Some(obj) => {
                                    obj.entry("id")
                                        .or_insert_with(|| serde_json::json!(env.session_id));
                                }
                                None => {
                                    payload = serde_json::json!({ "id": env.session_id });
                                }
                            }
                            let _ = app.emit("session-turn-finished", payload);
                        }
                        "session.focus_requested" => {
                            // payload 携带 session DTO(id/backend_key/cwd/...),
                            // 前端 tab 缺失时据此补建;兜底确保 id 字段一定存在。
                            let mut payload = env.payload.clone();
                            match payload.as_object_mut() {
                                Some(obj) => {
                                    obj.entry("id")
                                        .or_insert_with(|| serde_json::json!(env.session_id));
                                }
                                None => {
                                    payload = serde_json::json!({ "id": env.session_id });
                                }
                            }
                            let _ = app.emit("session-focus-requested", payload);
                        }
                        _ => continue,
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// 简易稳定 hash(FNV-1a 32-bit),用作 question_id 后缀。
fn simple_hash(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_byte_handoff_preserves_split_ansi_sequence() {
        let mut buf = SessionByteBuffer::new();
        buf.pending.extend_from_slice(b"\x1b[38;2;40;");

        let initial = buf.take_initial_bytes();
        buf.pending.extend_from_slice(b"184;148mgreen\x1b[0m");

        let mut replay = initial;
        replay.extend_from_slice(&buf.pending);
        assert_eq!(replay, b"\x1b[38;2;40;184;148mgreen\x1b[0m");
    }

    #[test]
    fn initial_byte_handoff_keeps_truncated_utf8_for_live_stream() {
        let mut buf = SessionByteBuffer::new();
        buf.pending.extend_from_slice(&[0xE4, 0xBD]);

        assert!(buf.take_initial_bytes().is_empty());
        assert_eq!(buf.utf8_remnant, vec![0xE4, 0xBD]);

        buf.pending.push(0xA0);
        let live = buf.take_initial_bytes();
        assert_eq!(live, "你".as_bytes());
        assert!(buf.utf8_remnant.is_empty());
    }

    #[test]
    fn stale_unsubscribe_cannot_clear_new_subscriber() {
        let mut buf = SessionByteBuffer::new();
        buf.subscriber_id = Some("new".to_string());

        assert!(!buf.unsubscribe_if_current("old"));
        assert_eq!(buf.subscriber_id.as_deref(), Some("new"));
        assert!(buf.unsubscribe_if_current("new"));
        assert!(buf.subscriber_id.is_none());
    }

    #[test]
    fn extract_change_session_uuid_from_pty_text() {
        let text = "> /resume\n  change session 094f83f6-d036-45ef-bdbb-a6a809394bef";
        assert_eq!(
            extract_change_session_uuid_from_text(text).as_deref(),
            Some("094f83f6-d036-45ef-bdbb-a6a809394bef")
        );
    }

    #[test]
    fn scan_pty_change_session_handles_split_chunks() {
        let mut buffers = HashMap::new();
        assert_eq!(
            scan_pty_change_session(&mut buffers, 1, b"> /resume\n  change session "),
            None
        );
        assert_eq!(
            scan_pty_change_session(&mut buffers, 1, b"094f83f6-d036-45ef-bdbb-a6a809394bef")
                .as_deref(),
            Some("094f83f6-d036-45ef-bdbb-a6a809394bef")
        );
    }

    #[test]
    fn scan_pty_change_session_ignores_ansi_wrapping() {
        let mut buffers = HashMap::new();
        let bytes =
            b"\x1b[32m  \xe2\x8e\xbf change session 094f83f6-d036-45ef-bdbb-a6a809394bef\x1b[0m";
        assert_eq!(
            scan_pty_change_session(&mut buffers, 1, bytes).as_deref(),
            Some("094f83f6-d036-45ef-bdbb-a6a809394bef")
        );
    }

    #[test]
    fn extract_change_session_uuid_rejects_invalid_uuid() {
        assert_eq!(
            extract_change_session_uuid_from_text("change session not-a-uuid"),
            None
        );
    }
}
