---
schema_version: 1
id: memory/git-sync
kind: spec
title: kode-memory git synchronization — decentralized cross-machine vault sync
status: active
verifies:
  - rust
paths:
  - crates/kode-memory/src/git_sync.rs
---

# kode-memory git 同步 — 设计文档

> **目标读者**:接手实现 git sync 的人（包括未来的你或 LLM）。
> **本文是设计共识**。实现前先 review 这一份,有疑问改这里。
> **状态**:设计完成(2026-06-13),待实现。
> **依赖**:本方案建立在 MEMORY_DESIGN.md §3.3 的预言之上——facts/ git-friendly、sqlite 不同步、reconcile 重建。这三条性质是 git sync 的直接基础。

## 0. TL;DR

git 同步 `vault/{facts,pending}/`,走系统 `git` CLI,union-merge 自动合并,approve 后 best-effort push,启动 pull→reconcile 重建索引。**绝不阻塞核心 memory 操作。**

## 1. 决策摘要(用户 2026-06-13 拍板)

| 决策项 | 选择 | 否决项与理由 |
|---|---|---|
| git 操作方式 | 外部 `git` CLI | git2 引入新依赖、凭证/SSH 需自己接 |
| 同步时机 | approve 后 commit+push + 启动 pull(一次) | 定时轮询(不做);D2 git 自动 hook(不够无感) |
| 冲突策略 | union merge 自动合并 | ours/theirs 静默丢数据;人工介入 overkill |
| 配置位置 | `.kode/sync.json` | `.git/config`(不够显式);`config.toml`(没这机制) |
| 中心化 vs 去中心化 | 去中心化(git) | 中心 server(单点/离线不可用);Syncthing(无版本历史) |

## 2. 模块边界 — `crates/kode-memory/src/git_sync.rs`

`pub mod git_sync;` 加进 `lib.rs`。复用 `store.rs` 已有的 `pub(crate)` 路径函数(`vault_dir` / `private_dir`),工作目录恒为 `vault_dir(root)`——git repo 根就是 vault/ 这一层,`.kode/` 物理在仓库外。

```rust
pub struct SyncReport {
    pub pulled: bool,
    pub pushed: bool,
    pub reconciled: usize,          // reconcile 补了几条
    pub skipped_reason: Option<String>,  // "git not found" / "auto_sync disabled" / ...
}

/// git --version 探测。ENOENT → 返回带平台安装引导的 error。
pub fn ensure_git_available() -> Result<()>;

/// sync.json 存在且 auto_sync = true。
pub fn is_enabled(root: &Path) -> bool;

/// git init(vault/) + 写 .gitattributes/.gitignore + add remote + 写 sync.json。
pub fn init_repo(root: &Path, remote: &str, branch: &str) -> Result<()>;

/// git add facts/ pending/ → commit → (auto_push 时 push)。无变更返回 Ok(false)。
/// 这是 **best-effort**:push 失败已 commit 成功,仅打 warn,不返回 Err。
pub fn commit_and_push(root: &Path, message: &str) -> Result<bool>;

/// git fetch → merge -X union。返回是否有更新(有新 commit 进本地)。
pub fn pull_union(root: &Path) -> Result<bool>;

/// 顶层编排:ensure_git → pull_union → 若有更新 store.reconcile() → 返回 SyncReport。
/// 这是 **唯一依赖 store 的公共函数**(调 reconcile)。
pub fn sync(store: &mut MemoryStore, root: &Path, opts: SyncOpts) -> Result<SyncReport>;

pub struct SyncOpts {
    pub do_pull: bool,
    pub do_push: bool,
    pub message: Option<String>,
}
```

`init_repo` / `commit_and_push` / `pull_union` 是纯路径函数,可独立测试。只有 `sync()` 需要 `&mut MemoryStore`(为 pull 后调 `reconcile()`)。

## 3. SyncConfig — `.kode/sync.json`

路径 `private_dir(root).join("sync.json")`。`.kode/` 在 git repo 根(`vault/`)之外,天然不被追踪。配置是机器本地的——每台机配自己的 `auto_sync` 开关,`remote`/`branch` 可以相同也可以不同(比如一台指向 GitHub,一台指向 Gitee mirror)。

```rust
#[derive(Serialize, Deserialize, Default)]
pub struct SyncConfig {
    /// git remote url。None = 未初始化,commit_and_push 只本地 commit 不 push。
    pub remote: Option<String>,

    /// 默认 main。
    #[serde(default = "default_branch")]
    pub branch: String,

    /// 总开关。false 时 is_enabled 返回 false,所有同步操作跳过。
    #[serde(default)]
    pub auto_sync: bool,

    /// approve 后是否自动 push。关掉只本地 commit(之后手动 kode-memory sync push)。
    #[serde(default)]
    pub auto_push: bool,
}

fn default_branch() -> String { "main".into() }
```

`load_config(root)` — 缺文件返回 `Default`(全 false/None),不报错。
`save_config(root, &cfg)` — 原子写(`private_dir` 已确保目录存在)。

## 4. git CLI 封装

### 4.1 基础 helper

```rust
fn git(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    let out = std::process::Command::new("git")
        .current_dir(vault_dir(root))
        .args(args)
        .output()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("git {}: {}", args.join(" "), stderr.trim());
    }
    Ok(out)
}
```

`current_dir` 设到 `vault/`——此后所有路径都相对于 vault 根,不用手动拼子目录。

### 4.2 git 缺失检测 + 平台引导

`ensure_git_available()` 先跑 `git --version`。捕获 `ENOENT`(命令不存在)时,返回 error 里带平台安装文案:

```
macOS:   brew install git   (或 xcode-select --install)
Linux:   sudo apt install git  /  sudo yum install git
其他:    https://git-scm.com/downloads
```

CLI/GUI 调用点收到这个 error 后,把文案展示给用户一次即可,不反复弹。

### 4.3 .gitattributes + .gitignore

`init_repo` 在 vault/ 下写两个文件并 commit:

**.gitattributes**:
```
facts/*.md merge=union
pending/*.md merge=union
```

`merge=union` 是 git 内置 driver,无需额外注册。含义:冲突时保留双方内容(各追加在后面)。因为 ULID 文件名全局唯一,不同机器几乎不可能改同一个文件;真正冲突仅发生在同一 fact 被两台机编辑(罕见),union 保留两个版本,用户看到后手动处理。

**.gitignore**:
```
# .obsidian/ 配置是用户私有的,不同步
.obsidian/
```

`.kode/` 不需要列——它在 vault/ 父目录,物理上就在 git repo 之外。

### 4.4 pull_union

```rust
pub fn pull_union(root: &Path) -> Result<bool> {
    let before = git(root, &["rev-parse", "HEAD"])?.stdout;
    git(root, &["fetch", "origin"])?;
    let _ = git(root, &["merge", "-X", "union", "origin/main"]);
    // merge 可能非 0(冲突残留),但不抛 Err —— 由上层检测
    let after = git(root, &["rev-parse", "HEAD"])?.stdout;
    Ok(before != after)
}
```

返回 `true` = 有更新被拉下来(HEAD 变了),上层据此决定是否 `reconcile()`。

### 4.5 commit_and_push

```rust
pub fn commit_and_push(root: &Path, message: &str) -> Result<bool> {
    let cfg = load_config(root)?;
    // 无变更 → 不提交
    let status = git(root, &["status", "--porcelain", "facts/", "pending/"])?.stdout;
    if status.is_empty() { return Ok(false); }
    git(root, &["add", "facts/", "pending/"])?;
    git(root, &["commit", "-m", message])?;
    if cfg.auto_push && cfg.remote.is_some() {
        let _ = git(root, &["push", "origin", &cfg.branch]);  // best-effort,失败不致命
    }
    Ok(true)
}
```

## 5. 接入点

### 5.1 approve 后 push — 由上层触发,store 不碰 git

**理由**:store.rs 顶部不变量"MemoryStore 是唯一可变状态,用 tokio::Mutex 串行化"。push 阻塞会卡住所有 review;store 不该知道 remote/网络。所以:

- **CLI** `cmd_review`:在 `ReviewOutcome::Approved` 分支后,若 `is_enabled(root)` → `let _ = commit_and_push(...)`(失败仅 eprintln 警告,不改退出码)。
- **GUI** `memory_review` Tauri 命令:approve 后释放 store 锁 → `tauri::async_runtime::spawn` 后台 task 调 `commit_and_push`,不阻塞前端返回。

### 5.2 启动 pull — 仅一次,不做 interval

- **CLI** `Sync` 子命令(见 §7):用户手动触发 `sync()`。
- **GUI** `MemoryHandle::open` 后,仿 `spawn_recall_aggregator` 起 `spawn_sync_task`:启动 ~2s 后跑**一次** `sync()`(pull+reconcile)。task 内拿 `store.lock().await` 调 `pull_union` + 若有更新调 `reconcile`。

### 5.3 pull→reconcile 串联(支点,不可省)

固化在 `sync()` 内——`pull_union` 返回 true(有更新)才调 `store.reconcile()`。reconcile 把 facts/ 当 source of truth 重建 sqlite 索引 + links 表,删除孤儿。union 合并后的新文件、被 supersede 改过的老文件全部对齐。

## 6. best-effort 降级铁律

| 场景 | 行为 |
|---|---|
| push 失败(网络断) | commit 已成功,push 仅 warn。approve 返回成功 |
| git 没装 | is_enabled 即便 true,sync/commit_and_push 先 ensure_git_available → 失败 → no-op + 一次性提示 |
| remote 没配 | sync.json.remote == None → pull/push 跳过,仅本地 commit |
| merge 冲突残留 | union 理论不冲突,老仓库漏配 .gitattributes 可能出现 → 不 reconcile、不自动 resolve,返回 error 交用户手工处理 |
| auto_sync = false | is_enabled 返回 false,所有同步操作跳过(memory 照常使用) |

**核心铁律:approve 永不因 sync 失败而失败。sync 失败绝不破坏本地 vault。**

## 7. CLI Sync 子命令(加进 cli.rs `Cmd`)

```
kode-memory sync [--init] [--remote <url>] [--branch <name>] [--no-push] [--enable | --disable]
```

- `--init --remote <url>`:调 `init_repo` + `save_config`,在 vault/ 下 git init 并写 .gitattributes/.gitignore,然后 commit 初始内容。
- 无参数:调 `sync()`,打印 `SyncReport`(pulled/pushed/reconciled/skipped)。
- `--no-push`:仅 pull,不 push。
- `--enable / --disable`:翻 `sync.json::auto_sync` 开关。

## 8. 测试策略

用 `tempfile` + 真 `git`(测试开头 `ensure_git_available`,缺失则 `eprintln + return` 跳过,不让 CI 无 git 时红):

1. **`init_repo` 基本检查**:`.gitattributes` 含 `facts/*.md merge=union`、`.git` 存在、remote 已设。
2. **`SyncConfig` 往返**:`save_config` → `load_config` 字段一致;缺文件返回 `Default`;`.kode/sync.json` 不在 vault/ 下(不被 git 追踪)。
3. **两仓互推 union 合并**(主场景):bare repo 当 remote;clone A、B;A approve 写 `facts/x.md` push;B approve 写 `facts/y.md`;B pull→两文件并存无冲突;B `reconcile()` 后索引含 x、y 两条。
4. **同文件 union 保留两边**:A、B 各对同一 supersede 老文件追加不同行 → union 保留两行(验证 `.gitattributes` 生效)。
5. **降级路径**:remote=None 时 `commit_and_push` 仅本地 commit 返回 Ok(false);PATH 抹掉 git 时 `sync` 返回降级不 panic;push 失败(假 remote)只 warn 不 Err。
6. **回归锁**:`sync` 永远在 pull 有更新后调 `reconcile`(pull 后 facts/ 多一个文件 → 断言 store 索引计数增加)。

## 9. 关键不变量(改代码前必读)

1. **`.kode/` 永不进 git** — git repo 根 = `vault/`,`.kode/`(sqlite / budget / metrics / archive / sync.json)物理在仓库外。`init_repo` 不在 `.kode/` 里 git init。
2. **每次成功 pull 后必须 reconcile** — 否则 sqlite 与 facts/ 漂移。固化在 `sync()` 内,不暴露"只 pull 不 reconcile"的公共路径。
3. **sync 失败绝不破坏本地 vault** — 任何 git 错误只返回 Err/warn,不删、不改本地文件;冲突残留时停手交用户。
4. **agent 不能触发 push** — `git_sync` **不进 MCP server 工具列表**(`mcp_server.rs` 不暴露)。仅 CLI + GUI 后台调用。
5. **approve 永不因 sync 失败而失败** — 调用点全部 best-effort;fact 落盘(`commit_to_facts`)与 git push 完全解耦。
6. **pending/ 不强制同步语义** — 即便被 git 带过去,各机各审;`reconcile` 只重建 facts/ 索引,不动 pending 池。
7. **store 不依赖 git** — `store.rs` 零改动;`git_sync` 单向依赖 store(仅调 `reconcile`)。

## 10. 改动文件清单(实现阶段)

| 文件 | 改动 |
|---|---|
| `crates/kode-memory/src/git_sync.rs` | **新建**:全部 pub 函数 + 私有 helper + SyncConfig + 测试 |
| `crates/kode-memory/src/lib.rs` | 加 `pub mod git_sync;` |
| `crates/kode-memory/src/bin/cli.rs` | 加 `Cmd::Sync` 子命令 + `cmd_review` 中 approve 后 best-effort push |
| `apps/gui/src-tauri/src/memory.rs` | 加 `spawn_sync_task` + `memory_review` approve 后异步 push |
| `crates/kode-memory/Cargo.toml` | **无新依赖**(std::process::Command + 测试已有 tempfile) |

## 11. 远端 memory 审核(remote review,协议侧)— 设计完成,待实现

> **定位**:git sync(§0-10)解决"已审核 facts 怎么跨机"。远端审核解决"远端 agent 的
> pending 怎么在本地 GUI 审"—— remote 模式下 codebuddy 跑远端宿主,`memory_propose`
> 落到远端 `~/.kode-memory/vault/pending/`,本地 GUI 当前看不到。git sync 同步的是
> **已审核的 facts/**,但 pending 审核需要实时通道 → 走 Phase 9 协议。

### 11.1 决策摘要(用户 2026-06-13 拍板)

| 决策项 | 选择 | 否决项 |
|---|---|---|
| 远端写入策略 | 远端写、本地审 | 远端只读(丢沉淀);远端自己审(需 SSH) |
| Go server 拿数据 | exec `kode-memory` CLI | Go 重写 memory 逻辑(双实现漂移) |
| CLI 输出 | 加 `--json` flag | 另建 gRPC/其他 IPC(overkill) |
| 传输通道 | Phase 9 协议 REST + 现有 bearer | 新协议 / WS 长连(不需要实时推送) |
| GUI 远端模式 | 复用 endpoint_fs_list 的 reqwest+SSH 隧道 | 复用 RemoteTransport(它已绑 session 语义) |

### 11.2 数据流

```
本地 GUI                远端 kode-server-go            远端宿主
MemoryPanel.svelte      GET  /api/v1/memory/pending    kode-memory pending --json --root R
 └ memory_*_remote ───► POST /api/v1/memory/pending/   ─exec─► kode-memory review <id> --json
   (Tauri cmd)               {id}/review                       kode-memory search --json
   reqwest+bearer       GET  /api/v1/memory/search
```

Go **只转发不重写** memory 逻辑;所有规则(提议门槛 / 查重 / 能量 / git sync)在 Rust CLI 复用。

### 11.3 与 git sync 的关系(闭环)

- **审核走协议(实时)**:本地 GUI 通过远端 REST 审核远端 pending,approve 即时生效。
- **数据落地仍走 git(去中心化)**:远端 CLI 在 `review --json` 的 approve 分支里,
  `commit_and_push` 仍触发,把新 fact 推 git;本地下次 `kode-memory sync` 或
  GUI 启动 pull 时拿到,reconcile 进本地索引。
- **不冲突**:git 管"已审核的 facts 文件",协议管"pending 的审核操作"。

### 11.4 CLI `--json`(底座,阶段 A)

`crates/kode-memory/src/bin/cli.rs`:给 `Pending` / `Review` / `Search` 三个子命令各加
`#[arg(long)] json: bool`(非 global)。cmd 函数顶部 `if json { emit_json(...); return }`。
定义 CLI 专用扁平 DTO,对齐 GUI 已有 `PendingDto` / `SearchHitDto`。

- `pending --json` → `{"pending":[{id,author,session,scope,created,confidence,tags,kind,subsystem,supersedes,body,rationale,author_energy}]}`。**author_energy 需 BudgetStore::open + current_energy 补上**。
- `search --json` → `{"hits":[{id,author,scope,kind,subsystem,created,confidence,tags,snippet,score}]}`。
- `review --json` → `{"outcome":"approved|rejected|blacklisted","author_energy":f32,"id":"..."}`。review 后联动 budget,取最新能量塞进 JSON;git sync best-effort push 不变。

错误:JSON 模式下错误**不**包 JSON,走非 0 退出 + stderr(Go 用退出码判失败)。

### 11.5 Go server 端点(阶段 B)

新建 `services/kode-server-go/internal/server/memory.go`。三端点全挂 `guard()`(复用 bearer authMiddleware):

```
GET  /api/v1/memory/pending?limit=N
POST /api/v1/memory/pending/{id}/review   body:{verdict,reason?,edited_*?}
GET  /api/v1/memory/search?q=&scope=&top_k=
```

统一 `runMemoryCLI(ctx, args...)`:exec.CommandContext(CLIPath, args + `--json` + `--root`),
捕获 stdout/stderr/exit。CLI 输出已是 JSON → 透传 body 不重 Marshal。

**Go config**:`MemoryConfig{CLIPath:"kode-memory", RootPath:""}` + `KODE_SERVER_MEMORY_CLI_PATH` / `KODE_SERVER_MEMORY_ROOT` env。CLI 未配/不存在 → 503 `memory_unavailable`;非 0 退出 → 422/500 `memory_exec_failed`(detail=stderr);坏 JSON → 500。`connection.hello` 的 `protocol_features` 追加 `"memory"`(配了 CLIPath 就声明),GUI 提前探测隐藏远端入口。

### 11.6 本地 GUI 远端审核(阶段 C)

`memory.rs` 新增 3 个 `*_remote` Tauri 命令(入参 `endpoint_id`,复用 `endpoint_fs_list` 的
"读 PersistedEndpoint → reqwest+bearer+SSH 隧道"模式):
`memory_list_pending_remote` / `memory_review_remote` / `memory_search_remote`,
反序列化回**已有的** `PendingDto` / `SearchHitDto` / `ReviewResult`(前端类型零改动)。

前端 `MemoryPanel.svelte`:加 endpoint 下拉(`"Local"` + endpoint 列表),
默认跟随当前活跃 tab 的 `endpoint_id`;远端池不走 1.5s watcher,打开面板拉一次 + 手动刷新。

### 11.7 实现顺序

A(CLI `--json`,底座,独立可测) → B(Go 端点,依赖 A,curl 验) → C(GUI 远端命令,依赖 B,真机验)
→ D(PROTOCOL.md,可并行)。

### 11.8 测试策略

- **A**:CLI 集成测试,init tmp root → propose → `pending --json` 解析断言;`review --json` 断言 outcome+energy 随 verdict 变。
- **B**:`memory_test.go` httptest + 假 CLI stub,验 flag 传递 / 透传 / 错误分档;CLIPath 不存在 → 503。
- **C**:`*_remote` 对 unreachable endpoint 返 Err(仿现有 `endpoint_test_connection` 测试)。

### 11.9 不变量

1. **提议+审核门槛不变**:远端仍 propose→review,approve 才进 facts/,联动能量。
2. **Go 只转发不重写**:零 memory 业务逻辑进 Go;规则变更只改 Rust,Go 自动跟随。
3. **CLI 不可用优雅降级**:503 + hello 不声明 `memory`,server 不崩不阻塞。
4. **鉴权复用 bearer**:三端点全挂 `guard()`;`--root` 只来自 server 配置,不接受客户端传值(防越权)。
5. **exec 无 shell 注入**:全走 `exec.Command` args 数组,用户输入永不进 shell。
6. **复用既有 DTO**:前端 `PendingDto`/`SearchHitDto`/`ReviewResult` 零改动,本地/远端共用同一套渲染。

### 11.10 改动文件清单(实现阶段)

| 文件 | 改动 |
|---|---|
| `crates/kode-memory/src/bin/cli.rs` | 加 `--json` flag + CLI DTO + 单测 |
| `services/kode-server-go/internal/config/config.go` | `MemoryConfig` + env override |
| `services/kode-server-go/internal/server/memory.go` | **新建**:handler + runMemoryCLI + 测试 |
| `services/kode-server-go/internal/server/server.go` | Routes() 注册 3 路由 + hello 能力位 |
| `apps/gui/src-tauri/src/memory.rs` | 3 个 `*_remote` Tauri 命令 |
| `apps/gui/src-tauri/src/lib.rs` | `generate_handler!` 追加 |
| `apps/gui/src/.../MemoryPanel.svelte` + `ipc.ts` | endpoint 下拉 + invoke |
| `.specops/specs/remote-protocol.md` | §4.12-4.14 + hello `memory` 能力 |
