---
schema_version: 1
id: fix-gui-remote-memory-not-visible
kind: bug
title: GUI 远端 memory pending 与历史在面板里看不到内容
status: completed
verifies:
  - rust
paths:
  - apps/gui/src/lib/MemoryPanel.svelte
  - apps/gui/src/lib/MemoryBrowsePanel.svelte
  - apps/gui/src/lib/ipc.ts
  - apps/gui/src/App.svelte
  - apps/gui/src-tauri/src/memory.rs
  - crates/kode-bridge/src/lib.rs
---

# GUI 远端 memory pending 与历史在面板里看不到内容

> 用户原始请求:
> "你看看当前rust remote为啥memory pending，在kode gui里面没法看到，只看到了提示，点开后看不到内容，历史memory也看不到。是不是远端memory数据没有同步过来"

## Motivation

用户在 kode GUI 里发现:远端(rust remote bridge)有 memory pending 时,状态栏徽章/提示会亮,但**点开面板看不到任何内容**,历史 memory 也看不到。用户怀疑是"远端数据没同步过来"。

**排查结论:不是数据没同步,数据其实拿得到。** 根因是 **GUI 面板默认只看本地来源**,远端内容必须手动切来源下拉才显示;历史(Browse)面板则**完全没有远端入口**。

根因调查(定位到行):

1. **远端 pending 数据通路是通的**:远端 bridge `/api/v1/memory/pending` 直接返回**完整 `body`**(含正文/tags/rationale/author_energy),见 `crates/kode-bridge/src/lib.rs:1819-1853` 与 `PendingDto`。GUI 侧也有现成命令 `memory_list_pending_remote` 去拉(`apps/gui/src-tauri/src/memory.rs:1006-1040`)。

2. **徽章为什么会亮**:远端 bridge 后台 watcher 每 1.5s 推 `memory.pending`(**只带计数**,`lib.rs:409-440`)→ `apps/gui/src-tauri/src/transport/remote.rs:447-455` 注入 `endpoint_id` → `state.rs:800-801` emit 成 `memory-pending-remote` → `App.svelte:378-380` 累加进 `remoteMemoryPendingCounts` → `App.svelte:236` 总计数 = 本地 + Σ远端。**于是提示亮(计数含远端)。**

3. **为什么点开看不到内容**:状态栏徽章 onclick 只是 `memoryPanelOpen = true`(`App.svelte:1271`),打开 `<MemoryPanel onClose=.../>` **不传任何来源**(`App.svelte:1376`)。MemoryPanel 的 `source` 硬编码默认 `{ kind: 'local' }`(`MemoryPanel.svelte:39`),`refresh()` 走本地分支 `memoryIpc.listPending()`(`MemoryPanel.svelte:90-96`)→ 本地队列为空 → **列表空、点开看不到内容**。远端 pending 必须用户**手动把顶部下拉切到 "Remote: …"** 才会调 `listPendingRemote`(`MemoryPanel.svelte:97-99`)。

4. **历史 memory 看不到(同类问题第二处)**:Browse 面板 `MemoryBrowsePanel.svelte` 的 `listRecent` / `search` 走的是**纯本地命令**;后端虽有 `memory_search_remote`(`memory.rs:1089+`)但 Browse 没接,也没有 recent-remote。所以远端历史 facts 在 Browse 里**根本没有入口**。

### 用户已确认的期望

- **聚合显示所有来源**:面板一次性合并本地 + 所有已配置远端的 pending,**不要求手动切来源**。
- 历史 memory 的两个入口(Browse 面板 / pending 历史)都纳入排查与修复。
- 用户尚未试过"手动切来源下拉",故保留一个验证点(见下)。

### Constitution conflicts

无。本变更不违反 `.specops/constitution.md` 任何 invariant:
- 不涉及 PTY child lifecycle(`pty-lifecycle.md`)。
- 不改 backend default args(`backend-default-args.md`)。
- 不涉及 SpecOps Run isolation(`specops-run-isolation.md`)。
- "GUI terminal rendering is independent from SpecOps console rendering" 不受影响 —— 本变更只动 memory 面板与 bridge memory 路由。

## Scope

**改什么**:
1. **Pending 面板聚合所有来源** —— `apps/gui/src/lib/MemoryPanel.svelte`:`refresh()` 并发拉本地 + 各已配置远端 endpoint 的 pending 并合并,每条带 `origin`(local / remote+endpointId);列表每条标注来源;`review()` 按条目 `origin` 路由到 `review` 或 `reviewRemote`。失败隔离:单个远端不可达不整体 bootError。
2. **Browse 面板支持远端历史** —— `apps/gui/src/lib/MemoryBrowsePanel.svelte`:加来源选择/聚合,远端走 `memory_search_remote`;若需要空 query 的 "recent" 列表,后端补 `memory_list_recent_remote` + bridge 路由 `/api/v1/memory/recent`。
3. **前端类型/桥接** —— `apps/gui/src/lib/ipc.ts`:`MemoryPending` 增加前端侧可选 `origin` 标注;如新增 recent-remote 则加对应 wrapper。
4. **App.svelte** —— 确认徽章计数与面板可见条目口径一致(计数已含远端,主要是面板侧补齐);徽章点开后默认聚合。
5. **后端(条件性)** —— 仅当 Browse 远端 recent 选用方案 (a) 时:`apps/gui/src-tauri/src/memory.rs` 新增 `memory_list_recent_remote`,`crates/kode-bridge/src/lib.rs` 新增 `/api/v1/memory/recent` 路由(复用 store `list_recent`),`lib.rs` 注册命令。

**不改什么**:见 Out of scope。

## Acceptance criteria

- [ ] 配置了远端 endpoint 且远端有 pending 时,点状态栏 memory 徽章打开面板,**无需手动切来源**即可看到远端 pending 条目及其完整正文。
- [ ] 列表每条清晰标注来源(Local / Remote: <name>)。
- [ ] 对远端条目执行 approve/reject/blacklist 走 `reviewRemote` 并成功,审掉后从列表移除。
- [ ] 某个远端不可达(SSH 隧道/超时)时,面板仍显示其他来源内容 + 该来源的局部错误提示,不整体空白。
- [ ] Browse 面板能看到远端历史 facts(search 或 recent)。
- [ ] 状态栏徽章计数与面板可见条目数口径一致。
- [ ] `cargo test -- --test-threads=1` 全绿;若新增 bridge 路由,补对应回归测试。
- [ ] 真机目视:远端 pending 在 GUI 正常显示与审核。

## Out of scope

- **git_sync 真正的拉取/合并逻辑** —— 当前架构远端是独立 server + REST,不依赖 git pull 同步;本 bug 与 `git_sync` 无关,不在本次范围。
- 远端 review 的 `remaining_pending` 精确化(当前固定 0,`memory.rs:1083`)。
- 任何 MCP server / `kode-memory` store 侧的存储模型改动。
- 远端 fact 的 backlinks 读取(`memory_read_with_backlinks` 远端化)—— 价值低成本高;Browse 远端 detail 暂用 search hit 字段渲染(待用户确认)。
- 给 GUI memory 面板加自动化 UI 渲染测试(已知缺口,独立工作)。
- TUI v0.1(`src/ui/`)—— 已冻结,不碰。

## 待用户验证 / 确认点

1. 用户尚未试过"手动切来源下拉"。若切到 "Remote: …" 能看到内容 → 实锤纯 UX 默认来源问题,按聚合方案修即可;若切了仍空/报错 → 需额外排查远端 `~/.kode-memory/vault/pending/` 是否非空、远端 bridge `memory` 是否已 open(`lib.rs:59-80` 任一 open 失败则 `memory=None`,`/api/v1/memory/pending` 返回 500 "memory vault not available")。
2. Browse 远端 detail 是否接受"只用 search hit 字段渲染、不接 backlinks"。
