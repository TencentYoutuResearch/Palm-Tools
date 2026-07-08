//! kode-core — UI 无关的纯 Rust 内核:PTY、会话、配置、事件总线。
//!
//! 这个 crate 是从 `kode` TUI v0.1 抽出来的,GUI(Tauri)和 TUI 都依赖它。
//! **不依赖任何 UI 框架**(没有 ratatui / crossterm / tauri),只暴露:
//!
//!   - `PtyHost`           — 子进程 + PTY 生命周期
//!   - `Session`           — 一个 tab 的状态机(vt100 parser + 元数据 + jsonl tail)
//!   - `Config`            — TOML 配置 + 默认值(含 codebuddy/claude 后端)
//!   - `CoreEvent`         — Session 内部事件(PTY 字节、退出、jsonl 元数据)
//!   - `SessionTransport`  — Phase 11.2 抽象,本地 / 远端 PTY 在哪跑由 transport 决定
//!
//! 上层 UI 把 `CoreEvent` 包成自己的 Action/Message 即可。

pub mod config;
pub mod context;
pub mod cost;
pub mod event;
pub mod model_alias;
pub mod pty;
pub mod session;
pub mod transport;

pub use config::{BackendConfig, Config, UiConfig};
pub use event::CoreEvent;
pub use model_alias::short_model_name;
pub use pty::PtyHost;
pub use session::{Session, SessionId};
pub use transport::{EndpointId, SessionTransport, SpawnSpec, SpawnedSession, TransportError};
