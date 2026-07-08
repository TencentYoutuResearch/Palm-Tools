//! M4:GUI memory review queue —— 给前端按 Cmd+Shift+M 打开的待审面板撑后端。
//!
//! 设计要点:
//!
//! 1. **共享 root**:默认 `~/.kode-memory`,可被 env `KODE_MEMORY_ROOT` 覆盖。
//!    与 `kode-memory` CLI / MCP 子进程是同一份数据,所以 agent 在另一个进程
//!    里 propose,这边 GUI 即时(下次轮询)能看到。
//!
//! 2. **MemoryStore 串行**:整个 store 塞进 `tokio::sync::Mutex`,所有 review /
//!    propose / list 命令都拿一次锁。这是 `kode-memory` 当前的并发模型 ——
//!    `propose` 重复检测 + `commit_to_facts` 内部用 SQLite transaction,本身
//!    就要求单写者。
//!
//! 3. **后台 watcher**:每 1.5s 拍一次 pending 数,变化才 emit `memory-pending`
//!    事件给前端。为了让 sidebar/状态栏 badge 即时刷新而不必前端忙轮询。
//!    (后续可改 notify crate 监听 vault/pending 目录,但 1.5s polling 在
//!    单机本地路径下成本低于 `inotify` watcher 的实现复杂度。)
//!
//! 4. **能量账本同步**:review 路径走完(approve / reject / blacklist)后
//!    同事务给作者扣/加能量,前端读到的 budget 数永远跟 review 状态对齐。
//!    (这条遵循 CLAUDE.md "能量点变化必须事件驱动,不要批量/异步"。)

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use kode_memory::{
    budget::{BudgetStore, COST_PROPOSE, PENALTY_BLACKLIST, PENALTY_REJECT, REWARD_APPROVE},
    git_sync,
    store::{
        Backlink, FactWithBacklinks, PendingFact, ReviewOutcome, SearchHit, SearchOpts, Verdict,
    },
    Fact, Kind, MemoryStore, Scope,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// 解析 memory root —— 与 `kode-memory/bin/cli.rs::resolve_root` 同语义。
/// env > 默认 `~/.kode-memory`。失败时 fallback 到当前目录下 `.kode-memory`,
/// 这样开发期没设 $HOME 也不会 panic。
pub fn resolve_memory_root() -> PathBuf {
    if let Ok(p) = std::env::var("KODE_MEMORY_ROOT") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".kode-memory");
    }
    PathBuf::from(".kode-memory")
}

/// 后端持有的 memory 状态:store + budget,各自一把锁(并发审两条不会互相挡死)。
/// AppState 里以 `Arc<MemoryHandle>` 形式传。
pub struct MemoryHandle {
    pub root: PathBuf,
    pub store: Mutex<MemoryStore>,
    pub budget: Mutex<BudgetStore>,
    /// metrics summary 30s 缓存。hover 卡片每次 hover 都重算太浪费,
    /// 实测 aggregate_7d 在中等量级下 < 5ms,但用户连续 hover 多次仍想短路一下。
    pub metrics_cache: Mutex<Option<(Instant, MetricsSummaryDto)>>,
}

impl MemoryHandle {
    pub fn open() -> Result<Arc<Self>> {
        let root = resolve_memory_root();
        std::fs::create_dir_all(&root)
            .with_context(|| format!("create memory root {}", root.display()))?;
        let store = MemoryStore::open(&root).context("open MemoryStore")?;
        let budget = BudgetStore::open(&root).context("open BudgetStore")?;
        Ok(Arc::new(Self {
            root,
            store: Mutex::new(store),
            budget: Mutex::new(budget),
            metrics_cache: Mutex::new(None),
        }))
    }
}

// ============== 前端 DTO ==============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingDto {
    pub id: String,
    pub author: String,
    pub session: Option<String>,
    pub scope: String,
    pub created: String,
    pub confidence: f32,
    pub tags: Vec<String>,
    pub kind: String,
    pub subsystem: Option<String>,
    pub supersedes: Option<String>,
    pub body: String,
    pub rationale: Option<String>,
    /// 当前作者剩余能量(approve/reject 之后会变;前端展示 "agent 还剩 X 点")
    pub author_energy: f32,
}

impl PendingDto {
    pub fn new(p: PendingFact, energy: f32) -> Self {
        Self {
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
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryStats {
    pub pending: usize,
    pub facts: i64,
    pub root: String,
}

/// 用户在 GUI 里下达的判决。
/// 与 `kode_memory::Verdict` 语义一一对应,中间 DTO 是为了避免 enum tagged 序列化
/// 直接暴露 internal 类型给前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VerdictDto {
    Approve,
    EditThenApprove {
        body: Option<String>,
        tags: Option<Vec<String>>,
        scope: Option<String>,
        confidence: Option<f32>,
        /// Phase 10.10:edit-then-approve 时由 RelatedFactPicker 收集的 related ULID
        #[serde(default)]
        related: Option<Vec<String>>,
        #[serde(default)]
        contradicts: Option<Vec<String>>,
        /// 2026-07+:编辑后的标题
        #[serde(default)]
        title: Option<String>,
    },
    Reject {
        reason: String,
    },
    Blacklist {
        reason: String,
    },
}

impl VerdictDto {
    pub fn into_verdict(self) -> Result<Verdict> {
        Ok(match self {
            VerdictDto::Approve => Verdict::Approve,
            VerdictDto::EditThenApprove {
                body,
                tags,
                scope,
                confidence,
                related,
                contradicts,
                title,
            } => Verdict::EditThenApprove {
                body,
                tags,
                scope: scope.map(|s| Scope::parse(&s)).transpose()?,
                confidence,
                related,
                contradicts,
                title,
            },
            VerdictDto::Reject { reason } => Verdict::Reject { reason },
            VerdictDto::Blacklist { reason } => Verdict::Blacklist { reason },
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewResult {
    pub outcome: String, // "approved" / "rejected" / "blacklisted"
    pub author_energy: f32,
    pub remaining_pending: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct FactDto {
    pub id: String,
    pub author: String,
    pub scope: String,
    pub kind: String,
    pub subsystem: Option<String>,
    pub created: String,
    pub confidence: f32,
    pub tags: Vec<String>,
    pub deprecated: bool,
    pub body: String,
    /// Phase 10.10:链字段(给详情页直接显示)
    pub supersedes: Option<String>,
    pub related: Vec<String>,
    pub contradicts: Vec<String>,
    pub applies_to: Vec<String>,
    /// Phase 10.11 dead_end 字段(只在 kind == "dead_end" 时有意义)
    pub tried: Option<String>,
    pub failed_because: Option<String>,
    pub use_instead: Option<String>,
}

impl FactDto {
    fn from(f: Fact) -> Self {
        let body = if f.meta.deprecated {
            String::new()
        } else {
            f.body
        };
        Self {
            id: f.meta.id,
            author: f.meta.author,
            scope: f.meta.scope,
            kind: f.meta.kind.as_str().to_string(),
            subsystem: f.meta.subsystem,
            created: f.meta.created,
            confidence: f.meta.confidence,
            tags: f.meta.tags,
            deprecated: f.meta.deprecated,
            body,
            supersedes: f.meta.supersedes,
            related: f.meta.related,
            contradicts: f.meta.contradicts,
            applies_to: f.meta.applies_to,
            tried: f.meta.tried,
            failed_because: f.meta.failed_because,
            use_instead: f.meta.use_instead,
        }
    }
}

// ============== Phase 10.9-13 新 DTO ==============

#[derive(Debug, Clone, Serialize)]
pub struct SearchHitDto {
    pub id: String,
    pub author: String,
    pub scope: String,
    pub kind: String,
    pub subsystem: Option<String>,
    pub created: String,
    pub confidence: f32,
    pub tags: Vec<String>,
    pub title: Option<String>,
    pub snippet: String,
    pub body: String,
    pub score: f32,
}

fn search_hit_to_dto(store: &MemoryStore, hit: SearchHit) -> SearchHitDto {
    let body = store
        .read(&hit.id)
        .map(|fact| fact.body)
        .unwrap_or_else(|_| hit.snippet.clone());

    SearchHitDto {
        id: hit.id,
        author: hit.author,
        scope: hit.scope,
        kind: hit.kind,
        subsystem: hit.subsystem,
        created: hit.created,
        confidence: hit.confidence,
        tags: hit.tags,
        title: hit.title,
        snippet: hit.snippet,
        body,
        score: hit.score,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BacklinkDto {
    pub id: String,
    pub kind: String,
    pub snippet: String,
}

impl From<Backlink> for BacklinkDto {
    fn from(b: Backlink) -> Self {
        Self {
            id: b.id,
            kind: b.kind,
            snippet: b.snippet,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FactWithBacklinksDto {
    pub fact: FactDto,
    pub backlinks: Vec<BacklinkDto>,
}

impl From<FactWithBacklinks> for FactWithBacklinksDto {
    fn from(f: FactWithBacklinks) -> Self {
        Self {
            fact: FactDto::from(f.fact),
            backlinks: f.backlinks.into_iter().map(BacklinkDto::from).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EnergyEntryDto {
    pub author: String,
    pub energy: f32,
    pub max: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthorAcceptDto {
    pub author: String,
    pub accepts: u64,
    pub total_reviews: u64,
    pub rate: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsSummaryDto {
    /// 今日(UTC 0 点至今)的 propose 总数
    pub today_proposes: u64,
    /// 7 天总接受率(approve+edit-then-approve / 所有 review),无数据为 None
    pub accept_rate_7d: Option<f32>,
    /// 7 天 review 总数(给 hover 卡片显示分母信心)
    pub total_reviews_7d: u64,
    /// 按 author 分组(字典序)
    pub by_author: Vec<AuthorAcceptDto>,
    /// 各 author 当前能量(已 refill)
    pub energy_by_author: Vec<EnergyEntryDto>,
}

// ============== Tauri commands ==============

/// 拉一次 pending 列表 + 全局统计。前端打开面板时和事件刷新时调用。
#[tauri::command]
pub async fn memory_list_pending(
    handle: State<'_, Arc<MemoryHandle>>,
) -> Result<Vec<PendingDto>, String> {
    let h = handle.inner().clone();
    let pending = {
        let store = h.store.lock().await;
        store.list_pending().map_err(err_to_string)?
    };
    let mut budget = h.budget.lock().await;
    let out = pending
        .into_iter()
        .map(|p| {
            let energy = budget.current_energy(&p.meta.author);
            PendingDto::new(p, energy)
        })
        .collect();
    Ok(out)
}

#[tauri::command]
pub async fn memory_stats(handle: State<'_, Arc<MemoryHandle>>) -> Result<MemoryStats, String> {
    let h = handle.inner().clone();
    let store = h.store.lock().await;
    let pending = store.count_pending().map_err(err_to_string)?;
    let facts = store.count().map_err(err_to_string)?;
    Ok(MemoryStats {
        pending,
        facts,
        root: h.root.display().to_string(),
    })
}

/// 审一条 pending。同事务联动 budget(approve +0.5 / reject -1 / blacklist -2)。
#[tauri::command]
pub async fn memory_review(
    handle: State<'_, Arc<MemoryHandle>>,
    app: AppHandle,
    id: String,
    verdict: VerdictDto,
) -> Result<ReviewResult, String> {
    let h = handle.inner().clone();
    let v = verdict.into_verdict().map_err(err_to_string)?;
    let (outcome, author) = {
        let mut store = h.store.lock().await;
        // 先读 pending 拿 author(review 后 pending 文件就被移走了)
        let p = store.read_pending(&id).map_err(err_to_string)?;
        let author = p.meta.author.clone();
        let outcome = store.review(&id, v).map_err(err_to_string)?;
        (outcome, author)
    };
    let energy = {
        let mut budget = h.budget.lock().await;
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
    let remaining = {
        let store = h.store.lock().await;
        store.count_pending().map_err(err_to_string)?
    };
    // 让 sidebar/状态栏立刻刷新 — watcher 1.5s 才下次轮询,review 高频时太慢
    let _ = app.emit("memory-pending", remaining as u64);

    // best-effort git sync:approve 后异步 push(不阻塞前端返回)
    if matches!(outcome, ReviewOutcome::Approved) {
        let h2 = h.clone();
        let id2 = id.clone();
        tauri::async_runtime::spawn(async move {
            if git_sync::is_enabled(&h2.root) {
                let msg = format!("kode-memory: approve {}", id2);
                if let Err(e) = git_sync::commit_and_push(&h2.root, &msg) {
                    tracing::warn!("memory.git_sync commit_and_push failed: {}", e);
                }
            }
        });
    }

    Ok(ReviewResult {
        outcome: match outcome {
            ReviewOutcome::Approved => "approved",
            ReviewOutcome::Rejected => "rejected",
            ReviewOutcome::Blacklisted => "blacklisted",
        }
        .to_string(),
        author_energy: energy,
        remaining_pending: remaining,
    })
}

/// 给定 fact id,取完整 fact(供 supersedes 链溯源时展示老条目)。
#[tauri::command]
pub async fn memory_read_fact(
    handle: State<'_, Arc<MemoryHandle>>,
    id: String,
) -> Result<FactDto, String> {
    let h = handle.inner().clone();
    let store = h.store.lock().await;
    let f = store.read(&id).map_err(err_to_string)?;
    Ok(FactDto::from(f))
}

/// 用户从 GUI 直接录一条(走 propose 路径,与 agent 走同一队列)。
/// author 默认填 "user" — 用户手动输入的视为高置信度,但仍要审。
#[derive(Debug, Clone, Deserialize)]
pub struct ProposeArgs {
    pub author: Option<String>,
    pub scope: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub rationale: Option<String>,
    pub confidence: Option<f32>,
    /// 跳过 FTS 近似查重(完全相同仍会拦)。仅在确认 candidates 是不同规则时才传 true。
    #[serde(default)]
    pub force: bool,
    /// 让前端显式触发"替换"路径:旧 fact 的 id
    #[serde(default)]
    pub supersedes: Option<String>,
    /// fact 种类:gotcha / invariant / recipe / dead_end / preference(默认 gotcha)
    #[serde(default)]
    pub kind: Option<String>,
}

#[tauri::command]
pub async fn memory_propose(
    handle: State<'_, Arc<MemoryHandle>>,
    app: AppHandle,
    args: ProposeArgs,
) -> Result<String, String> {
    let h = handle.inner().clone();
    let scope = Scope::parse(&args.scope).map_err(err_to_string)?;
    let kind = args
        .kind
        .as_deref()
        .map(Kind::parse)
        .transpose()
        .map_err(err_to_string)?;
    let author = args.author.unwrap_or_else(|| "user".into());
    // 用户手录视同 agent 提议:扣能量(防止前端写脚本爆刷),duplicate 时不扣
    {
        let mut budget = h.budget.lock().await;
        budget
            .try_charge(&author, COST_PROPOSE)
            .map_err(|e| format!("budget: {:?}", e))?;
    }
    let result = {
        let mut store = h.store.lock().await;
        store
            .propose(
                &author,
                None,
                scope,
                &args.body,
                args.tags,
                args.supersedes,
                args.confidence,
                args.rationale,
                args.force,
                kind,
                None,
            )
            .map_err(err_to_string)?
    };
    use kode_memory::store::ProposeResult;
    match result {
        ProposeResult::Accepted { id } => {
            let pending_count = {
                let store = h.store.lock().await;
                store.count_pending().map_err(err_to_string)?
            };
            let _ = app.emit("memory-pending", pending_count as u64);
            Ok(id)
        }
        ProposeResult::Duplicate(info) => {
            // 退还能量
            let _ = h.budget.lock().await.add(&author, COST_PROPOSE);
            // 序列化 candidates 让前端展示;前端拿到后可触发 force / supersedes 重试
            let payload = serde_json::json!({
                "kind": "duplicate",
                "existing_id": info.existing_id,
                "similarity": info.similarity,
                "snippet": info.snippet,
                "candidates": info.candidates,
            });
            Err(payload.to_string())
        }
        ProposeResult::BodyTooLong { len, max } => {
            let _ = h.budget.lock().await.add(&author, COST_PROPOSE);
            Err(format!("body too long: {} > {}", len, max))
        }
    }
}

fn err_to_string(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ============== Phase 10.9-13 新命令 ==============

/// Phase 10.12+10.13:全功能搜索。前端 Browse 面板用。
#[derive(Debug, Clone, Deserialize)]
pub struct SearchArgs {
    pub query: String,
    #[serde(default)]
    pub scope: Option<String>,
    /// 字符串数组,会按 Kind::parse 解析,无法识别的项忽略
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub subsystem: Option<String>,
    #[serde(default)]
    pub include_deprecated: bool,
    #[serde(default = "default_top_k")]
    pub top_k: usize,
    #[serde(default)]
    pub current_path: Option<String>,
}

fn default_top_k() -> usize {
    20
}

#[tauri::command]
pub async fn memory_search(
    handle: State<'_, Arc<MemoryHandle>>,
    args: SearchArgs,
) -> Result<Vec<SearchHitDto>, String> {
    let h = handle.inner().clone();
    let kinds: Vec<Kind> = args
        .kinds
        .iter()
        .filter_map(|s| Kind::parse(s).ok())
        .collect();
    let store = h.store.lock().await;
    let opts = SearchOpts {
        query: &args.query,
        top_k: args.top_k.max(1),
        scope: args.scope.as_deref(),
        kinds,
        subsystem: args.subsystem.as_deref(),
        include_deprecated: args.include_deprecated,
        current_path: args.current_path.as_deref(),
    };
    let hits = store.search_with_opts(&opts).map_err(err_to_string)?;
    Ok(hits
        .into_iter()
        .map(|h| search_hit_to_dto(&store, h))
        .collect())
}

/// Phase 10.10:读 fact + 反链。给详情页用。
#[tauri::command]
pub async fn memory_read_with_backlinks(
    handle: State<'_, Arc<MemoryHandle>>,
    id: String,
) -> Result<FactWithBacklinksDto, String> {
    let h = handle.inner().clone();
    let store = h.store.lock().await;
    let r = store.read_with_backlinks(&id).map_err(err_to_string)?;
    Ok(FactWithBacklinksDto::from(r))
}

/// 用户从 GUI 直接 deprecate 一条 fact。文件 + SQLite 同步标记。
#[tauri::command]
pub async fn memory_deprecate(
    handle: State<'_, Arc<MemoryHandle>>,
    id: String,
    reason: String,
) -> Result<(), String> {
    let h = handle.inner().clone();
    let mut store = h.store.lock().await;
    store.deprecate(&id, &reason).map_err(err_to_string)
}

/// 用户在 Browse 面板修改已 approve fact 的 scope(例如提升为 global 跨项目共享)。
#[tauri::command]
pub async fn memory_update_scope(
    handle: State<'_, Arc<MemoryHandle>>,
    id: String,
    scope: String,
) -> Result<(), String> {
    let new_scope = Scope::parse(&scope).map_err(err_to_string)?;
    let h = handle.inner().clone();
    let mut store = h.store.lock().await;
    store.update_scope(&id, new_scope).map_err(err_to_string)
}

/// Phase 10.13:用户在 Browse 点击了某条 hit = 反馈"这条有用",
/// 写 SQLite + metrics.jsonl(后台聚合 task 也读同一份)。
#[tauri::command]
pub async fn memory_bump_recall(
    handle: State<'_, Arc<MemoryHandle>>,
    id: String,
    query: Option<String>,
) -> Result<(), String> {
    let h = handle.inner().clone();
    let mut store = h.store.lock().await;
    store
        .bump_recall(&id, query.as_deref())
        .map_err(err_to_string)
}

/// Browse 面板空 query 时的「最近 fact」列表。按 created 倒序,默认 20 条。
/// 等价于 CLI `kode-memory recent` 但走 SearchHitDto 复用前端类型。
#[tauri::command]
pub async fn memory_list_recent(
    handle: State<'_, Arc<MemoryHandle>>,
    scope: Option<String>,
    since_hours: Option<u64>,
    limit: Option<usize>,
) -> Result<Vec<SearchHitDto>, String> {
    let h = handle.inner().clone();
    let store = h.store.lock().await;
    // since_hours 默认 30 天 — 让池子小的用户也能看到东西
    let since = since_hours.unwrap_or(24 * 30);
    let hits = store
        .list_recent(scope.as_deref(), since)
        .map_err(err_to_string)?;
    let lim = limit.unwrap_or(20);
    Ok(hits
        .into_iter()
        .take(lim)
        .map(|h| search_hit_to_dto(&store, h))
        .collect())
}

/// Browse 面板「按项目过滤」下拉:列出所有非 deprecated fact 出现过的 distinct scope。
#[tauri::command]
pub async fn memory_list_scopes(
    handle: State<'_, Arc<MemoryHandle>>,
) -> Result<Vec<String>, String> {
    let h = handle.inner().clone();
    let store = h.store.lock().await;
    store.distinct_scopes().map_err(err_to_string)
}

/// 状态栏 hover 卡片用的小聚合。30s 缓存。
#[tauri::command]
pub async fn memory_metrics_summary(
    handle: State<'_, Arc<MemoryHandle>>,
) -> Result<MetricsSummaryDto, String> {
    let h = handle.inner().clone();

    // Cache hit?
    {
        let cache = h.metrics_cache.lock().await;
        if let Some((t, dto)) = cache.as_ref() {
            if t.elapsed() < Duration::from_secs(30) {
                return Ok(dto.clone());
            }
        }
    }

    let agg = {
        let store = h.store.lock().await;
        store.metrics().aggregate_7d().map_err(err_to_string)?
    };
    let energy_by_author: Vec<EnergyEntryDto> = {
        let mut budget = h.budget.lock().await;
        budget
            .iter_authors()
            .into_iter()
            .map(|(author, energy)| EnergyEntryDto {
                author,
                energy,
                max: BudgetStore::max_energy(),
            })
            .collect()
    };
    let mut by_author: Vec<AuthorAcceptDto> = agg
        .by_author_accept_rate
        .into_iter()
        .map(|(author, s)| AuthorAcceptDto {
            author,
            accepts: s.accepts,
            total_reviews: s.total_reviews,
            rate: s.rate,
        })
        .collect();
    by_author.sort_by(|a, b| a.author.cmp(&b.author));
    let total_reviews_7d: u64 = by_author.iter().map(|s| s.total_reviews).sum();

    let dto = MetricsSummaryDto {
        today_proposes: agg.today_proposes,
        accept_rate_7d: agg.accept_rate,
        total_reviews_7d,
        by_author,
        energy_by_author,
    };

    {
        let mut cache = h.metrics_cache.lock().await;
        *cache = Some((Instant::now(), dto.clone()));
    }
    Ok(dto)
}

/// 后台轮询任务:每 1.5s 比对 pending 数,变化时 emit `memory-pending` 事件。
/// 这是事件驱动 sidebar/状态栏 badge 的廉价方案。
pub fn spawn_pending_watcher(handle: Arc<MemoryHandle>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<usize> = None;
        let mut tick = tokio::time::interval(tokio::time::Duration::from_millis(1500));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let count = {
                let store = handle.store.lock().await;
                match store.count_pending() {
                    Ok(n) => n,
                    Err(e) => {
                        tracing::warn!("memory.count_pending failed: {}", e);
                        continue;
                    }
                }
            };
            if last != Some(count) {
                last = Some(count);
                let _ = app.emit("memory-pending", count as u64);
            }
        }
    });
}

/// **Phase 10.13** 后台聚合任务:每 1 小时把 metrics.jsonl 的 recall_clicked 事件
/// UPSERT 进 facts 表,推动「最近被点击的条目排名上升」。GUI 启动时也立刻跑一次,
/// 让重启后立刻有最新数据。
pub fn spawn_recall_aggregator(handle: Arc<MemoryHandle>) {
    tauri::async_runtime::spawn(async move {
        // 启动 5s 后立刻跑一次 — 让重启用户看到最新排名
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        loop {
            {
                let mut store = handle.store.lock().await;
                if let Err(e) = store.aggregate_recall_30d() {
                    tracing::warn!("memory.aggregate_recall_30d failed: {}", e);
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
        }
    });
}

/// **Phase 10.17** 启动同步任务:启动 ~2s 后跑一次 pull→reconcile,之后每 5 分钟
/// pull → reconcile → commit_and_push。commit_and_push 内部在 push 前会先 pull。
/// 首次无 `sync.json` 时,`git_sync::sync()` 会自动建仓库并写默认配置。
pub fn spawn_sync_task(handle: Arc<MemoryHandle>) {
    tauri::async_runtime::spawn(async move {
        // 首次延迟 2s,等 store 和 watcher 都就绪
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        let cfg_path = kode_memory::store::private_dir(&handle.root).join("sync.json");
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(300)); // 5 min
                                                                                         // 第一次 tick 立即触发
        interval.tick().await;

        loop {
            if cfg_path.exists() && !git_sync::is_enabled(&handle.root) {
                interval.tick().await;
                continue;
            }

            {
                let mut store = handle.store.lock().await;
                match git_sync::sync(
                    &mut store,
                    &handle.root,
                    &git_sync::SyncOpts {
                        do_pull: true,
                        do_push: true,
                        message: Some("kode-memory: periodic sync".into()),
                    },
                ) {
                    Ok(report) => {
                        if let Some(reason) = report.skipped_reason {
                            tracing::info!("memory.git_sync periodic skipped: {}", reason);
                        } else {
                            tracing::info!(
                                "memory.git_sync periodic: initialized={} pulled={} pushed={} reconciled={}",
                                report.initialized,
                                report.pulled,
                                report.pushed,
                                report.reconciled
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!("memory.git_sync periodic failed: {}", e);
                    }
                }
            }

            interval.tick().await;
        }
    });
}

// ============== git sync 配置命令 ==============

/// 获取当前 git sync 配置状态。
#[tauri::command]
pub async fn memory_sync_config(
    handle: State<'_, Arc<MemoryHandle>>,
) -> Result<serde_json::Value, String> {
    let h = handle.inner().clone();
    let cfg = git_sync::load_config(&h.root).map_err(|e| e.to_string())?;
    let initialized = git_sync::has_sync_config(&h.root);
    Ok(serde_json::json!({
        "configured": initialized,
        "initialized": initialized,
        "remote": cfg.remote,
        "auto_sync": cfg.auto_sync,
        "auto_push": cfg.auto_push,
        "branch": cfg.branch,
    }))
}

/// 设置 git sync 配置。传 remote 会调 init_repo 设置 remote。
#[derive(Debug, Clone, Deserialize)]
pub struct SyncConfigArgs {
    pub remote: Option<String>,
    pub auto_push: Option<bool>,
    pub auto_sync: Option<bool>,
}

#[tauri::command]
pub async fn memory_sync_config_set(
    handle: State<'_, Arc<MemoryHandle>>,
    args: SyncConfigArgs,
) -> Result<(), String> {
    let h = handle.inner().clone();
    let mut cfg = git_sync::load_config(&h.root).map_err(|e| e.to_string())?;

    if let Some(remote) = args.remote {
        let remote = remote.trim().to_string();
        if !remote.is_empty() && cfg.remote.as_deref() != Some(&remote) {
            let auto_sync = cfg.auto_sync;
            let auto_push = cfg.auto_push;
            git_sync::init_repo(&h.root, &remote, &cfg.branch)
                .map_err(|e| format!("init_repo failed: {e}"))?;
            cfg = git_sync::load_config(&h.root).map_err(|e| e.to_string())?;
            cfg.auto_sync = auto_sync;
            cfg.auto_push = auto_push;
        }
        if remote.is_empty() {
            // 清空 remote
            cfg.remote = None;
        }
    }

    if let Some(v) = args.auto_push {
        cfg.auto_push = v;
    }
    if let Some(v) = args.auto_sync {
        cfg.auto_sync = v;
    }

    git_sync::save_config(&h.root, &cfg).map_err(|e| e.to_string())
}

/// 立即触发一次 git sync(pull → reconcile → push)。
#[derive(Debug, Clone, Deserialize)]
pub struct SyncNowArgs {
    pub remote: Option<String>,
}

#[tauri::command]
pub async fn memory_sync_now(
    handle: State<'_, Arc<MemoryHandle>>,
    args: SyncNowArgs,
) -> Result<serde_json::Value, String> {
    let h = handle.inner().clone();
    let mut store = h.store.lock().await;
    let report = git_sync::sync_once(
        &mut store,
        &h.root,
        &git_sync::SyncOpts {
            do_pull: true,
            do_push: true,
            message: Some("kode-memory: manual sync".into()),
        },
        args.remote.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "pulled": report.pulled,
        "pushed": report.pushed,
        "reconciled": report.reconciled,
        "initialized": report.initialized,
        "skipped_reason": report.skipped_reason,
    }))
}

// ============== 兜底:即使 memory crate 打不开,GUI 也要能起 ==============
//
// 真实路径下 `MemoryHandle::open` 几乎不会失败(只在 ~ 不存在 + 当前目录不可写时崩),
// 但仍给一个 dummy `Result` 包装让 `lib.rs` setup 优雅降级。
pub fn try_open() -> Option<Arc<MemoryHandle>> {
    match MemoryHandle::open() {
        Ok(h) => Some(h),
        Err(e) => {
            tracing::warn!("memory subsystem disabled: {}", e);
            None
        }
    }
}

// ============== Phase 10.18:远端 memory 审核(通过 REST 调远端 server) ==============

/// 从 PersistedEndpoint 解析 base_url + token + SSH 隧道,构建 reqwest client。
/// 复用 endpoints::endpoint_fs_list 的隧道模式。
async fn remote_memory_client(
    endpoint_id: &str,
) -> Result<
    (
        reqwest::Client,
        String,
        Option<crate::transport::ssh_tunnel::SshTunnel>,
    ),
    String,
> {
    let persisted = crate::persistence::load();
    let ep = persisted
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .find(|e| e.id == endpoint_id)
        .ok_or_else(|| format!("endpoint '{endpoint_id}' not found"))?;

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("client build failed: {e}"))?;

    let mut tunnel_guard: Option<crate::transport::ssh_tunnel::SshTunnel> = None;
    let base = if ep.ssh_host.trim().is_empty() {
        ep.base_url.trim_end_matches('/').to_string()
    } else {
        let host = ep.ssh_host.clone();
        let ssh_port = ep.ssh_port;
        let remote_port = if ep.ssh_remote_port == 0 {
            9870
        } else {
            ep.ssh_remote_port
        };
        let t = tokio::task::spawn_blocking(move || {
            crate::transport::ssh_tunnel::SshTunnel::spawn(&host, ssh_port, remote_port)
        })
        .await
        .map_err(|e| format!("ssh tunnel task: {e}"))?
        .map_err(|e| format!("ssh tunnel failed: {e}"))?;
        let local = format!("http://127.0.0.1:{}", t.local_port);
        tunnel_guard = Some(t);
        local
    };

    Ok((http, base, tunnel_guard))
}

/// 远端 pending 列表。
#[tauri::command]
pub async fn memory_list_pending_remote(endpoint_id: String) -> Result<Vec<PendingDto>, String> {
    let (http, base, _tunnel) = remote_memory_client(&endpoint_id).await?;
    let resp = http
        .get(format!("{base}/api/v1/memory/pending"))
        .bearer_auth(
            &crate::persistence::load()
                .endpoints
                .unwrap_or_default()
                .into_iter()
                .find(|e| e.id == endpoint_id)
                .map(|e| e.token)
                .unwrap_or_default(),
        )
        .send()
        .await
        .map_err(|e| format!("memory pending request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("memory pending {status}: {detail}"));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    let arr = body
        .get("pending")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "missing 'pending' array".to_string())?;
    let mut out = Vec::new();
    for item in arr {
        let dto: PendingDto = serde_json::from_value(item.clone())
            .map_err(|e| format!("pending item decode: {e}"))?;
        out.push(dto);
    }
    Ok(out)
}

/// 远端审核。
#[tauri::command]
pub async fn memory_review_remote(
    endpoint_id: String,
    id: String,
    verdict: VerdictDto,
) -> Result<ReviewResult, String> {
    let (http, base, _tunnel) = remote_memory_client(&endpoint_id).await?;
    let token = crate::persistence::load()
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .find(|e| e.id == endpoint_id)
        .map(|e| e.token)
        .unwrap_or_default();
    let body = serde_json::to_value(&verdict).map_err(|e| e.to_string())?;
    let resp = http
        .post(format!("{base}/api/v1/memory/pending/{id}/review"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("memory review request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("memory review {status}: {detail}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    let outcome = v
        .get("outcome")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown")
        .to_string();
    let author_energy = v
        .get("author_energy")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0) as f32;
    Ok(ReviewResult {
        outcome,
        author_energy,
        remaining_pending: 0, // 远端不跟踪
    })
}

/// 远端搜索。
#[tauri::command]
pub async fn memory_search_remote(
    endpoint_id: String,
    query: String,
    scope: Option<String>,
    top_k: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let (http, base, _tunnel) = remote_memory_client(&endpoint_id).await?;
    let token = crate::persistence::load()
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .find(|e| e.id == endpoint_id)
        .map(|e| e.token)
        .unwrap_or_default();
    let mut req = http
        .get(format!("{base}/api/v1/memory/search"))
        .bearer_auth(&token)
        .query(&[("q", query.as_str())]);
    if let Some(s) = &scope {
        req = req.query(&[("scope", s.as_str())]);
    }
    if let Some(k) = top_k {
        req = req.query(&[("top_k", k.to_string().as_str())]);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("memory search request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("memory search {status}: {detail}"));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    let hits = body
        .get("hits")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(hits)
}

/// 远端「最近 fact」列表(Browse 面板远端来源、空 query 默认视图)。
/// 走 bridge GET /api/v1/memory/recent;返回 hit 数组(形态与 search 一致)。
#[tauri::command]
pub async fn memory_list_recent_remote(
    endpoint_id: String,
    scope: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let (http, base, _tunnel) = remote_memory_client(&endpoint_id).await?;
    let token = crate::persistence::load()
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .find(|e| e.id == endpoint_id)
        .map(|e| e.token)
        .unwrap_or_default();
    let mut req = http
        .get(format!("{base}/api/v1/memory/recent"))
        .bearer_auth(&token);
    if let Some(s) = &scope {
        req = req.query(&[("scope", s.as_str())]);
    }
    if let Some(l) = limit {
        req = req.query(&[("limit", l.to_string().as_str())]);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("memory recent request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("memory recent {status}: {detail}"));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    let hits = body
        .get("hits")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(hits)
}
