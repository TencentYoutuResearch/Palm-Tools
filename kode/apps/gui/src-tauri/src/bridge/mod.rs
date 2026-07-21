//! 远程桥(Phase 9.1)。
//!
//! - `events.rs`:`EventEnvelope` + `BridgeBus`(broadcast + 历史 ring buffer)
//! - `kode-bridge`:共享 axum router(REST 端点 + WS 升级 + 鉴权)
//! - `server.rs`:进程内启动 server,监听 0.0.0.0:47870
//!
//! 设计:
//! - server 在 `lib.rs::run` 的 setup 钩子里 spawn,与 GUI 共享 `AppState`
//! - 所有 axum handler 通过 `AppHandle.state::<AppState>()` 拿到 sessions / token / bus
//! - 鉴权用 bearer token(REST `Authorization: Bearer ...`、WS `?token=...`)
//! - 默认监听 0.0.0.0(所有接口),方便同网段移动端配对;仍可用 KODE_BRIDGE_BIND 覆盖
//!
//! 协议契约:`.specops/specs/remote-protocol.md`(v1)。

pub mod ctx;
pub mod events;
pub mod prompt_detect;
pub mod server;

pub use ctx::BridgeCtx;
pub use server::{spawn_bridge, BridgeConfig};
