//! Phase 11.2:`SessionTransport` — GUI 与"在哪里跑 PTY"之间的边界。
//!
//! ## 设计要点(必读)
//!
//! 1. **不下沉字节流路径**。trait 只覆盖 spawn / write_input / resize / kill 四个动作,
//!    字节流回路由实现自己挂到 GUI 已有的 `BridgeBus` / Tauri channel。
//!    本地 PTY 的 mpsc → channel → xterm 不变;远程 WS 进来的字节由 RemoteTransport
//!    自己 decode 后灌进同一个 BridgeBus,前端不感知来源。
//!
//! 2. **Local 与 Remote 是真正分叉的两条路径**(ROADMAP §484 + Phase 11 不变量 #1)。
//!    把 trait 抽到字节通道层 = 本地 PTY 被迫绕一圈 broadcast,延迟从 mpsc 几微秒
//!    退到 ms 级,违反 PTY → 像素 P99 < 16ms 硬指标。
//!
//! 3. **Endpoint 命名空间分离**:`EndpointId::Local` 是单例;远端是字符串 id
//!    (用户在 GUI 配的 endpoint key,如 `"dev-server"`)。Local backend 列表来自
//!    `~/.kode/config.toml [backends.*]`;远端 backend 列表运行时从
//!    `GET /api/v1/backends` 拉(11.1.2 已实现 server 端)。
//!
//! 4. **trait 不暴露 `Session` 类型**。返回 `SpawnedSession` DTO,因为远端 transport
//!    里没有本地 `Session` 对象 — server 持有 PTY,客户端只持有元数据。
//!    本地 transport 内部仍然把 `Session` 插进 `BridgeCtx::sessions`(状态栏 / 屏幕快照
//!    等本地操作还要直接访问),只是不通过 trait 暴露。

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::SessionId;

/// 标识一个 transport 端点。
///
/// `Local` 是单例,代表"在 GUI 进程内跑 PTY";远端是用户配置里的 endpoint key
/// (如 `"dev-server"`,对应 `~/.kode/config.toml [endpoints.dev-server]`)。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum EndpointId {
    Local,
    Remote { id: String },
}

impl EndpointId {
    /// 紧凑字符串表示,适合做 HashMap key 或 log 标签。
    /// `Local` → `"local"`,`Remote { id: "dev" }` → `"remote:dev"`。
    pub fn as_tag(&self) -> String {
        match self {
            EndpointId::Local => "local".to_string(),
            EndpointId::Remote { id } => format!("remote:{id}"),
        }
    }
}

impl fmt::Display for EndpointId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_tag())
    }
}

/// 启动 session 的入参,与具体 transport 无关。
///
/// 命名差异:
/// - `cwd`:Local 走本地 fs 路径;Remote 走 server 端路径(由 11.1.3 fs.list 选)
/// - `permission_mode` / `model`:Local 注入到子进程 args;Remote 透传给 server
///   (`POST /api/v1/sessions` 协议 §4.2 — 注:协议当前没有 model/permission_mode 字段,
///   Phase 11.3 联调时若发现需要再补协议)
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub backend_key: String,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<std::path::PathBuf>,
    pub resume_session_uuid: Option<String>,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    /// kode 在 spawn 前从 MemoryStore 查好的项目 facts（格式化为 bullet list）。
    /// `None` = 跳过注入（memory 为空 / 查询失败 / prompt 注入总开关关掉）。
    /// Local transport 把它拼到 `--append-system-prompt` 末尾；Remote transport 忽略。
    pub memory_context: Option<String>,
}

/// transport spawn 后回的 DTO。前端接到后用来初始化 tab 状态。
#[derive(Debug, Clone, Serialize)]
pub struct SpawnedSession {
    pub id: SessionId,
    pub backend_key: String,
    pub model: String,
    pub title: String,
    /// 子进程的 session uuid(若 backend 支持);恢复 / 持久化要带它
    pub session_uuid: Option<String>,
    /// 实际生效的 cwd(Remote transport 这里返回 server 端绝对路径)
    pub cwd: String,
}

/// transport 错误类型。
///
/// 故意不带 source 链(thiserror)— 上层 Tauri command 用 `String` 错误,
/// 拼成可读字符串就够了。需要细分时再细化。
#[derive(Debug)]
pub enum TransportError {
    /// 配置 / 入参问题(backend 未注册、cwd 不存在等),通常是 client bug
    BadRequest(String),
    /// session id 不存在
    NotFound(SessionId),
    /// 内部错误(spawn 失败、PTY 错、网络错等)
    Internal(String),
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::BadRequest(d) => write!(f, "bad request: {d}"),
            TransportError::NotFound(id) => write!(f, "session {id} not found"),
            TransportError::Internal(d) => write!(f, "internal error: {d}"),
        }
    }
}

impl std::error::Error for TransportError {}

/// 把 transport 错误变成 Tauri command 的 `String` 错误。
impl From<TransportError> for String {
    fn from(e: TransportError) -> Self {
        e.to_string()
    }
}

/// **GUI 与"在哪里跑 PTY"之间的统一接口**。
///
/// 实现:
/// - `LocalTransport`(在 `apps/gui/src-tauri/src/transport/local.rs`)
/// - `RemoteTransport`(Phase 11.3 落地)
///
/// trait 故意是 `async_trait` —— 远端实现要做 HTTP / WS,async 是必需的;
/// 本地实现里 `spawn` 内部仍是同步(PTY fork),用 async 只是为了与 trait 对齐,
/// 不阻塞 tokio runtime。
#[async_trait::async_trait]
pub trait SessionTransport: Send + Sync {
    /// 端点身份,主要给 log / 排错用。
    fn endpoint_id(&self) -> EndpointId;

    /// 启动一个新 session。
    async fn spawn(&self, spec: SpawnSpec) -> Result<SpawnedSession, TransportError>;

    /// 把字节写到 session 的 PTY stdin(键盘输入 / 粘贴)。
    ///
    /// **本地实现必须保证按 invoke 顺序串行**(commands.rs::write_input 注释里讲过
    /// 顺序问题);远端实现里同一个 endpoint 上的多次 write 也要保证顺序到 server。
    async fn write_input(&self, id: SessionId, bytes: &[u8]) -> Result<(), TransportError>;

    /// 调整 PTY 终端尺寸。
    async fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), TransportError>;

    /// 杀 session(对应桌面 Cmd+W)。
    /// 远端实现:DELETE 协议端点;server 真 kill 远端 codebuddy 进程。
    async fn kill(&self, id: SessionId) -> Result<(), TransportError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_id_tag_format() {
        assert_eq!(EndpointId::Local.as_tag(), "local");
        assert_eq!(
            EndpointId::Remote {
                id: "dev-server".into()
            }
            .as_tag(),
            "remote:dev-server"
        );
    }

    #[test]
    fn endpoint_id_serde_roundtrip() {
        let local = EndpointId::Local;
        let remote = EndpointId::Remote {
            id: "myhost".into(),
        };
        let lj = serde_json::to_string(&local).unwrap();
        let rj = serde_json::to_string(&remote).unwrap();
        assert_eq!(lj, r#"{"kind":"local"}"#);
        assert_eq!(rj, r#"{"kind":"remote","id":"myhost"}"#);
        let lr: EndpointId = serde_json::from_str(&lj).unwrap();
        let rr: EndpointId = serde_json::from_str(&rj).unwrap();
        assert_eq!(lr, local);
        assert_eq!(rr, remote);
    }

    #[test]
    fn transport_error_display() {
        assert!(TransportError::NotFound(7).to_string().contains("7"));
        assert!(TransportError::BadRequest("foo".into())
            .to_string()
            .contains("foo"));
    }

    #[test]
    fn endpoint_id_eq_distinguishes_remote_ids() {
        let a = EndpointId::Remote { id: "a".into() };
        let b = EndpointId::Remote { id: "b".into() };
        assert_ne!(a, b);
        assert_eq!(a, EndpointId::Remote { id: "a".into() });
    }
}
