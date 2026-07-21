//! kode-memory: 多 agent 共享记忆池(prototype)。
//!
//! 设计原则(写在最前面,改之前先读):
//! 1. **append-only**:永不物理删 fact,只 deprecate(SQLite 标记 + 检索过滤)
//! 2. **小而多**:每条 fact 是独立 markdown 文件,supersedes 链接老条目
//! 3. **原子写**:tmp file → fsync → rename → SQLite 同事务 commit;失败可回滚
//! 4. **唯一可变状态**:`MemoryStore` 整个塞在 tokio::Mutex 里,写入天然串行
//!
//! 这是 Phase-C prototype,目标是验证:
//! - 并发写不丢、不冲突
//! - SQLite + 文件系统状态一致
//! - MCP stdio 桥接能跑

pub mod budget;
pub mod codebuddy_hook;
pub mod codex_hook;
pub mod fact;
pub mod git_sync;
pub mod hook_setup;
pub mod metrics;
pub mod prompt;
pub mod store;

pub use budget::{BudgetError, BudgetStore};
pub use fact::{Fact, FactMeta, Kind, Scope};
pub use git_sync::{SyncConfig, SyncReport};
pub use metrics::{Aggregate7d, AuthorAcceptRate, EventKind, MetricsEvent, MetricsLog};
pub use store::{Backlink, FactWithBacklinks, MemoryStore, SearchFilter, SearchHit, SearchOpts};
