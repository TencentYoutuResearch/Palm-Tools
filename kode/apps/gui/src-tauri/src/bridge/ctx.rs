//! 桥端共享状态:axum router、Tauri 命令都拿同一份 `Arc<BridgeCtx>`,
//! 测试时也能在不启 Tauri runtime 的前提下构造 ctx 跑 router。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use kode_core::{
    config::{BackendConfig, Config},
    session::Session,
    CoreEvent, SessionId,
};
use parking_lot::{Mutex, RwLock};
use tokio::sync::mpsc;

use crate::bridge::events::BridgeBus;
use crate::bridge::prompt_detect::PromptState;
use crate::memory::MemoryHandle;
use crate::state::SessionByteBuffer;

pub struct BridgeCtx {
    pub config: Config,
    /// Runtime backend snapshot. Unlike `config`, this is refreshed after backend CRUD
    /// so a newly saved backend can be listed and spawned without restarting the GUI.
    pub backend_configs: Arc<RwLock<HashMap<String, BackendConfig>>>,
    pub sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
    pub byte_buffers: Arc<Mutex<HashMap<SessionId, SessionByteBuffer>>>,
    pub core_tx: mpsc::UnboundedSender<CoreEvent>,
    pub next_id: Arc<Mutex<SessionId>>,
    pub bus: Arc<BridgeBus>,
    pub token: Arc<String>,
    /// bridge server 实际监听的地址。
    /// `None` = 桥被 KODE_BRIDGE_DISABLE 关闭(配对不可用)。
    /// 启动时写入,之后只读 — Mutex 是为了避免 spawn 顺序耦合,实际只写一次。
    pub listen_addr: Arc<Mutex<Option<SocketAddr>>>,
    /// 每 session 的 PTY-prompt 检测状态(去重 / 上次 emit)。
    /// 见 bridge::prompt_detect。
    pub prompt_states: Arc<Mutex<HashMap<SessionId, PromptState>>>,
    /// 用户在 GUI 里选定的「session 工作目录」。
    /// 新建 tab 时优先用这个,而不是 KODE_CWD env / process current_dir。
    /// `None` = 走老的回退链。运行时可改(set_session_cwd command)。
    pub session_cwd_override: Arc<Mutex<Option<std::path::PathBuf>>>,
    /// 当前生效的 config.toml 路径(load 时使用的)。
    /// `None` = 走 dirs::config_dir() 默认。仅展示 / 持久化用,
    /// 切换需重启 GUI 才能让 backends 列表更新。
    pub config_path: Arc<Mutex<Option<std::path::PathBuf>>>,
    /// Memory vault 句柄。`Some` = vault 可用,bridge handler 直接操作
    /// 远端 `~/.kode-memory` 的 pending / facts。
    /// `None` = vault 打不开,memory 路由返回 503。
    pub memory: Option<Arc<MemoryHandle>>,
}

impl BridgeCtx {
    pub fn alloc_id(&self) -> SessionId {
        let mut g = self.next_id.lock();
        let id = *g;
        *g += 1;
        id
    }
}
