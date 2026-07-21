---
schema_version: 1
id: memory/design
kind: spec
title: kode-memory design — project-level gotcha & experience pooling
status: active
verifies:
  - rust
  - specops
paths:
  - crates/kode-memory/src
  - apps/gui/src-tauri/src/memory.rs
---

# kode-memory 设计文档(v1)

> **目标读者**:接手 / review / 实现 kode-memory 的人(包括未来的你或 LLM)。
>
> **本文是设计共识**。落地前先 review 这一份,有疑问改这里、不要改散落到各处的代码注释。
>
> **状态**:Phase-C prototype 已跑通(`crates/kode-memory/`),v1 落地规范见 §7。
> **2026-06-06 更新**:M4 GUI 集成 + M4.1 MCP setup banner + M4.2 prompt-only 注入已落地(详见 §7 / §12)。

## 0. TL;DR

kode-memory 是一个**项目级 gotcha 与经验的沉淀池**,由 agent 提议、用户审核、能量预算调控。让"上次踩过的坑"不会被同项目的另一个 agent 或下一次会话重复踩。

它**不是**:用户偏好存储 / 会话记忆 / 知识库 / 任务清单 / agent 思考草稿。范围越克制,系统越好用。

## 1. 为什么要做这个

### 1.1 现状问题

1. **跨 agent 知识孤岛**:tab1 的 codebuddy 调出来的 PTY 死锁根因,tab2 的 claude 改 reader.rs 时看不到。kode 既然是 tab 编排器,天然有"统一记忆层"的物理基础。
2. **跨会话遗忘**:用户告诉 codebuddy "别给默认 args 加 positional",一周后开新会话又得说一遍。Claude Code 的 `CLAUDE.md` 解决了一部分,但粒度粗、不可被 LLM 增量更新、不可被结构化检索。
3. **经验流失**:调试中"原来这个不行"的发现,如果不立刻写到代码注释里,过两周就忘了。memory 是无处可写但需要被记住的兜底。

### 1.2 为什么是现在做

kode v0.2 已经把 PTY / session / config 抽到 `kode-core`,从 TUI 切到独立 GUI(见 ROADMAP)。这次重构是把 kode 从"tab 管理器"升级成"agent 编排器+共享大脑"的最佳时机 —— 内置 memory daemon 是这个升级的核心组件。

## 2. 严格的范围圈定

### 2.1 进入 memory 的内容(✅)

- **项目级架构约束**(`scope: project:<slug>`)
  - 例:"PtyHost::kill 必须用 `clone_killer()` 拿独立句柄"
- **项目级踩坑教训**
  - 例:"codebuddy 命令的第一个 positional 是 prompt,不能给默认 args 加"
- **跨项目通用模式 / 经验**(`scope: shared`)
  - 例:"macOS PTY 在某种 fork 模式下会丢 SIGCHLD"
- 与代码 / 注释 / 文档相比"无处可写但需要被记住"的元知识

### 2.2 不进入 memory 的内容(❌)

| 类型 | 应该放哪 |
|---|---|
| 用户偏好(emoji 习惯、commit 风格、回复语言) | `CLAUDE.md` 顶部常驻段 |
| 当前会话状态 / 上下文 | agent in-context |
| 代码 API 用法 / 库文档 | RAG / docs / 代码本身 |
| TODO / 任务清单 | TaskCreate |
| Agent 思考过程 / 中间结果 | 会话 trace |

### 2.3 LLM 在写之前必须自问的 4 个问题

某条要写入的内容,过不了这 4 个 yes/no 就不应该写:

1. 下次再发生类似情况,我会想知道这个吗?(no → 别写)
2. 这个东西放在代码 / 文档 / 注释里更好吗?(yes → 别写,去那里写)
3. 这是事实还是猜测?(猜测 → 要么不写,要么标 confidence ≤ 0.5)
4. 未来这条会很快被推翻吗?(会 → 加 ttl_days,或干脆别写)

这 4 个问题应该出现在 agent 调用 `memory_propose` 时的 prompt 里。

## 3. 关键设计决策

### 3.1 为什么是 agent 提议 + 用户审核(而不是 agent 直接写)

直觉是"让 agent 自由写,反正可以检索"。错的。低门槛 → 池子很快被低质量内容稀释 → 检索召回率下降 → 用户失去信任 → 系统死亡。

所以:
- **agent 不能直接写入** memory 池。它只能 `memory_propose(...)`。
- 提议进入 `pending/` 待审核
- **用户**通过 kode UI(`Cmd+Shift+M`)审核:approve / edit-then-approve / reject / blacklist
- 只有 approve 后才进 `facts/`,被检索到

### 3.2 为什么用能量预算制(而不是硬限额或 TTL)

要防止 agent 提议泛滥让用户疲劳,有几种方案:

| 方案 | 优 | 劣 |
|---|---|---|
| 硬限额(每会话最多 N 条) | 简单 | 卡死好 agent,养肥差 agent |
| TTL 自动过期 | 用户压力小 | 反馈环断,agent 学不到对错 |
| **能量预算(选)** | 自适应、有反馈环 | 实现复杂一点 |

**机制**:每个 agent session 启动分配 5 点能量。

| 行为 | 能量变化 |
|---|---|
| `memory_propose` | -1 |
| 提议被 approve | +0.5 |
| 提议被 edit-then-approve | 0(中性) |
| 提议被 reject | -1 额外惩罚(总计 -2) |
| 提议被 blacklist | -2 额外惩罚(总计 -3) |

能量为 0 时 `memory_propose` 直接拒绝,返回原因让 agent prompt 能看到。每 24 小时缓慢回血(避免永久封禁)。

**效果**:好 agent 越用空间越大;差 agent 自我饿死;反馈环对 agent 可见(下一轮 prompt 能学到)。

### 3.3 为什么是单机但预留跨机

**v1:单机单用户**。所有数据在 `~/.kode-memory/`。简单、无并发问题、足够覆盖 80% 场景。

**v2 跨机:依赖 facts/ 是 git-friendly 这一性质**。
- `facts/<id>.md` 一个文件一条,git diff 友好,merge 冲突在文件层面解决
- SQLite 索引**不参与同步**,跨机时各自从 facts/ 重建
- 这要求 v1 必须实现 `reconcile()`:启动时扫 facts/,补齐 SQLite 缺失项

> **v2 跨机方案已设计**(git CLI + union merge + approve-push + 启动 pull→reconcile),
> 详见 [`MEMORY_GIT_SYNC.md`](./MEMORY_GIT_SYNC.md)。本节的三个预言(facts/ git-friendly /
> sqlite 不同步 / reconcile 重建)正是该方案的直接基础。

### 3.4 为什么是 markdown + frontmatter(而不是 JSON / DB-only)

- **人类可读**:用户在 kode UI 之外用 vim 也能看 / 改
- **git-friendly**:diff / blame / merge 都是文本工具老本行
- **LLM 友好**:agent 直接读到的就是它熟悉的 markdown 格式
- **可审计**:每条 fact 一个文件 → 改动历史清清楚楚

## 4. 数据模型

### 4.1 目录布局

```text
~/.kode-memory/
├── facts/<id>.md             已审核,可被检索   ← source of truth
├── pending/<id>.md           agent 提议待审
├── archive/rejected/<id>.md  被拒提议(保 30 天供分析)
├── feedback.jsonl            用户处置日志(质量分析输入)
├── budget.json               每个 agent 的能量点账本
├── metrics.jsonl             仪表盘原始数据
├── tmp/                      原子写暂存(rename 后清空)
└── index.sqlite              FTS5 索引(可从 facts/ 重建)
```

### 4.2 Fact 文件格式

```markdown
---
id: 01HXYZ7K8M2QABCDEF
author: codebuddy
session: 8f3a-...
scope: project:kode
created: 2026-06-02T10:00:00Z
confidence: 0.9
tags: [pty, deadlock, gotcha]
supersedes: null
ttl_days: null
deprecated: false
---
PtyHost::kill 必须用 clone_killer() 拿独立 kill 句柄。
原因:reaper 和 killer 同时持 Mutex<Child> 会死锁。
验证:cargo test pty::tests::kill_during_wait
```

字段说明:
- `id`:ULID,可排序、文件名安全、26 字符
- `author`:agent 名(`codebuddy` / `claude` / `user`)
- `scope`:`project:<slug>` 或 `shared`(v1 不开 `global`)
- `confidence`:[0, 1],写入方自评。检索时与 BM25 score 加权
- `supersedes`:替换的老条目 id;daemon 自动把老条目标 deprecated
- `ttl_days`:过期天数(可选);后台 task 每天扫一次

### 4.3 SQLite Schema

```sql
CREATE TABLE facts (
    id          TEXT PRIMARY KEY,
    author      TEXT NOT NULL,
    session     TEXT,
    scope       TEXT NOT NULL,
    created     TEXT NOT NULL,
    created_ts  INTEGER NOT NULL,
    confidence  REAL NOT NULL,
    tags        TEXT NOT NULL,        -- JSON array
    supersedes  TEXT,
    ttl_days    INTEGER,
    deprecated  INTEGER NOT NULL DEFAULT 0,
    body        TEXT NOT NULL
);
CREATE INDEX idx_facts_scope ON facts(scope, deprecated);
CREATE INDEX idx_facts_created ON facts(created_ts DESC);

CREATE VIRTUAL TABLE facts_fts USING fts5(
    id UNINDEXED, body, tags,
    tokenize = 'trigram'    -- ⚠️ 必须 trigram,unicode61 不分词中文
);
```

**重要约束**:`facts/*.md` 是 source of truth,SQLite 是可重建的索引。任何代码路径不允许"只更新 SQLite 不更新文件"。

## 5. MCP 工具集

agent 通过 MCP stdio 协议访问。**注意:v1 把 prototype 里的 `memory_write` 移除,只保留 `memory_propose`**。

| 工具 | 调用方 | 作用 |
|---|---|---|
| `memory_search` | agent | FTS5 + tag 检索,默认只搜 `current_project + shared` |
| `memory_read` | agent | 按 id 读完整 fact |
| `memory_propose` | agent | **新建提议进 pending,不进检索池**;消耗 1 能量 |
| `memory_list_recent` | agent | 列最近 N 小时的 fact |
| `memory_list_pending` | user-only | 列待审提议(给 UI 用,agent 不能调) |
| `memory_review` | user-only | approve / edit / reject / blacklist 一条 pending |
| `memory_deprecate` | user-only | 软删一条 fact;agent 想"否定"老 fact 必须用 propose + supersedes |

### 5.1 `memory_propose` 输入

```json
{
  "author": "codebuddy",
  "session": "8f3a-...",
  "scope": "project:kode",
  "body": "...",
  "tags": ["pty", "gotcha"],
  "confidence": 0.85,
  "supersedes": null,
  "rationale": "刚才调试 kill_during_wait 时发现的"
}
```

`rationale` 是给用户审核时看的"为什么提这条",不进入 fact body。

### 5.2 `memory_propose` 错误码

- `out_of_energy`:能量耗尽。返回 `next_refill_at` 让 agent 知道何时再试
- `duplicate`:已有近似 fact(简单重复检测,Top-1 BM25 score > 阈值);返回老 id 让 agent 决定是否 supersedes
- `scope_invalid`:scope 不存在
- `body_too_long`:body > 1000 字。LLM 应拆成多条小 fact

## 6. 质量度量(必须 v1 就有)

不能度量的系统会死,这是 v1 的最重要保险。

### 6.1 metrics.jsonl 事件流

每个事件一行 JSON:

```jsonl
{"ts":"2026-06-02T10:00:00Z","event":"propose","author":"codebuddy","session":"8f3a","fact_id":"01HXYZ","scope":"project:kode","tags":["pty"]}
{"ts":"2026-06-02T10:01:30Z","event":"approve","fact_id":"01HXYZ","reviewer":"user"}
{"ts":"2026-06-02T10:02:00Z","event":"reject","fact_id":"01HXAB","reviewer":"user","reason":"obvious"}
{"ts":"2026-06-02T10:05:00Z","event":"recall","query":"clone_killer","hit_ids":["01HXYZ"],"clicked":"01HXYZ"}
```

### 6.2 仪表盘视图(`C-b M m`)

```
Last 7 days (codebuddy):
  proposed:   42
  approved:   18 (43%)
  edited:      9 (21%)   ← 高了说明 agent 写的角度对但表述差
  rejected:   12 (29%)
  blacklisted: 3 (7%)    ← 任何 >5% 都该 review prompt
  energy:      3.5 / 5

Top tags accepted: pty(8), shader(5), config(3)
Top tags rejected: thinking(7), todo(4)   ← 这些 agent 不该写
```

### 6.3 老化追踪(月度)

每月随机抽 20% 已 approve 的 fact,daemon 在用户开 kode 时弹一次"这条还准吗?"。结果记入 `feedback.jsonl`,两个月后能算出"approve 后真实存活率"。

### 6.4 跨 agent 提议质量对比

按 author 聚合:

```
Last 30 days:
  codebuddy: approve 47%, edit 18%, reject 28%, blacklist 7%
  claude:    approve 61%, edit 22%, reject 15%, blacklist 2%
```

未来可以用这个数据给不同 agent 不同初始预算。

### 6.5 召回质量 baseline(项目启动就要做)

**没有 baseline,1 个月后没人能回答"召回变好了吗"**。

立项就做:
- 手写 50 条高质量项目 fact(从 `CODEBUDDY.md` / `ROADMAP.md` 现有内容抽出来即可)
- 写 30 个"模拟提问"(`如何避免 PtyHost 死锁?` `codebuddy args 怎么传?` 等)
- 跑一个 baseline:这 30 个提问能召回到对应 fact 吗?Top-1 / Top-5 准确率多少?
- baseline 数据存 `crates/kode-memory/tests/baseline/`,作为后续召回改进的对照基准

## 7. v1 落地里程碑

| Phase | 内容 | 工时 | 完成判据 | 状态 |
|---|---|---|---|---|
| **M1: 数据层** | facts/ + pending/ + SQLite + reconcile() | 4 天 | 启动后能从 facts/ 重建 SQLite;并发写不丢 | ✅ `0f187a4` |
| **M2: MCP 工具** | search / read / propose / list_recent | 2 天 | stdio 端到端跑通;每个工具有集成测试 | ✅ `0f187a4` |
| **M3: 能量预算** | budget.json + propose 拦截 + 回血 | 1 天 | 0 能量时 propose 返回 out_of_energy;approve 后能量恢复 | ✅ `0f187a4` |
| **M4: 审核 UI** | `Cmd+Shift+M` 待审队列 + 一键操作 | 3 天 | 在 kode 里完整跑一遍 propose → review → approve 流程 | ✅ 2026-06-06 |
| **M4.1: MCP setup 自动检测** | banner + 一键 `codebuddy mcp add` | 0.5 天 | 启动 800ms 探测 → 未配 emit 事件 → 一键写配置 | ✅ 2026-06-06 |
| **M4.2: prompt-only 注入** | `--append-system-prompt` 教 agent 调 MCP | 0.5 天 | codebuddy / claude / claude-internal 通过 MCP 共享同一池子 | ✅ 2026-06-06 |
| **M5: 仪表盘** | metrics.jsonl + 视图 | 2 天 | 能看到 7 天接受率;按 agent 分组 | ⏳ v1.1 |
| **M6: Baseline 数据** | 50 条种子 fact + 30 个 query | 1 天 | tests/baseline 套件能跑;Top-5 准确率 >= 70% | ✅ `0f187a4`(实测 73.3%) |
| **M7: 老化追踪** | 月度抽样 + 用户复审 prompt | 1 天 | feedback.jsonl 有数据;30 天后能算存活率 | ⏳ v1.1+ |

**v1 = M1 + M2 + M3 + M4(含 M4.1 / M4.2) + M6**;M5 / M7 是 v1.1。
**v1 已落地里程碑**:M1 / M2 / M3 / M4 / M4.1 / M4.2 / M6 ✅

**M6 必须在 v1 启动前做**(否则没度量基准)。M6 可以与 M1 并行。

## 8. 不变量(改代码前必读)

1. **`facts/*.md` 是 source of truth**。任何路径不允许"只更新 SQLite 不更新文件"。
2. **写入路径必须原子**:tmp file → fsync → rename → SQLite 同事务 commit。
3. **`MemoryStore` 唯一可变,外部用 `tokio::Mutex` 包**。写入串行化,不要尝试细粒度锁。
4. **agent 不能直接调 `memory_write` / `memory_deprecate`**。这两个工具只对用户开放(通过 UI),agent 必须走 `memory_propose`。
5. **FTS5 必须用 trigram tokenizer**。unicode61 不分词中文,用了就废。
6. **能量点变化必须事件驱动**,即每次 propose / approve / reject 都立刻更新 budget.json,不要批量 / 异步。
7. **metrics.jsonl 永远 append-only**。任何代码路径不允许 truncate / overwrite。
8. **pending → archive/rejected 也是 rename,不是 delete**。30 天保留期由后台 task 处理。
9. **(M4.2 新,2026-06-06)** prompt 注入路径必须**尊重用户**:已显式 `--append-system-prompt` / `--system-prompt` / `--system-prompt-file` 时短路不覆盖;`PersistedState::kode_memory_prompt_enabled = Some(false)` 时短路;**只对新 spawn 的 tab 生效**,不重写现存子进程 args。
10. **(M4.1 新,2026-06-06)** codebuddy MCP 配置只能通过 `codebuddy mcp add` CLI 写,**不直接 mutate `~/.codebuddy.json`**(schema 真源在 codebuddy 自己手里;字段加减我们不跟)。检查时反向直读 JSON(`mcp list` 会真去连每个 server,慢且污染输出)。
11. **(M4.1 新,2026-06-06)** `codebuddy mcp add` 参数顺序:`mcp add -s user <name> <command> -e KEY=val` —— positional **必须**在 `-e <env...>` 之前(commander.js 的 variadic flag 会吞 token)。锁定测试 `setup_args_put_positional_before_dash_e`。
12. **(10.17 新,2026-06-13)** **`.kode/` 永不进 git** — git repo 根 = `vault/`,`.kode/`(sqlite / budget / metrics / archive / sync.json)物理在仓库外。`init_repo` 不在 `.kode/` 里 git init。
13. **(10.17 新,2026-06-13)** **每次成功 pull 后必须 reconcile** — 固化在 `git_sync::sync()` 内,不暴露「只 pull 不 reconcile」公共路径;sync 失败绝不破坏本地 vault;**agent 不能触发 push**(git_sync 不进 MCP 工具列表)。
14. **(10.18 新,2026-06-13)** **远端 memory 审核**:Go server 只 exec `kode-memory` CLI 转发,零 memory 业务逻辑进 Go;CLI 不可用时端点返 503 优雅降级,server 不崩;`--root` 只来自 server 配置不接受客户端传值;鉴权复用现有 bearer。

## 9. 不要做的事

- ❌ 把"agent 思考过程"塞进 memory(那是 trace 的事)
- ❌ 把"用户偏好"塞进 memory(那是 `CLAUDE.md` 的事)
- ❌ 让 agent 写入门槛降低("先写进来再说")—— 池子会被淹没
- ❌ 跳过 pending 直接写入 facts/ —— 信任靠机制建立,不靠 agent 自觉
- ❌ 在 SQLite 里存只在数据库存在、文件里没有的字段 —— reconcile 一跑就丢
- ❌ 给 memory 加"知识库"功能(导入大段文档) —— 那是 RAG 的活,不要混

## 10. 未解决的问题(v2 再想)

- **跨机同步策略**:✅ 已设计,见 [`MEMORY_GIT_SYNC.md`](./MEMORY_GIT_SYNC.md)。facts/+pending/ 推 git;能量点/metrics 留 `.kode/` 不同步(各机本地)。远端 pending 审核(remote 模式)见同文档 §11(协议侧,Go exec CLI 转发)。
- **多用户共享池的信任模型**:别人写的 fact 我怎么判断信不信?
- **embedding 检索**:fastembed-rs 集成时,rerank 公式怎么调?(BM25 + confidence 已经够好;v2 看数据再决定加不加)
- **agent 自动 supersedes 的策略**:agent 看到老 fact 觉得过时,是它该判断的吗?还是只该提示用户?
- **跨项目"通用模式"的发现**:同一个教训在 N 个项目重复出现,系统能不能自动建议提升到 `shared`?
- **远端 memory 审核**:✅ 已设计,见 [`MEMORY_GIT_SYNC.md` §11](./MEMORY_GIT_SYNC.md#11-远端-memory-审核remote-review协议侧-设计完成待实现)。远端 codebuddy 的 pending 走 Phase 9 协议 REST 传到本地 GUI 审核;Go server 只 exec `kode-memory` CLI 转发,不重写逻辑。

## 11. 参考实现

- Phase-C prototype:`crates/kode-memory/`(已跑通)
  - `src/fact.rs`:Fact / FactMeta / Scope + markdown 序列化
  - `src/store.rs`:MemoryStore + FTS5 + 原子写
  - `src/bin/mcp_server.rs`:stdio MCP server(v1 移除 `memory_write`)
  - `src/prompt.rs`(M4.2 新增):`PROMPT_TEMPLATE` + `build()`,系统 prompt 注入文本
  - `tests/concurrent.rs`:并发写入压测(1000 条无丢失)
- 设计参考:Claude Code `CLAUDE.md` 三层加载机制
- MCP 协议:[modelcontextprotocol.io](https://modelcontextprotocol.io)

## 12. 跨 backend 接入(M4 / M4.1 / M4.2,2026-06-06 落地)

**问题**:codebuddy / claude / claude-internal 三家各有自家 auto-memory(写自己 dir 的 markdown),tab 之间不通。kode 作为编排器要让"上次 tab 学到的"在新 tab 立刻可见。

**设计原则**:
- ❌ 不监听文件 / 不做镜像 / 不调 LLM 提炼(讨论过,放弃 — 见 ROADMAP 决策日志)
- ✅ 只动 system prompt + 接 MCP server,数据天然共享在 `~/.kode-memory/`

**三层落地**:

### 12.1 M4 — kode GUI review queue(数据落地的最后一公里)

代码:`apps/gui/src-tauri/src/memory.rs` + 前端 `App.svelte`

- `apps/gui/src-tauri/Cargo.toml` 直接依赖 `kode-memory` lib(零 IPC 开销,不走 CLI)
- 启动时 `try_open()` 打开 `~/.kode-memory/`(env `KODE_MEMORY_ROOT` 可覆盖),与 CLI / MCP 子进程同一份数据
- Tauri commands:`memory_list_pending` / `memory_stats` / `memory_review` / `memory_read_fact` / `memory_propose`
- 前端 `Cmd+Shift+M` 打开 review dialog;状态栏 pending 数字徽章;`memory-pending` 事件实时刷新
- 用户用判决 verdict:`approve` / `edit_then_approve` / `reject` / `blacklist` 走 `MemoryStore::review()`

### 12.2 M4.1 — codebuddy MCP setup 自动检测

代码:`apps/gui/src-tauri/src/memory_mcp.rs`(~450 行)

**stdio MCP 模型下"生命周期一起"的真实含义**:server 由调用方(codebuddy)spawn 子进程,kode 进程层面 spawn 一个 server 给所有 tab 用 = 不可行(stdin/stdout 已被独占)。所以"生命周期一起" = kode 退 → tab 退 → codebuddy 退 → 它各自的 `kode-memory-mcp` child 自然退;不需要 kode 层主动 spawn / kill。

**数据共享**:所有 child 都指 `KODE_MEMORY_ROOT=~/.kode-memory`(由 `memory::resolve_memory_root` 统一)。
**工程隔离**:agent 在调用时传 `scope: project:<cwd-slug>`(系统约定 + prompt 提示)。

**自动检测流程**:
1. 启动后 800ms `spawn_startup_probe` 探测:
   - `kode-memory-mcp` 二进制在哪(同 GUI 目录 → PATH → workspace target/ 三级 fallback)
   - `codebuddy` CLI 是否可用(PATH `which`)
   - `~/.codebuddy.json::mcpServers.memory` 是否已配
2. 未配 + `state.json::mcp_prompt_dismissed_at == None` → emit `memory-mcp-setup-required` 事件
3. 前端 banner 显示"启用"按钮,点击调 `memory_mcp_setup_codebuddy`:
   ```bash
   codebuddy mcp add -s user memory <bin> -e KODE_MEMORY_ROOT=<root>
   ```
4. 写入成功 → emit `memory-mcp-changed` → banner 自行重新拉状态消失

**踩坑**:commander.js `-e <env...>` 是 variadic,会吞后续 token 直到下一个 `-` 开头的 flag。
- ❌ 老代码 `... -s user -e KEY=val <name> <command>` → "missing required argument 'name'"
- ✅ 修正 `... -s user <name> <command> -e KEY=val`
- 回归测试 `setup_args_put_positional_before_dash_e` 锁住

**banner z-index 修复**:`<MemoryMcpBanner>` 必须包在 `.memory-mcp-floating { position: absolute; z-index: 5 }`,否则被 `.term-wrapper { position: absolute; inset: 0 }` 覆盖,看得见但点不到。

### 12.3 M4.2 — prompt-only 注入

代码:
- `crates/kode-memory/src/prompt.rs` — `PROMPT_TEMPLATE` 常量 + `build()`
- `crates/kode-core/src/session/mod.rs::inject_kode_memory_prompt`

**原理**:子进程 spawn 时通过 `--append-system-prompt <text>` 给 codebuddy / claude / claude-internal 末尾追加一段 ~80 行中文 markdown,教 agent 调 `memory_search` / `memory_propose` 工具。三家原本各有自家 auto-memory 指令,本指令在它后面 → agent 看到的最新指令是用 kode-memory(LLM 一般偏向更具体、更晚出现的指令)。

**PROMPT_TEMPLATE 结构**:
- `<kode-memory>` XML 标签包裹(给 agent 视觉锚点)
- 3 条 trigger(何时记):跨 30+ 分钟坑 / 项目级架构约束 / 用户偏好或决策
- 4 条 anti-trigger(何时不要记):中间结果 / 通用编程知识 / 思考过程 / 不确定猜测
- 调用形式 + 字段语义(scope / tags / confidence / rationale)
- 能量预算说明 + `out_of_energy` 申诉路径
- 查询场景:改代码前 search、用户问"为什么"先 search
- supersedes 申诉路径(不直接覆盖,走 propose 让用户审)

**`inject_kode_memory_prompt` 行为**(`crates/kode-core/src/session/mod.rs`):
```rust
fn inject_kode_memory_prompt(args: &[String], backend_key: &str, cwd: &Path, enabled: bool) -> Vec<String> {
    if !enabled { return args.to_vec(); }                      // kill switch
    if args.iter().any(|a| matches!(a.as_str(),                // 用户已显式 → 尊重不覆盖
        "--append-system-prompt" | "--system-prompt" | "--system-prompt-file"
    )) { return args.to_vec(); }
    let prompt = kode_memory::prompt::build(cwd, backend_key);
    if prompt.is_empty() { return args.to_vec(); }
    let mut new_args = args.to_vec();
    new_args.push("--append-system-prompt".into());
    new_args.push(prompt);
    new_args
}
```

挂在 `Session::new` 调用链最末(`inject_session_id` → `inject_model` → `inject_permission_mode_flag` → `inject_kode_memory_prompt`)。

**持久化 kill switch**(`apps/gui/src-tauri/src/persistence.rs`):
```rust
pub struct PersistedState {
    // ...
    #[serde(default)]
    pub kode_memory_prompt_enabled: Option<bool>,    // None / Some(true) = 启用(默认),Some(false) = 关
}
```
关掉后子进程 spawn 不再 `--append-system-prompt`,行为与 vanilla codebuddy/claude 一致。

**GUI 入口**:命令面板 ⌘P 搜 "Memory Prompt":
- "预览注入内容…" → dialog 显示完整文本(调 `memory_prompt_status`)
- "启用 / 禁用" → toggle(调 `memory_prompt_set_enabled`,只对**新 spawn** tab 生效)

### 12.4 闭环测试路径

1. codebuddy tab1 干活 → agent 学到 X → 调 `memory_propose` → pending +1
2. 状态栏徽章亮 → ⌘⇧M → approve → fact 进 `~/.kode-memory/vault/facts/`
3. 关掉 tab1
4. 新开 claude-internal tab → 问"本项目用啥 db?" → agent 主动 `memory_search` → 召回 X → 回答

数据流:**agent → MCP `memory_propose` → pending → 用户审核 → facts/ → 跨 tab `memory_search` 召回**。
零 file watcher / 零 LLM 调用 / 零镜像 / 审核闸门完整保留 / 跨 backend 透明共享。

### 12.5 测试覆盖

| crate | baseline | 新加 | total |
|---|---|---|---|
| kode-core | 81 | +5(`inject_kode_memory_prompt` 5 case) | 86 |
| kode-gui | 67 | +1(`persistence` 兼容性) | 68 |
| kode-memory | 25 | +4(`prompt::tests`) | 29 |

总计 **183 / 183 全绿**,`pnpm build`(vite) + `pnpm check`(svelte-check)零新警告。
