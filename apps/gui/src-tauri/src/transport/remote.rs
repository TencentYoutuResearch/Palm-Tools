//! Phase 11.3:`RemoteTransport` — 通过 kode 协议(`.specops/specs/remote-protocol.md`)连远端
//! 另一个 GUI 实例的 Rust bridge。
//!
//! ## 架构(必读)
//!
//! ```text
//!                                          REST (reqwest)
//!  ┌────────────┐  spawn/write/resize/kill ───────────────────► ┌──────────────┐
//!  │ Tauri cmd  │                                               │ remote server│
//!  │ commands.rs│  WS pty_bytes / meta / exited (tungstenite)   │ (Rust/Go)    │
//!  │            │ ◄──────────────────────────────────────────── │              │
//!  └─────┬──────┘                                               └──────────────┘
//!        │ core_tx (CoreEvent::PtyBytes / PtyExited / JsonlMeta / BusEvent)
//!        ▼
//!  ┌────────────────────────────────────────────────────────┐
//!  │ spawn_event_router  →  byte_buffers  →  Channel<Vec<u8>>│  (前端 xterm 渲染)
//!  └────────────────────────────────────────────────────────┘
//! ```
//!
//! 关键点:
//!
//! 1. **字节流走 `core_tx`,不绕开 spawn_event_router**。这样远端字节走的路径
//!    与本地 PTY **完全一样** —— vt100 parser 喂入、coalesce loop、Channel send,
//!    前端 xterm 收到的字节流没有"来源"概念。
//!
//! 2. **session_id 双重映射**:服务端有自己的 `id`(uint64),GUI 这边也有自己的
//!    `SessionId`。**目前直接用服务端 id 当 GUI id**(简单,且 server 与本地
//!    BridgeCtx::next_id 都 atomic 不冲突 —— 本地 next_id 从 1 开始,远端如果
//!    spawn 出 2 而本地正好也分配到 2 就会撞)。Phase 11.4 会引入 namespace map
//!    `(EndpointId, server_id) → local_id`。**当前实现的限制**:同时连远端 +
//!    本地开 tab 时,session_id 可能撞,后果是 `ctx.sessions` 里被覆盖。本期只
//!    保证测试场景不撞(测试里 RemoteTransport 用单独的 ctx),生产 GUI 多 endpoint
//!    场景由 11.4 解决。
//!
//! 3. **WS 连接 lazy 启动**:第一次 spawn 触发 `ensure_ws_started`;后续重连由
//!    内部 task 自治,RemoteTransport drop 时 cancel。
//!
//! 4. **断线重连不丢事件**:重连后调 `GET /history?from=<last_event_ts_ms>` 拉漏
//!    掉的事件回灌。`pty_bytes` 协议契约不在 history 中(§5.3),所以漏掉的字节
//!    无法补 —— 但 vt100 parser 是状态机,客户端短时断线对屏幕影响有限,11.5
//!    UI 会在断线超阈值时显示"屏幕已过时,按 Cmd+R 重画"提示。

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use kode_core::{
    CoreEvent, EndpointId, SessionId, SessionTransport, SpawnSpec, SpawnedSession, TransportError,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::transport::ssh_tunnel::SshTunnel;
use tokio_tungstenite::tungstenite::protocol::Message as WsMessage;

/// `RemoteTransport::rest_get` 的错误。`status` = `Some(code)` 表示 server 返回了
/// HTTP 响应但非 2xx;`None` 表示连接 / 隧道 / 解码层失败(没拿到 HTTP 状态)。
///
/// 调用方可以用 `err.status == Some(404)` 可靠区分 "路径不存在" 与其它错误,
/// 不依赖错误字符串格式(参见 plan P1 修正)。
#[derive(Debug)]
pub struct RestError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for RestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "http {s}: {}", self.message),
            None => write!(f, "{}", self.message),
        }
    }
}

/// 远端 endpoint 的连接配置。Phase 11.4 会从 `~/.kode/config.toml` +
/// keyring 拼出来;现在直接由调用方/测试构造。
#[derive(Debug, Clone)]
pub struct RemoteConfig {
    /// 用户起的 endpoint id(`EndpointId::Remote { id }` 的 id),用于 log
    pub id: String,
    /// 形如 `http://127.0.0.1:9870` 或 `https://dev.tail-xxxx.ts.net`。
    ///
    /// **SSH 隧道模式下**这里是「远端视角」的 url(远端 server 自己监听的地址);
    /// 真正连接用的本地 url 由 `RemoteTransport::ensure_tunnel` 在运行时把 host:port
    /// rewrite 成 `127.0.0.1:<动态本地端口>`。
    pub base_url: String,
    /// bearer token(协议 §3)
    pub token: String,
    /// 重连退避序列(秒)。空 = 用默认 [1, 2, 5, 10, 30]
    pub reconnect_backoff_secs: Vec<u64>,
    /// **Phase 11.7** SSH 隧道配置。`None` = 直连模式(行为完全不变)。
    pub ssh: Option<SshSpec>,
}

/// SSH 隧道参数(见 `ssh_tunnel.rs`)。
#[derive(Debug, Clone)]
pub struct SshSpec {
    /// `user@host` 或 `~/.ssh/config` 的 Host 别名
    pub host: String,
    /// SSH 服务端口(`ssh -p <ssh_port>`),默认 22。
    /// 0 / 22 → 不加 -p;devcloud 等非标环境填实际端口(如 36000)。
    pub ssh_port: u16,
    /// 远端 server 监听端口(隧道 `-L local:127.0.0.1:<remote_port>`)
    pub remote_port: u16,
}

impl RemoteConfig {
    /// 从给定 base url 拼 WS url。`base` 由 caller 解析(直连 = `base_url`;
    /// SSH 模式 = 隧道 rewrite 后的本地 url)。
    fn ws_url_for(&self, base: &str) -> String {
        let base = base.strip_suffix('/').unwrap_or(base);
        let scheme = if base.starts_with("https://") {
            "wss://"
        } else {
            "ws://"
        };
        let host = base
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        format!(
            "{scheme}{host}/ws?token={}",
            url::form_urlencoded::byte_serialize(self.token.as_bytes()).collect::<String>()
        )
    }

    fn rest_url_for(base: &str, path: &str) -> String {
        let base = base.strip_suffix('/').unwrap_or(base);
        format!("{base}{path}")
    }

    fn backoff_secs(&self) -> Vec<u64> {
        if self.reconnect_backoff_secs.is_empty() {
            vec![1, 2, 5, 10, 30]
        } else {
            self.reconnect_backoff_secs.clone()
        }
    }
}

/// `Arc<RemoteTransport>` 在 RemoteTransport drop 时关闭 WS 后台任务。
/// 这样多个 spawn 命令共享同一个 transport 时,只在最后一个 Arc drop 后才停 WS。
pub struct RemoteTransport {
    cfg: RemoteConfig,
    http: reqwest::Client,
    /// 把远端事件转成 `CoreEvent` 灌进本地 GUI 路由。
    /// 复用 `BridgeCtx::core_tx` —— 本地 PTY 走的同一条管子。
    core_tx: mpsc::UnboundedSender<CoreEvent>,
    /// WS 后台 task 句柄。`None` = 还没启;启过之后不再换。
    /// drop 时 abort()。
    /// 用 `tauri::async_runtime::JoinHandle`(不是 `tokio::task::JoinHandle`)
    /// 以支持从 Tauri setup 钩子(macOS main thread,无 Tokio reactor)启动任务。
    ws_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// 重连追踪:断线时记最后一次见到的事件 ts(毫秒),重连后用 `?from=<ts>` 拉历史。
    last_event_ts_ms: Arc<Mutex<u64>>,
    /// **Session ID 命名空间隔离** — 解决 remote server_id 与本地 alloc_id() 碰撞:
    ///
    /// 本地 alloc_id() 从 1 开始递增;remote server 也从 1 开始 → spawn 第一个 local tab
    /// 和第一个 remote tab 都会拿到 id=1,Svelte `{#each (t.id)}` 键碰撞 → crash。
    ///
    /// 修复:spawn 时用 `id_alloc` 拿一个**本地 GUI 命名空间**里的唯一 id 作为 local_id,
    /// 同时在 `session_id_map` 里记 local_id → server_id。REST 调用(write/resize/kill)
    /// 和 WS 事件(pty_bytes/meta/exited)都通过 `session_id_map` 做双向翻译。
    session_id_map: Arc<Mutex<HashMap<u64, SessionId>>>,
    /// local_id → server_id 反向映射,供 write/resize/kill REST 路由用。
    server_id_map: Arc<Mutex<HashMap<SessionId, u64>>>,
    /// 本地 session ID 分配器 — 与 BridgeCtx::alloc_id() 共享同一计数器,
    /// 保证 Local + 所有 Remote endpoint 的 session id 在整个 GUI 进程里唯一。
    id_alloc: Arc<dyn Fn() -> SessionId + Send + Sync>,
    /// **Phase 11.7** SSH 隧道(懒加载)。直连模式恒为 `None`。
    /// SSH 模式下首次 `ensure_tunnel()` 时起隧道并缓存;`Drop` 时 kill 子进程。
    tunnel: Arc<Mutex<Option<SshTunnel>>>,
    /// 指向自身的 Weak,用于 SSH 懒加载模式下从 `&self` 方法(spawn)里启动
    /// 需要 `Arc<Self>` 的 WS 后台任务。`start_background_tasks` 注册时填。
    self_weak: Mutex<Weak<RemoteTransport>>,
}

impl RemoteTransport {
    pub fn new(
        cfg: RemoteConfig,
        core_tx: mpsc::UnboundedSender<CoreEvent>,
        id_alloc: Arc<dyn Fn() -> SessionId + Send + Sync>,
    ) -> Self {
        let http = reqwest::Client::builder()
            // 单条请求超时给 30s — 协议端点都很快,慢就是网烂,早失败比僵着好
            .timeout(Duration::from_secs(30))
            // connect 用更短的 — 失败后由重连 / 上层重试
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client should build");
        Self {
            cfg,
            http,
            core_tx,
            ws_task: Mutex::new(None),
            last_event_ts_ms: Arc::new(Mutex::new(0)),
            session_id_map: Arc::new(Mutex::new(HashMap::new())),
            server_id_map: Arc::new(Mutex::new(HashMap::new())),
            id_alloc,
            tunnel: Arc::new(Mutex::new(None)),
            self_weak: Mutex::new(Weak::new()),
        }
    }

    /// 是否 SSH 隧道模式。`endpoints::register_transport` 用它决定要不要在注册时
    /// 立即起 WS(直连立即起;SSH 懒加载到首次 spawn)。
    pub fn is_ssh_mode(&self) -> bool {
        self.cfg.ssh.is_some()
    }

    /// local_id → server_id のルックアップ。write_input / resize / kill で使う。
    fn server_id_for(&self, local_id: SessionId) -> Option<u64> {
        self.server_id_map.lock().get(&local_id).copied()
    }

    /// **懒加载隧道核心** —— 返回「真正用来连接」的 base url。
    ///
    /// - 直连模式(`cfg.ssh == None`):直接返回 `cfg.base_url`,零开销。
    /// - SSH 模式:
    ///   - 已有活隧道 → 复用,返回 `http://127.0.0.1:<local_port>`
    ///   - 隧道不存在 / 已死 → (重)起隧道,缓存,返回新本地 url
    ///
    /// 起隧道是阻塞操作(spawn ssh + 轮询端口),放 `spawn_blocking` 里跑,
    /// 不堵 async runtime。
    ///
    /// base url 的 host:port 被 rewrite 成本地端口,scheme 强制降为 `http`
    /// —— 隧道内是明文回环,远端即便配了 https 我们也连本地 http 端口。
    async fn ensure_tunnel(&self) -> Result<String, String> {
        let Some(ssh) = self.cfg.ssh.clone() else {
            // 直连模式
            return Ok(self.cfg.base_url.clone());
        };

        // 已有活隧道?复用。
        {
            let mut g = self.tunnel.lock();
            if let Some(t) = g.as_mut() {
                if t.is_alive() {
                    return Ok(format!("http://127.0.0.1:{}", t.local_port));
                }
                // 死了 → drop 掉,下面重起
                *g = None;
            }
        }

        let remote_port = if ssh.remote_port == 0 {
            9870
        } else {
            ssh.remote_port
        };
        let ssh_port = ssh.ssh_port; // 0 / 22 → 不加 -p
        let host = ssh.host.clone();
        let new_tunnel =
            tokio::task::spawn_blocking(move || SshTunnel::spawn(&host, ssh_port, remote_port))
                .await
                .map_err(|e| format!("tunnel task join: {e}"))??;
        let local_port = new_tunnel.local_port;
        *self.tunnel.lock() = Some(new_tunnel);
        Ok(format!("http://127.0.0.1:{local_port}"))
    }

    /// 通过 transport 的长连接隧道(ensure_tunnel)发 GET 请求到 bridge。
    ///
    /// path 形如 `"/api/v1/fs/list"`;query 是 query string 键值对。
    /// 复用 `ensure_tunnel()` 的长连接 SSH 隧道(SSH 模式下不在调用方每次新建),
    /// 直连模式零开销(直接返回 `cfg.base_url`)。
    ///
    /// 错误:`RestError { status: None }` = 隧道 / 网络 / 解码失败;
    /// `RestError { status: Some(code) }` = server 返回非 2xx HTTP。
    /// 调用方可 `err.status == Some(404)` 区分 "路径不存在"。
    pub async fn rest_get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, RestError> {
        let base = self.ensure_tunnel().await.map_err(|e| RestError {
            status: None,
            message: format!("ssh tunnel: {e}"),
        })?;
        let url = RemoteConfig::rest_url_for(&base, path);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(&self.cfg.token)
            .query(query)
            .send()
            .await
            .map_err(|e| RestError {
                status: None,
                message: format!("rest_get {path}: {e}"),
            })?;
        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().await.unwrap_or_default();
            return Err(RestError {
                status: Some(status.as_u16()),
                message: detail,
            });
        }
        resp.json::<Value>().await.map_err(|e| RestError {
            status: None,
            message: format!("decode {path}: {e}"),
        })
    }

    /// SSH 懒加载模式下从 `&self`(spawn)里拉起 WS:升级 `self_weak` → ensure_ws。
    /// 已起过则幂等。weak 失效(transport 正在 drop)→ 静默跳过。
    fn ensure_ws_lazy(&self) {
        let weak = self.self_weak.lock().clone();
        if let Some(arc) = weak.upgrade() {
            arc.ensure_ws_started();
        }
    }

    fn ensure_ws_started(self: &Arc<Self>) {
        let mut g = self.ws_task.lock();
        if g.is_some() {
            return;
        }
        let me = Arc::clone(self);
        // Must use `tauri::async_runtime::spawn` (not `tokio::spawn`) because
        // `ensure_ws_started` can be called from the Tauri setup hook on the
        // macOS main thread, which has no Tokio reactor.
        // `tauri::async_runtime::JoinHandle` ≡ `tokio::task::JoinHandle`.
        let handle = tauri::async_runtime::spawn(async move {
            me.ws_loop().await;
        });
        *g = Some(handle);
    }

    /// 长跑后台 task:连 WS → 收事件 → 灌 core_tx;断线退避重连;直到 transport drop。
    async fn ws_loop(self: Arc<Self>) {
        let backoff = self.cfg.backoff_secs();
        let mut attempt = 0usize;

        loop {
            match self.connect_and_pump().await {
                Ok(()) => {
                    // 正常关闭(对端关 / 主动 close)— 通常只发生在 transport drop,
                    // 但保险起见仍重连一次,真 drop 的话 spawn 已被 abort。
                    attempt = 0;
                }
                Err(e) => {
                    tracing::warn!(
                        endpoint = %self.cfg.id,
                        attempt,
                        error = %e,
                        "WS connection lost, will retry"
                    );
                }
            }

            // 重连前补 history(11.3.3):拉 last_ts 之后的事件,塞回 core_tx
            let from_ms = *self.last_event_ts_ms.lock();
            if from_ms > 0 {
                if let Err(e) = self.fetch_history_since(from_ms).await {
                    tracing::warn!(
                        endpoint = %self.cfg.id,
                        error = %e,
                        "history backfill failed (will retry on next reconnect)"
                    );
                }
            }

            let wait = backoff
                .get(attempt)
                .copied()
                .unwrap_or_else(|| *backoff.last().unwrap_or(&30));
            tokio::time::sleep(Duration::from_secs(wait)).await;
            attempt = attempt.saturating_add(1);
        }
    }

    /// 一次连接 + 收事件循环。返回 Ok(()) = 对端正常关;Err = 网络/解析错。
    async fn connect_and_pump(&self) -> Result<(), String> {
        // SSH 模式:确保隧道活着,拿到本地 url;直连模式直接拿 base_url。
        let base = self.ensure_tunnel().await?;
        let url = self.cfg.ws_url_for(&base);
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|e| format!("ws connect: {e}"))?;

        tracing::info!(endpoint = %self.cfg.id, "WS connected");

        // 25s 主动 ping 心跳,防中间代理踢
        let mut ping_iv = tokio::time::interval(Duration::from_secs(25));
        ping_iv.tick().await; // 立即消费第一拍,避免连上就 ping

        loop {
            tokio::select! {
                msg = ws.next() => {
                    match msg {
                        Some(Ok(WsMessage::Text(text))) => {
                            self.dispatch_event_text(&text);
                        }
                        Some(Ok(WsMessage::Binary(_))) => {
                            // 协议没定义 binary 帧,忽略
                        }
                        Some(Ok(WsMessage::Ping(p))) => {
                            let _ = ws.send(WsMessage::Pong(p)).await;
                        }
                        Some(Ok(WsMessage::Pong(_))) => {}
                        Some(Ok(WsMessage::Close(_))) | None => return Ok(()),
                        Some(Ok(WsMessage::Frame(_))) => {} // raw frame, low-level, 无视
                        Some(Err(e)) => return Err(format!("ws recv: {e}")),
                    }
                }
                _ = ping_iv.tick() => {
                    let pong_marker = json!({"type":"ping"}).to_string();
                    if let Err(e) = ws.send(WsMessage::Text(pong_marker)).await {
                        return Err(format!("ws ping send: {e}"));
                    }
                }
            }
        }
    }

    /// 把 WS 上来的一个事件(`.specops/specs/remote-protocol.md` §5.1 envelope)翻成 `CoreEvent`
    /// 灌进 core_tx,顺手更新 last_event_ts_ms 给重连补 history 用。
    fn dispatch_event_text(&self, text: &str) {
        let env: EventEnvelope = match serde_json::from_str(text) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = %e, raw = %text, "WS event parse failed");
                return;
            }
        };
        if env.ts > 0 {
            let mut g = self.last_event_ts_ms.lock();
            if env.ts > *g {
                *g = env.ts;
            }
        }
        self.handle_envelope(env);
    }

    fn handle_envelope(&self, env: EventEnvelope) {
        // memory.pending 是 endpoint 级事件,不属于某个 session,bridge 用 session_id=0。
        // 这里直接注入 endpoint_id 后转成本地 bus 事件,由 state forwarder 发给 WebView。
        if env.r#type == "memory.pending" {
            let mut payload = env.payload.clone();
            payload["endpoint_id"] = serde_json::json!(self.cfg.id);
            let _ = self.core_tx.send(CoreEvent::BusEvent {
                id: 0,
                event_type: env.r#type.clone(),
                payload,
            });
            return;
        }

        // 把 server_id 翻译成本地 GUI session id。
        // 如果找不到映射(连接建立前的 "hello" 或未知 session 的事件),直接忽略。
        let local_id = match self.session_id_map.lock().get(&env.session_id).copied() {
            Some(id) => id,
            None => {
                tracing::warn!(
                    server_id = env.session_id,
                    event_type = %env.r#type,
                    "WS event for unknown session_id — dropped"
                );
                return;
            }
        };
        match env.r#type.as_str() {
            "pty_bytes" => {
                // payload: { bytes_b64: "..." }
                let Some(b64) = env.payload.get("bytes_b64").and_then(|v| v.as_str()) else {
                    return;
                };
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes())
                else {
                    tracing::warn!("pty_bytes invalid base64 ignored");
                    return;
                };
                let _ = self.core_tx.send(CoreEvent::PtyBytes {
                    id: local_id,
                    bytes,
                });
            }
            "session.exited" => {
                let code = env
                    .payload
                    .get("exit_code")
                    .and_then(|v| v.as_i64())
                    .map(|c| c as i32);
                let _ = self
                    .core_tx
                    .send(CoreEvent::PtyExited { id: local_id, code });
            }
            "meta" => {
                // payload: { model?, title?, tokens: {input,output,cached,total}?, context_pct?, cost_usd? }
                let model = env
                    .payload
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let title = env
                    .payload
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let (input_tokens, output_tokens, cached_tokens, total_tokens) =
                    if let Some(t) = env.payload.get("tokens") {
                        if t.is_object() {
                            (
                                t.get("input").and_then(|v| v.as_u64()),
                                t.get("output").and_then(|v| v.as_u64()),
                                t.get("cached").and_then(|v| v.as_u64()),
                                t.get("total").and_then(|v| v.as_u64()),
                            )
                        } else {
                            (
                                env.payload.get("input_tokens").and_then(|v| v.as_u64()),
                                env.payload.get("output_tokens").and_then(|v| v.as_u64()),
                                env.payload.get("cached_tokens").and_then(|v| v.as_u64()),
                                t.as_u64(),
                            )
                        }
                    } else {
                        (None, None, None, None)
                    };
                let context_pct = env
                    .payload
                    .get("context_pct")
                    .and_then(|v| v.as_f64())
                    .map(|f| f as f32);
                let cost_usd = env.payload.get("cost_usd").and_then(|v| v.as_f64());
                let tokens_reset = env
                    .payload
                    .get("tokens_reset")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let session_uuid = env
                    .payload
                    .get("session_uuid")
                    .or_else(|| env.payload.get("session_id"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let _ = self.core_tx.send(CoreEvent::JsonlMeta {
                    id: local_id,
                    model,
                    title,
                    session_uuid,
                    tokens_reset,
                    tokens: total_tokens,
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                    cost_usd,
                    context_pct,
                });
            }
            // 把远端 bus 事件透传给本地 BridgeBus:
            // spawn_attention_forwarder 已有这些 case 的处理逻辑,经 CoreEvent::BusEvent
            // → spawn_event_router → BridgeBus → forwarder → Tauri emit 全链路打通。
            //
            // 注意:payload 里的 `id` 字段(如 session.created 的 dto.id)是远端
            // server_id,前端 tab 用的是 local_id(spawn 返回值)。对 session.created
            // 必须替换 payload.id 成 local_id,否则前端会创建一个 server_id 的
            // 影子 tab,且 session-status 事件(local_id)永远匹配不上它。
            "session.created" => {
                let mut p = env.payload.clone();
                if let Some(id) = p.get_mut("id") {
                    *id = serde_json::json!(local_id);
                }
                let _ = self.core_tx.send(CoreEvent::BusEvent {
                    id: local_id,
                    event_type: env.r#type.clone(),
                    payload: p,
                });
            }
            "session.status"
            | "ask_user_question"
            | "ask_user_question_hint"
            | "plan_proposed"
            | "session.attention_cleared"
            | "session.mode_changed"
            | "session.focus_requested"
            | "session.turn_finished" => {
                let _ = self.core_tx.send(CoreEvent::BusEvent {
                    id: local_id,
                    event_type: env.r#type.clone(),
                    payload: env.payload.clone(),
                });
            }
            // connection.hello / message / tool_use 等协议层事件不需要转发到 GUI
            _ => {}
        }
    }

    async fn fetch_history_since(&self, from_ms: u64) -> Result<(), String> {
        // pty_bytes 不在 history(§5.3)。这里捞回的主要是 meta + session.exited,
        // 用于断线期间错过的状态变化。
        // 没有特定 session id —— 协议 history 是 per-session 的;断线期间多个 session
        // 都可能产生事件。简化起见暂时遍历当前 session_id_map(目前为空,因为我们
        // 还没在 spawn 时填它)。Phase 11.4 引入完整 namespace 后这里再改。
        let _ = from_ms;
        Ok(())
    }
}

impl Drop for RemoteTransport {
    fn drop(&mut self) {
        if let Some(h) = self.ws_task.lock().take() {
            h.abort();
        }
    }
}

#[derive(Debug, Deserialize)]
struct EventEnvelope {
    #[allow(dead_code)]
    protocol_version: Option<String>,
    #[allow(dead_code)]
    schema_version: Option<u32>,
    session_id: u64,
    ts: u64,
    r#type: String,
    payload: Value,
}

#[async_trait]
impl SessionTransport for RemoteTransport {
    fn endpoint_id(&self) -> EndpointId {
        EndpointId::Remote {
            id: self.cfg.id.clone(),
        }
    }

    async fn spawn(&self, spec: SpawnSpec) -> Result<SpawnedSession, TransportError> {
        // 第一次调 spawn 才启 WS — 避免没用到远端时占资源。
        // 这里需要一个 Arc<Self> 引用,但 trait 方法只有 &self;改成在外部由
        // ensure_ws_started 包装(下面的 with_arc 模式需要 caller 持 Arc)。
        // 简化:trait 不直接访问 ensure_ws_started,改由 commands.rs 在注册 transport
        // 时,调用 RemoteTransport::start_ws_if_needed(&Arc::clone(...))。
        // 但当前 Phase 11.3 范围:WS 在 transport 构造后由调用方主动调一次
        // start_background_tasks(&Arc<Self>),见集成测试用例。
        //
        // Phase 11.7:SSH 模式下这里(首次 spawn)会触发隧道懒加载。
        let base = self
            .ensure_tunnel()
            .await
            .map_err(|e| TransportError::Internal(format!("ssh tunnel: {e}")))?;
        let url = RemoteConfig::rest_url_for(&base, "/api/v1/sessions");
        let mut body = serde_json::Map::new();
        body.insert(
            "backend_key".into(),
            Value::String(spec.backend_key.clone()),
        );
        body.insert(
            "cols".into(),
            Value::Number(serde_json::Number::from(spec.cols)),
        );
        body.insert(
            "rows".into(),
            Value::Number(serde_json::Number::from(spec.rows)),
        );
        if let Some(c) = spec.cwd.as_ref() {
            body.insert(
                "cwd".into(),
                Value::String(c.to_string_lossy().into_owned()),
            );
        }
        if let Some(s) = spec.resume_session_uuid.as_ref() {
            body.insert("resume_session_uuid".into(), Value::String(s.clone()));
        }
        if let Some(s) = spec.permission_mode.as_ref() {
            body.insert("permission_mode".into(), Value::String(s.clone()));
        }
        if let Some(s) = spec.model.as_ref() {
            body.insert("model".into(), Value::String(s.clone()));
        }

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.cfg.token)
            .json(&Value::Object(body))
            .send()
            .await
            .map_err(|e| TransportError::Internal(format!("POST /sessions: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().await.unwrap_or_default();
            return Err(map_status_error(status, detail));
        }

        let dto: Value = resp
            .json()
            .await
            .map_err(|e| TransportError::Internal(format!("decode session DTO: {e}")))?;

        let server_id = dto
            .get("id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| TransportError::Internal("missing id in spawn response".into()))?;
        let backend_key = dto
            .get("backend_key")
            .and_then(|v| v.as_str())
            .unwrap_or(&spec.backend_key)
            .to_string();
        let model = dto
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("auto")
            .to_string();
        let title = dto
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("remote tab")
            .to_string();
        let session_uuid = dto
            .get("session_uuid")
            .and_then(|v| v.as_str())
            .map(String::from);
        let cwd = dto
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| spec.cwd.as_ref().map(|p| p.to_string_lossy().into_owned()))
            .unwrap_or_default();

        // 分配一个本地 GUI 命名空间唯一 id,避免与本地 PTY session id 碰撞。
        // server_id 只在 REST URL 里用;WS 事件里的 session_id 也是 server_id,
        // 需要经 session_id_map 翻译成 local_id 再传给 CoreEvent。
        let local_id = (self.id_alloc)();
        {
            let mut sm = self.session_id_map.lock();
            let mut rm = self.server_id_map.lock();
            sm.insert(server_id, local_id);
            rm.insert(local_id, server_id);
        }

        // SSH 懒加载:首次 spawn 成功后才拉起 WS 后台任务(直连模式注册时已起,
        // ensure_ws_started 内部幂等,这里再调一次也无害)。这样没用到远端的
        // SSH endpoint 不会在 GUI 启动时就建隧道 + 连 WS。
        self.ensure_ws_lazy();

        Ok(SpawnedSession {
            id: local_id,
            backend_key,
            model,
            title,
            session_uuid,
            cwd,
        })
    }

    async fn write_input(&self, id: SessionId, bytes: &[u8]) -> Result<(), TransportError> {
        let server_id = self.server_id_for(id).ok_or(TransportError::NotFound(id))?;
        let base = self
            .ensure_tunnel()
            .await
            .map_err(|e| TransportError::Internal(format!("ssh tunnel: {e}")))?;
        let url = RemoteConfig::rest_url_for(&base, &format!("/api/v1/sessions/{server_id}/input"));
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.cfg.token)
            .json(&json!({ "bytes_b64": b64 }))
            .send()
            .await
            .map_err(|e| TransportError::Internal(format!("POST /input: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().await.unwrap_or_default();
            return Err(map_status_error(status, detail));
        }
        Ok(())
    }

    async fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), TransportError> {
        let server_id = self.server_id_for(id).ok_or(TransportError::NotFound(id))?;
        let base = self
            .ensure_tunnel()
            .await
            .map_err(|e| TransportError::Internal(format!("ssh tunnel: {e}")))?;
        let url =
            RemoteConfig::rest_url_for(&base, &format!("/api/v1/sessions/{server_id}/resize"));
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.cfg.token)
            .json(&json!({ "cols": cols, "rows": rows }))
            .send()
            .await
            .map_err(|e| TransportError::Internal(format!("POST /resize: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let detail = resp.text().await.unwrap_or_default();
            return Err(map_status_error(status, detail));
        }
        Ok(())
    }

    async fn kill(&self, id: SessionId) -> Result<(), TransportError> {
        let server_id = match self.server_id_for(id) {
            Some(sid) => sid,
            // 已被清理(或从未注册) — 视为幂等成功,与 404 语义一致
            None => return Ok(()),
        };
        // 只清 server_id_map(local→server,仅供出站 REST 用)。
        // **不**清 session_id_map(server→local):DELETE 触发的 server 端
        // `session.exited` 事件随后会经 WS 回来,handle_envelope 仍需用它把
        // server_id 翻成 local_id 转发 PtyExited;提前删会让退出事件被丢弃
        // (前端 tab 卡在"运行中")。exited 后该 session 不再产事件,留个
        // 映射条目无害;真正的清理交给将来的 exited 处理或 transport drop。
        self.server_id_map.lock().remove(&id);
        // SSH 模式:隧道若起不来(远端已挂 / GUI 退出途中),kill 视为幂等成功 —
        // 本地映射已清,远端 session 随 server 一起没,不必硬连。
        let base = match self.ensure_tunnel().await {
            Ok(b) => b,
            Err(e) => {
                tracing::debug!(error = %e, "kill: tunnel unavailable, treating as idempotent success");
                return Ok(());
            }
        };
        let url = RemoteConfig::rest_url_for(&base, &format!("/api/v1/sessions/{server_id}"));
        let resp = self
            .http
            .delete(&url)
            .bearer_auth(&self.cfg.token)
            .send()
            .await
            .map_err(|e| TransportError::Internal(format!("DELETE /sessions: {e}")))?;
        let status = resp.status();
        if !status.is_success() && status.as_u16() != 404 {
            // 404 视为幂等成功(已被别的 client 杀掉),与 LocalTransport 行为一致
            let detail = resp.text().await.unwrap_or_default();
            return Err(map_status_error(status, detail));
        }
        Ok(())
    }
}

/// 把 HTTP 状态码翻成 TransportError。详细 detail(JSON `error` / `detail` 字段)
/// 不深解,直接附在错误字符串里 — 给 log 用。
fn map_status_error(status: reqwest::StatusCode, body: String) -> TransportError {
    match status.as_u16() {
        400 => TransportError::BadRequest(body),
        401 | 403 => TransportError::Internal(format!("auth failed ({}): {}", status, body)),
        404 => TransportError::Internal(format!("not found: {}", body)),
        _ => TransportError::Internal(format!("http {}: {}", status, body)),
    }
}

/// 启动 WS 后台任务(直连模式用)。**必须在 `Arc::new(RemoteTransport::new(...))`
/// 之后立刻调一次**;否则 spawn 出 session 后,远端推 pty_bytes 没人接收 →
/// 前端看不到任何输出。
///
/// 单独抽这个函数(而不是放进 `new`)是因为 trait 方法 `&self` 拿不到 `Arc<Self>`,
/// 只能由调用方在持有 Arc 的位置启动后台任务。
///
/// 顺手记录 `self_weak`,供 SSH 懒加载模式下从 `spawn(&self)` 里拉起 WS。
pub fn start_background_tasks(transport: &Arc<RemoteTransport>) {
    *transport.self_weak.lock() = Arc::downgrade(transport);
    transport.ensure_ws_started();
}

/// **SSH 懒加载模式专用**:只记录 `self_weak`,**不**起 WS / 隧道。
/// WS 推迟到首次 `spawn` 成功后由 `ensure_ws_lazy` 拉起。
pub fn register_self_weak(transport: &Arc<RemoteTransport>) {
    *transport.self_weak.lock() = Arc::downgrade(transport);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_substitutes_scheme_and_appends_token() {
        let cfg = RemoteConfig {
            id: "x".into(),
            base_url: "http://127.0.0.1:9870".into(),
            token: "abc".into(),
            reconnect_backoff_secs: vec![],
            ssh: None,
        };
        assert_eq!(
            cfg.ws_url_for(&cfg.base_url),
            "ws://127.0.0.1:9870/ws?token=abc"
        );

        let cfg2 = RemoteConfig {
            id: "x".into(),
            base_url: "https://dev.tail.ts.net/".into(),
            token: "xyz".into(),
            reconnect_backoff_secs: vec![],
            ssh: None,
        };
        assert_eq!(
            cfg2.ws_url_for(&cfg2.base_url),
            "wss://dev.tail.ts.net/ws?token=xyz"
        );
    }

    #[test]
    fn ws_url_url_encodes_token_special_chars() {
        let cfg = RemoteConfig {
            id: "x".into(),
            base_url: "http://h:1".into(),
            // token 含 + / = 这种 base64 里常见的字符,原样塞 query 是错的
            token: "a+b/c=".into(),
            reconnect_backoff_secs: vec![],
            ssh: None,
        };
        let u = cfg.ws_url_for(&cfg.base_url);
        assert!(u.contains("token=a%2Bb%2Fc%3D"), "got {u}");
    }

    #[test]
    fn rest_url_strips_trailing_slash() {
        assert_eq!(
            RemoteConfig::rest_url_for("http://h:1/", "/api/v1/sessions"),
            "http://h:1/api/v1/sessions"
        );
    }

    #[test]
    fn backoff_default_when_empty() {
        let cfg = RemoteConfig {
            id: "x".into(),
            base_url: "http://h:1".into(),
            token: "t".into(),
            reconnect_backoff_secs: vec![],
            ssh: None,
        };
        assert_eq!(cfg.backoff_secs(), vec![1, 2, 5, 10, 30]);
    }

    #[test]
    fn map_status_error_routes_correctly() {
        use reqwest::StatusCode;
        let bad = map_status_error(StatusCode::BAD_REQUEST, "x".into());
        assert!(matches!(bad, TransportError::BadRequest(_)));
        let unauth = map_status_error(StatusCode::UNAUTHORIZED, "x".into());
        assert!(matches!(unauth, TransportError::Internal(_)));
        let other = map_status_error(StatusCode::INTERNAL_SERVER_ERROR, "x".into());
        assert!(matches!(other, TransportError::Internal(_)));
    }

    #[tokio::test]
    async fn spawn_against_unreachable_endpoint_returns_internal_error() {
        let cfg = RemoteConfig {
            id: "ghost".into(),
            // 用 IANA reserved + reserved port,99% 概率 connection refused
            base_url: "http://127.0.0.1:1".into(),
            token: "t".into(),
            reconnect_backoff_secs: vec![1],
            ssh: None,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        use std::sync::atomic::{AtomicU64, Ordering};
        let counter = Arc::new(AtomicU64::new(1));
        let alloc = Arc::new(move || counter.fetch_add(1, Ordering::Relaxed));
        let t = RemoteTransport::new(cfg, tx, alloc);
        let err = t
            .spawn(SpawnSpec {
                backend_key: "echo".into(),
                cols: 80,
                rows: 24,
                cwd: None,
                resume_session_uuid: None,
                permission_mode: None,
                model: None,
                memory_context: None,
            })
            .await
            .expect_err("should fail");
        assert!(matches!(err, TransportError::Internal(_)));
    }

    #[test]
    fn endpoint_id_reflects_config_id() {
        let cfg = RemoteConfig {
            id: "myhost".into(),
            base_url: "http://h:1".into(),
            token: "t".into(),
            reconnect_backoff_secs: vec![],
            ssh: None,
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        use std::sync::atomic::{AtomicU64, Ordering};
        let counter = Arc::new(AtomicU64::new(1));
        let alloc = Arc::new(move || counter.fetch_add(1, Ordering::Relaxed));
        let t = RemoteTransport::new(cfg, tx, alloc);
        assert_eq!(
            t.endpoint_id(),
            EndpointId::Remote {
                id: "myhost".into()
            }
        );
    }
}
