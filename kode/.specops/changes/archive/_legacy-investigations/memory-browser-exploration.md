# Memory Browser 代码探索结果

## 项目结构概览
- **前端**: apps/gui/src/ (SvelteKit)
- **后端 (Tauri)**: apps/gui/src-tauri/src/
- **核心库**: crates/kode-memory/src/
- **时间框架**: Phase 10.9-13 (2026-06 最新)

## 前端 Svelte 组件

### 1. MemoryBrowsePanel.svelte
**路径**: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/MemoryBrowsePanel.svelte`

**功能**: 浏览/搜索已审核的 fact 池(已 approve 的)
- 左侧搜索框 + 过滤条件(scope / kind / subsystem)
- 中间结果列表(snippet + 得分)  
- 右侧详情页(使用 MemoryFactDetail)
- 支持 BM25 搜索 + 按 created 倒序列表(list_recent)
- 反馈环:点击 hit → memory_bump_recall(记录 click_count)

**关键状态**:
```typescript
query: string
scope: string
kinds: string[] // ALL_KINDS = ['gotcha', 'invariant', 'recipe', 'dead_end', 'preference']
subsystem: string
includeDeprecated: boolean
hits: MemorySearchHit[]
selectedId: string | null
isRecentMode: boolean // empty query 用 list_recent 兜底
```

**交互**:
- 快捷键: Esc(关闭), Cmd+K(聚焦搜索), Arrow Up/Down / j/k(列表导航)
- 点击 hit → selectHit() → bump_recall()
- Deprecate 按钮 → inline reason 输入 → deprecate()

---

### 2. MemoryPanel.svelte  
**路径**: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/MemoryPanel.svelte`

**功能**: 待审队列(review queue) - M4 集成核心
- 列表: pending fact 列表
- 详情区: frontmatter chips(kind/scope/subsystem/tags/confidence) + body
- 编辑模式: edit_then_approve 路径(改 body/tags/scope/confidence + 链接)
- 动作: Approve / Edit+Approve / Reject / Blacklist(各含 inline reason)

**关键 DTO**:
```typescript
MemoryPending {
  id: string              // ULID
  author: string
  session: string | null
  scope: string           // e.g. "project:kode"
  created: string         // RFC3339
  confidence: f32
  tags: string[]
  kind: string            // "gotcha" | "recipe" | ...
  subsystem: string | null
  supersedes: string | null
  body: string
  rationale: string | null  // 提议者说明
  author_energy: f32      // 实时能量值
}
```

**交互**:
- 快捷键: j/k(上下), Enter(批准), e(编辑), r(拒绝)
- edit_then_approve: 收集 editRelated[] / editContradicts[](RelatedFactPicker 助力)
- review() 走 VerdictDto → 后端同步扣/加能量

---

### 3. MemoryFactDetail.svelte
**路径**: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/MemoryFactDetail.svelte`

**功能**: 单条 fact 详情展示(复用于 Browse 和 Review)
- frontmatter: id/author/created/kind/scope/subsystem/confidence/tags/applies_to
- body: pre 标签呈现
- 链接区(supersedes/related/contradicts) - 点击可切换详情
- 反链区(backlinks) - 谁引用了我,可展开/折叠
- dead_end 特殊字段: tried / failed_because / use_instead

**Props**:
```typescript
factId: string
onLink?: (id: string) => void  // 点击链接的回调
```

---

### 4. MemoryMcpBanner.svelte
**路径**: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/MemoryMcpBanner.svelte`

**功能**: 引导用户接入 kode-memory MCP
- 显示位置: App.svelte main 区顶部
- 三种模式:
  1. success: 显示"已自动接入 X / Y"(2.4s 后自隐)
  2. binary-missing: 提示 cargo install 命令
  3. normal: 列出待启用 backend(codebuddy / claude-internal 各按钮)

**决策逻辑** (should_prompt):
- 装了的 backend 全都已配置 → 不显示
- 一个 backend 都没装 → 不显示  
- dismissed_at 有值 → 不显示(用户点过"不再提示")
- 否则显示

---

## 后端 Rust 代码

### 1. apps/gui/src-tauri/src/memory.rs (600+ 行)
**主要职责**: GUI memory review queue 后端

**关键结构**:
```rust
pub struct MemoryHandle {
    pub root: PathBuf,                              // ~/.kode-memory
    pub store: Mutex<MemoryStore>,                  // SQLite + vault/ 文件
    pub budget: Mutex<BudgetStore>,                 // 能量账本
    pub metrics_cache: Mutex<Option<(Instant, MetricsSummaryDto)>>,  // 30s 缓存
}
```

**DTO 类型**:
- `PendingDto`: pending fact 序列化版
- `FactDto`: 单条 fact (deprecated 时 body 清空)
- `SearchHitDto`: 搜索结果(id/author/scope/kind/subsystem/created/confidence/tags/snippet/score)
- `BacklinkDto`: 反链单条
- `FactWithBacklinksDto`: fact + backlinks 列表
- `VerdictDto`: 用户判决(approve / edit_then_approve / reject / blacklist)
- `MemoryStats`: 统计(pending/facts/root)
- `ReviewResult`: 审核结果(outcome/author_energy/remaining_pending)

**Tauri Commands**:
```rust
memory_list_pending()           // 拉 pending 列表
memory_stats()                  // 统计
memory_review(id, verdict)      // 审核一条(同步能量)
memory_search(args)             // BM25 搜索
memory_list_recent(scope?, limit?)  // 最近列表(兜底)
memory_read_with_backlinks(id)  // 读 fact + 反链
memory_deprecate(id, reason)    // 标记 deprecated
memory_bump_recall(id, query?)  // 记录 click(用于排名提升)
memory_metrics_summary()        // 7 天聚合统计
```

**后台任务**:
- `spawn_pending_watcher`: 1.5s 轮询 count_pending(),变化时 emit 事件
- `spawn_recall_aggregator`: 1 小时聚合 recall_clicked 事件到 SQLite

---

### 2. apps/gui/src-tauri/src/memory_mcp.rs (800+ 行)
**主要职责**: Memory MCP 自动检测 + 一键配置

**核心功能**:
1. **二进制查找** (resolve_binary): 
   - (1) 同 GUI 目录(Tauri sidecar)
   - (2) PATH 查找
   - (3) 仓库 target/release|debug 兜底

2. **数据驱动 setup** (run_setup_for_backend):
   - McpSetupSpec::Codebuddy: `<cli> mcp add -s user memory <bin> -e KEY=val`
   - McpSetupSpec::Claude: `<cli> mcp add -s user memory -e KEY=val -- <bin>`
   - McpSetupSpec::JsonMerge: 直接读/写 JSON 配置文件

3. **检测逻辑** (probe):
   - 遍历所有 backend,检查 command_available / setup_cli_available / configured
   - 返回 CheckResult(binary_available / 各 backend 的 BackendStatus)

4. **启动自动 setup** (spawn_startup_probe):
   - 800ms 后启动,遍历所有声明 mcp_setup 的 backend
   - 成功 → emit `memory-mcp-auto-configured` 事件
   - 失败 → emit `memory-mcp-setup-required` 事件展示错原因

**DTO 类型**:
```rust
pub struct CheckResult {
    binary_available: bool,
    binary_path: Option<String>,
    codebuddy_available: bool,
    configured_for_codebuddy: bool,
    claude_internal_available: bool,
    configured_for_claude_internal: bool,
    dismissed_at: Option<i64>,
    memory_root: String,
    backends: BTreeMap<String, BackendStatus>,  // 2026-06 新增
}

pub struct BackendStatus {
    command_available: bool,
    setup_cli_available: Option<bool>,
    configured: bool,
    setup_style: String,  // "codebuddy" / "claude" / "json-merge"
}

pub struct AutoSetupOutcome {
    backend: String,
    success: bool,
    error: Option<String>,
}

pub struct AutoSetupReport {
    check: CheckResult,
    attempts: Vec<AutoSetupOutcome>,
}
```

---

## 核心库: crates/kode-memory/

### 1. fact.rs (400 行)
**数据模型**: Fact 的结构 + markdown (de)serialization

**关键枚举**:
```rust
pub enum Scope {
    Global,
    Project(String),        // project:slug
    Shared,
}

pub enum Kind {
    Gotcha,         // 默认:踩坑/注意
    Invariant,      // 不变量
    Recipe,         // 配方
    DeadEnd,        // 失败方案
    Preference,     // 用户偏好
}
```

**FactMeta 字段** (~40 个):
```rust
pub id: String,
pub author: String,
pub scope: String,
pub created: String,   // RFC3339
pub confidence: f32,   // 默认 0.8
pub tags: Vec<String>,
pub kind: Kind,        // 默认 gotcha
pub subsystem: Option<String>,
pub applies_to: Vec<String>,           // glob 路径列表
pub related: Vec<String>,              // ULID 链接
pub contradicts: Vec<String>,          // 冲突 fact
pub supersedes: Option<String>,        // 覆盖旧 fact
pub tried: Option<String>,             // dead_end 特有
pub failed_because: Option<String>,    // dead_end 特有
pub use_instead: Option<String>,       // dead_end 特有
pub deprecated: bool,
```

**文件格式**:
```markdown
---
<yaml frontmatter>
---
<body>
```

---

### 2. store.rs (核心层,1500+ 行)
**职责**: 文件系统 + SQLite FTS5 索引管理

**目录布局** (Obsidian-compat):
```
<root>/
  vault/
    facts/<id>.md           ← source of truth
    pending/<id>.md
  .kode/
    index.sqlite            ← FTS5 索引
    budget.json             ← 能量账本
    metrics.jsonl           ← 事件流
    archive/rejected/
    tmp/                    ← 原子写暂存
```

**关键数据结构**:
```rust
pub struct SearchHit {
    pub id: String,
    pub author: String,
    pub scope: String,
    pub kind: String,
    pub subsystem: Option<String>,
    pub created: String,
    pub confidence: f32,
    pub tags: Vec<String>,
    pub snippet: String,
    pub score: f32,         // BM25 分数
}

pub struct SearchOpts<'a> {
    pub query: &'a str,
    pub top_k: usize,
    pub scope: Option<&'a str>,
    pub kinds: Vec<Kind>,
    pub subsystem: Option<&'a str>,
    pub include_deprecated: bool,
    pub current_path: Option<&'a str>,  // applies_to 加分
}

pub struct Backlink {
    pub id: String,
    pub kind: String,       // "supersedes" | "related" | "contradicts"
    pub snippet: String,
}

pub struct FactWithBacklinks {
    pub fact: Fact,
    pub backlinks: Vec<Backlink>,
}

pub enum Verdict {
    Approve,
    EditThenApprove { body, tags, scope, confidence, related, contradicts },
    Reject { reason: String },
    Blacklist { reason: String },
}

pub struct DuplicateInfo {
    pub existing_id: String,
    pub similarity: f32,
    pub snippet: String,
    pub candidates: Vec<DuplicateCandidate>,  // top-5 相似
}
```

**检索**:
- 完全相同 body → 路径 A(hash 查表)
- FTS5 BM25 + 相似度加权:
  - bm25 × 0.55 + confidence × 0.15 + recall × 0.10 + recency × 0.10 + path × 0.10
  - 阈值: 0.75(从 0.50 提升,2026-06 优化)
- 路径匹配 (applies_to glob) → ×1.3 加分

---

### 3. budget.rs
**能量账本**: agent 能量计费 + refill

**成本**:
- COST_PROPOSE: 0.2 (提议消耗)
- REWARD_APPROVE: 0.5 (批准奖励)
- PENALTY_REJECT: -1.0 (拒绝罚)
- PENALTY_BLACKLIST: -2.0 (黑名单罚)

---

### 4. metrics.rs / prompt.rs
- **metrics.rs**: 7 天聚合(today_proposes / accept_rate / by_author)
- **prompt.rs**: 生成注入给 agent 的 memory prompt

---

## 前端 IPC 接口 (ipc.ts)

### Memory Review Queue API
```typescript
memoryIpc = {
  listPending(): Promise<MemoryPending[]>,
  stats(): Promise<MemoryStats>,
  review(id, verdict): Promise<MemoryReviewResult>,
  propose(args): Promise<string>,
  onPendingCount(cb): Promise<UnlistenFn>,
  
  // 搜索 + 浏览
  search(args): Promise<MemorySearchHit[]>,
  listRecent(opts?): Promise<MemorySearchHit[]>,
  readWithBacklinks(id): Promise<MemoryFactWithBacklinks>,
  deprecate(id, reason): Promise<void>,
  bumpRecall(id, query?): Promise<void>,
  metricsSummary(): Promise<MemoryMetricsSummary>,
  
  // 状态持久化
  browseStateGet(): Promise<BrowseFilterState | null>,
  browseStateSet(state): Promise<void>,
}
```

### Memory MCP Setup API  
```typescript
memoryMcpIpc = {
  check(): Promise<MemoryMcpCheckResult>,
  setupCodebuddy(): Promise<void>,
  setupClaudeInternal(): Promise<void>,
  dismiss(): Promise<void>,
  onSetupRequired(cb): Promise<UnlistenFn>,
  onChanged(cb): Promise<UnlistenFn>,
  onAutoConfigured(cb): Promise<UnlistenFn>,
  
  promptStatus(): Promise<{enabled, preview, preview_bytes}>,
  promptSetEnabled(enabled): Promise<void>,
}
```

---

## 文件路径总结

### 前端 Svelte 组件
1. `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/MemoryBrowsePanel.svelte`
2. `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/MemoryPanel.svelte`
3. `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/MemoryFactDetail.svelte`
4. `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/MemoryMcpBanner.svelte`

### 后端 Rust 代码
1. `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src-tauri/src/memory.rs`
2. `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src-tauri/src/memory_mcp.rs`

### 核心库
1. `/Users/marxwang/Projects/youtu/app/nocode/crates/kode-memory/src/fact.rs`
2. `/Users/marxwang/Projects/youtu/app/nocode/crates/kode-memory/src/store.rs`
3. `/Users/marxwang/Projects/youtu/app/nocode/crates/kode-memory/src/budget.rs`
4. `/Users/marxwang/Projects/youtu/app/nocode/crates/kode-memory/src/metrics.rs`
5. `/Users/marxwang/Projects/youtu/app/nocode/crates/kode-memory/src/prompt.rs`

### IPC 接口定义
1. `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/ipc.ts`

---

## 核心交互流程

### 1. Browse Facts (搜索已审核)
```
用户 → MemoryBrowsePanel.search()
  → memoryIpc.search() / listRecent()
  → 后端 memory_search / memory_list_recent
  → 返回 SearchHit[] (BM25 排序)
用户点击 → selectHit()
  → MemoryFactDetail(factId)
  → memoryIpc.readWithBacklinks()
  → 显示详情 + 反链
用户点 Deprecate
  → memoryIpc.deprecate(id, reason)
  → 标记 deprecated
```

### 2. Review Queue (待审)
```
用户打开 MemoryPanel
  → memoryIpc.listPending()
  → 后端 memory_list_pending() + memory_stats()
  → 展示列表
用户选项:
  a) 直接批准 → memoryIpc.review({kind: 'approve'})
  b) 编辑后批准 → collect editBody/editTags/editScope + related/contradicts
     → memoryIpc.review({kind: 'edit_then_approve', ...})
  c) 拒绝 → memoryIpc.review({kind: 'reject', reason})
  d) 黑名单 → memoryIpc.review({kind: 'blacklist', reason})
```

### 3. MCP 自动配置
```
GUI 启动
  → 800ms 后 spawn_startup_probe() 启动
  → probe() 检测 binary_available / 各 backend.configured
  → 如未配置 → run_setup_for_backend()
    → 按 spec type 调相应 CLI (codebuddy / claude mcp add)
    → 成功 → emit memory-mcp-auto-configured
    → 失败 → emit memory-mcp-setup-required (展示错原因)
前端 MemoryMcpBanner 监听事件 → 动态显示横幅
```

---

## 数据驱动特性 (2026-06 新增)

Backend 配置可声明 `mcp_setup`:
```toml
[backends.codebuddy]
mcp_setup.style = "codebuddy"
mcp_setup.cli = "codebuddy"

[backends.claude-internal]
mcp_setup.style = "claude"
mcp_setup.cli = "claude-internal"

[backends.some-new-backend]
mcp_setup.style = "json-merge"
mcp_setup.config_path = "~/.some-backend/config.json"
```

后端自动遍历所有 mcp_setup 的 backend,逐个配置 → 新增 backend 无需改代码。

