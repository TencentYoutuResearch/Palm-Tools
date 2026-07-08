//! Phase 11.2:`LocalTransport` — 在 GUI 进程内跑 PTY 的 transport 实现。
//!
//! ## 关键约束(必读,改之前看一遍)
//!
//! 1. **不动字节通道**:本文件只承担 spawn / write_input / resize / kill 四个
//!    命令的"路由"作用,字节流仍走 `kode_core::PtyHost` → `mpsc<CoreEvent>`
//!    → `state::spawn_event_router` → `byte_buffers` → `Channel<Vec<u8>>`
//!    这条已有路径。Phase 7 性能验收(PTY → 像素 P99 < 16ms)的整条链路保留。
//!
//! 2. **`spawn` 的副作用与原 `commands::spawn_session` 等价**:
//!    - 把 `Session` 插进 `ctx.sessions`(给状态栏 / 屏幕快照 / 远端 bridge router 用)
//!    - 在 `ctx.byte_buffers` 占位
//!    - 启 `bridge::semantic` jsonl tail(若 backend 支持 + session_uuid 已知)
//!    - 在 `bus` 上 emit `session.created` 事件给 WS 订阅者
//!
//! 3. **错误返回 `TransportError`**,不直接拼字符串。Tauri command 层用
//!    `?` 转 `String` 通过 `From<TransportError> for String`。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use kode_core::{
    config::BackendConfig, session::Session, EndpointId, SessionId, SessionTransport, SpawnSpec,
    SpawnedSession, TransportError,
};
use serde_json::json;

use crate::bridge::ctx::BridgeCtx;
use crate::bridge::events::EventEnvelope;
use crate::state::SessionByteBuffer;

/// 在 GUI 进程内跑 PTY 的 transport 实现。
///
/// 这是一个**薄包装** — 内部全部委托给 `BridgeCtx` 与 `kode_core::Session`,
/// 没有独立状态。同一个 `Arc<BridgeCtx>` 既给本 transport,也给 axum router
/// (远端 client 通过 protocol 连进来)、Tauri 命令直接访问。
pub struct LocalTransport {
    ctx: Arc<BridgeCtx>,
    /// 是否启用 kode-memory prompt 注入。从 `PersistedState::kode_memory_prompt_enabled`
    /// 读;但每次 spawn 都重新读盘(老语义,见 commands.rs::spawn_session 注释)。
    /// 这里保留构造参数主要是为了**测试**时可以传死值 false 避免依赖磁盘文件。
    use_persisted_memory_prompt_flag: bool,
    /// HookRelay socket 路径,用于 spawn 子进程时注入 `KODE_HOOK_SOCK` env。
    /// `None` = HookRelay 未启用,不注入。
    /// hook command(`$KODE_HOOK_SOCK`)会在变量为空时 nc 连接失败 → exit 0,完全无害。
    hook_sock: Option<String>,
}

impl LocalTransport {
    pub fn new(ctx: Arc<BridgeCtx>, hook_sock: Option<String>) -> Self {
        Self {
            ctx,
            use_persisted_memory_prompt_flag: true,
            hook_sock,
        }
    }

    /// 测试用构造:给定 ctx + 关闭 memory prompt 注入(避免读盘)。
    #[cfg(test)]
    pub fn new_for_test(ctx: Arc<BridgeCtx>) -> Self {
        Self {
            ctx,
            use_persisted_memory_prompt_flag: false,
            hook_sock: None,
        }
    }

    fn read_memory_prompt_flag(&self) -> bool {
        if !self.use_persisted_memory_prompt_flag {
            return false;
        }
        // 与 commands.rs::spawn_session 完全一致的读法,保持语义。
        crate::persistence::load()
            .kode_memory_prompt_enabled
            .unwrap_or(true)
    }
}

#[async_trait]
impl SessionTransport for LocalTransport {
    fn endpoint_id(&self) -> EndpointId {
        EndpointId::Local
    }

    async fn spawn(&self, spec: SpawnSpec) -> Result<SpawnedSession, TransportError> {
        let backend: BackendConfig = self
            .ctx
            .config
            .backend(&spec.backend_key)
            .ok_or_else(|| {
                TransportError::BadRequest(format!("backend not configured: {}", spec.backend_key))
            })?
            .clone();

        let id = self.ctx.alloc_id();
        let cwd_path = spec
            .cwd
            .clone()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/")));

        // 构建 extra_env:
        // - KODE_HOOK_SOCK 供 hook command 定位 GUI relay socket。
        // - KODE_SESSION_ID 让 Codex hook 把 Codex 自己的 session id 映射回 Kode tab id。
        // - KODE_MEMORY_ROOT 让 hook 子进程与 GUI/MCP 使用同一份 memory root。
        let mut extra_env: Vec<(String, String)> = Vec::new();
        if let Some(sock) = self.hook_sock.as_deref() {
            extra_env.push(("KODE_HOOK_SOCK".to_string(), sock.to_string()));
        }
        extra_env.push(("KODE_SESSION_ID".to_string(), id.to_string()));
        extra_env.push((
            "KODE_MEMORY_ROOT".to_string(),
            crate::memory::resolve_memory_root().display().to_string(),
        ));

        let mut session = Session::new(
            id,
            &spec.backend_key,
            &backend,
            spec.cols,
            spec.rows,
            Duration::from_millis(self.ctx.config.ui.idle_threshold_ms),
            self.ctx.config.ui.scrollback_lines,
            &cwd_path,
            self.ctx.core_tx.clone(),
            spec.resume_session_uuid.as_deref(),
            spec.permission_mode.as_deref(),
            spec.model.as_deref(),
            self.read_memory_prompt_flag(),
            spec.memory_context.as_deref(),
            &extra_env,
            None, // GUI does not use initial_prompt (user types interactively)
        )
        .map_err(|e| TransportError::Internal(format!("spawn failed: {e}")))?;

        let resume_session_id = session.session_id.clone();
        apply_resume_meta_snapshot(
            &mut session,
            &spec.backend_key,
            &cwd_path,
            resume_session_id.as_deref(),
        );

        let model = session.state.model.clone();
        let title = session.state.title.clone();
        let session_uuid = session.session_id.clone();

        // 顺序:先插 sessions / byte_buffers,再启 jsonl tail,最后 emit session.created。
        // 启 tail 之前必须 byte_buffers 占位 — 否则首批 PTY 字节进 spawn_event_router
        // 时会创建 buffer,但 channel 还没绑定(前端 onMount 后才 subscribe),
        // 那段字节就被静默丢了。占位之后 buffer 已存在,等 channel 绑上来字节
        // 全在 pending 里。
        self.ctx.sessions.lock().insert(id, session);
        self.ctx
            .byte_buffers
            .lock()
            .entry(id)
            .or_insert_with(SessionByteBuffer::new);

        // Phase 9.1.4 jsonl 语义 tail
        if let (Some(sid), Some(backend_kind)) = (
            session_uuid.as_deref(),
            kode_core::session::jsonl_tail::Backend::from_backend_key(&spec.backend_key),
        ) {
            kode_bridge::semantic::spawn(
                id,
                backend_kind,
                cwd_path.clone(),
                sid.to_string(),
                Arc::clone(&self.ctx.bus),
            );
        }

        // Phase 9.1:emit session.created 给 WS 订阅者(远端 client 也能看到本地新开的 tab)
        self.ctx.bus.emit(EventEnvelope::new(
            id,
            "session.created",
            json!({
                "id": id,
                "backend_key": spec.backend_key,
                "title": title.clone(),
                "model": model.clone(),
                "session_uuid": session_uuid.clone(),
                "cwd": cwd_path.to_string_lossy(),
            }),
        ));

        Ok(SpawnedSession {
            id,
            backend_key: spec.backend_key,
            model,
            title,
            session_uuid,
            cwd: cwd_path.to_string_lossy().into_owned(),
        })
    }

    async fn write_input(&self, id: SessionId, bytes: &[u8]) -> Result<(), TransportError> {
        let g = self.ctx.sessions.lock();
        let s = g.get(&id).ok_or(TransportError::NotFound(id))?;
        s.write_input(bytes);
        Ok(())
    }

    async fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), TransportError> {
        // 与 commands::resize_session 同源的最小尺寸校验:
        // xterm.js fit addon 在 webview 还没拿到尺寸时会算出 0x0 或 1x1,
        // 直接 resize 到那个尺寸 → vt100 内部除 0 / panic。
        const MIN_COLS: u16 = 20;
        const MIN_ROWS: u16 = 5;
        if cols < MIN_COLS || rows < MIN_ROWS {
            tracing::warn!(id, cols, rows, "ignoring resize: below minimum");
            return Ok(());
        }
        let mut g = self.ctx.sessions.lock();
        let s = g.get_mut(&id).ok_or(TransportError::NotFound(id))?;
        s.resize(cols, rows);
        Ok(())
    }

    async fn kill(&self, id: SessionId) -> Result<(), TransportError> {
        let removed = self.ctx.sessions.lock().remove(&id);
        if let Some(s) = removed {
            if let Some(p) = &s.pty {
                p.kill();
            }
        }
        // byte_buffers 也清掉,避免 LRU 缓存里堆积已退 session 的 channel 引用
        self.ctx.byte_buffers.lock().remove(&id);
        // 不主动 emit session.exited:PtyExited 走 spawn_event_router 路径会
        // 自动 emit。这里 emit 反而会双发。kill_session 命令在 commands.rs 现状
        // 也是不 emit 的(只有协议端点 DELETE 才主动 emit "deleted_by_api")。
        Ok(())
    }
}

fn apply_resume_meta_snapshot(
    session: &mut Session,
    backend_key: &str,
    cwd: &Path,
    session_id: Option<&str>,
) {
    let Some(session_id) = session_id else {
        return;
    };
    let Some(backend) = kode_core::session::jsonl_tail::Backend::from_backend_key(backend_key)
    else {
        return;
    };
    let Some(path) = kode_core::session::jsonl_tail::resolve_session_path(backend, cwd, session_id)
    else {
        return;
    };

    let (title, model, total_tokens) = crate::commands::extract_session_meta(&path);
    if let Some(model) = model {
        session.state.model = model;
    }
    if let Some(title) = title {
        if !session.state.title_pinned {
            session.state.title = title;
        }
    }
    if let Some(tokens) = total_tokens {
        session.state.tokens = Some(tokens);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::build_test_ctx;
    use kode_core::config::{BackendConfig, Config, UiConfig};
    use std::collections::HashMap;

    fn echo_config() -> Config {
        let mut backends = HashMap::new();
        backends.insert(
            "echo".to_string(),
            BackendConfig {
                command: "/bin/cat".to_string(),
                args: vec![],
                default_model: None,
                model_flag: None,
                permission_mode_flag: None,
                mcp_setup: None,
                enabled: None,
            },
        );
        Config {
            default_backend: "echo".to_string(),
            backends,
            ui: UiConfig::default(),
        }
    }

    #[tokio::test]
    async fn spawn_then_write_then_kill_round_trip() {
        let ctx = build_test_ctx(echo_config(), "tok".into());
        let transport = LocalTransport::new_for_test(Arc::clone(&ctx));
        assert_eq!(transport.endpoint_id(), EndpointId::Local);

        let spawned = transport
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
            .expect("spawn ok");
        assert!(spawned.id > 0);
        assert_eq!(spawned.backend_key, "echo");
        // 'echo' 不是 jsonl-tail backend,session_uuid 应为 None
        assert!(spawned.session_uuid.is_none());

        // write_input 走 PTY 不报错
        transport
            .write_input(spawned.id, b"hello\n")
            .await
            .expect("write ok");

        // resize 正常
        transport
            .resize(spawned.id, 100, 30)
            .await
            .expect("resize ok");

        // 太小尺寸 → 静默忽略(不报错)
        transport
            .resize(spawned.id, 5, 2)
            .await
            .expect("undersize resize is no-op");

        // kill 正常
        transport.kill(spawned.id).await.expect("kill ok");

        // kill 后 sessions 里应该没了
        assert!(ctx.sessions.lock().get(&spawned.id).is_none());
    }

    #[tokio::test]
    async fn spawn_unknown_backend_returns_bad_request() {
        let ctx = build_test_ctx(echo_config(), "tok".into());
        let transport = LocalTransport::new_for_test(ctx);
        let err = transport
            .spawn(SpawnSpec {
                backend_key: "nonexistent".into(),
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
        match err {
            TransportError::BadRequest(d) => assert!(d.contains("nonexistent")),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn write_input_to_unknown_session_returns_not_found() {
        let ctx = build_test_ctx(echo_config(), "tok".into());
        let transport = LocalTransport::new_for_test(ctx);
        let err = transport
            .write_input(9999, b"x")
            .await
            .expect_err("should fail");
        assert!(matches!(err, TransportError::NotFound(9999)));
    }

    #[tokio::test]
    async fn kill_unknown_session_is_idempotent() {
        // 协议契约:kill 没找到 session 不报错(避免客户端竞态)
        let ctx = build_test_ctx(echo_config(), "tok".into());
        let transport = LocalTransport::new_for_test(ctx);
        transport.kill(9999).await.expect("kill ghost is no-op");
    }

    #[tokio::test]
    async fn spawn_emits_session_created_on_bus() {
        let ctx = build_test_ctx(echo_config(), "tok".into());
        let mut rx = ctx.bus.subscribe();
        let transport = LocalTransport::new_for_test(Arc::clone(&ctx));

        let spawned = transport
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
            .unwrap();

        // 应能从 bus 拿到 session.created
        let env = rx.try_recv().expect("session.created should be emitted");
        assert_eq!(env.r#type, "session.created");
        assert_eq!(env.session_id, spawned.id);
        let _ = transport.kill(spawned.id).await;
    }
}
