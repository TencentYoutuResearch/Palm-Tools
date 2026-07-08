//! Phase 11.2/11.3:transport 模块根。
//!
//! 见 `kode_core::transport` 的 trait 定义;本目录只放 GUI 端的实现。
//! - `local.rs`:在 GUI 进程内跑 PTY(Phase 11.2)
//! - `remote.rs`:连远端 Rust bridge(Phase 11.3)

pub mod local;
pub mod remote;
pub mod ssh_tunnel;

pub use local::LocalTransport;
pub use remote::{
    start_background_tasks as start_remote_tasks, RemoteConfig, RemoteTransport, SshSpec,
};
