# Design

## 核心判断:这是 GUI 默认来源的 UX 缺陷,不是数据同步问题

远端 bridge 的 `/api/v1/memory/pending` 已返回完整 `body`,GUI 的 `memory_list_pending_remote` 也能拿到。表象("提示亮、点开空")完全由 **徽章计数含远端、但面板默认只看本地** 这一不一致造成。所以修复重心在前端聚合,而非后端同步;`git_sync` 明确排除。

数据流(已验证):
```
远端 bridge watcher(1.5s, 仅计数)
  → lib.rs:434 emit "memory.pending"
  → remote.rs:447 注入 endpoint_id
  → state.rs:800 emit "memory-pending-remote"
  → App.svelte:379 remoteMemoryPendingCounts[ep] = n
  → App.svelte:236 总计数 = 本地 + Σ远端   ← 徽章亮
徽章 onclick → App.svelte:1271 memoryPanelOpen=true
  → App.svelte:1376 <MemoryPanel/> 不传 source
  → MemoryPanel:39 source 默认 local
  → refresh() 走 listPending()(本地空)   ← 点开看不到
```

## 决策 1:聚合,而非"点提示自动切到对应远端"

clarify 时给了两个选项:"点提示自动定位到对应远端" vs "聚合显示所有来源"。用户选**聚合**。

**理由**:聚合一次看全本地 + 所有远端,符合"审核队列"心智;避免多远端时还要在来源间来回切。代价是 `refresh()` 要并发多个 HTTP 拉取 —— 用 `Promise.allSettled` 做失败隔离即可。

## 决策 2:`origin` 标注放前端,不改后端 DTO

合并后的每条 pending 需要知道它从哪来(决定 review 路由 + 显示来源徽标)。后端 `PendingDto` 三处定义(`memory.rs` / `kode-bridge` / `cli.rs`)都不含 origin,且 origin 是"哪个连接拉的"这一前端上下文,不是 fact 本身属性。因此在 `ipc.ts` 的前端类型上加可选 `origin`,在 `refresh()` 合并时打标,**不动后端**。

## 决策 3:失败隔离用 per-source allSettled

当前 `refresh()` 一个 `try` 包全部(`MemoryPanel.svelte:89-110`),任一远端超时就整体 bootError、全空。改为:本地 + 每个 endpoint 各一个 promise,`Promise.allSettled` 收集;成功的合并进列表,失败的记到 `sourceErrors[origin]` 在 UI 顶部以非阻断条幅展示。这是验收项"某远端不可达仍显示其他来源"的实现手段。

## 决策 4:Browse 远端 recent —— 倾向新增后端路由(方案 a)

- 现状:`/api/v1/memory/search` 有(`lib.rs:468`),但 Browse 空 query 态调的是本地 `list_recent`,远端**无对应路由**。
- 方案 (a):bridge 加 `/api/v1/memory/recent`(GET,复用 store `list_recent`)+ `memory_list_recent_remote`。干净、语义正确,代价是动后端 + 补回归测试。
- 方案 (b):远端态用空/通配 search 近似 recent。不动后端,但 search 排序 ≠ recency,语义略偏。
- **倾向 (a)**。若想先快速见效,可先上 (b) 再补 (a)。

## 决策 5:Browse 远端 detail 暂不接 backlinks

`MemoryFactDetail` 调本地 `memory_read_with_backlinks`。远端化 backlinks 需要远端读取 + 反向链遍历路由,成本高、价值低。远端态下直接用 search/recent hit 已有的字段(body/tags/scope/…)渲染 detail。**此点需用户确认**(已列入 proposal 待确认点)。

## 风险

- 多远端并发 HTTP + SSH 隧道:`refresh()` 频率不能太高,沿用现有 watcher 1.5s 节流;隧道建立有成本,聚合时复用 `remote_memory_client` 的隧道生命周期(每次调用新建,注意不要在循环里反复 spawn —— 评估是否缓存隧道)。
- 去重:本地 vs 远端是不同 vault,id(ULID)理论不撞,但仍按 `origin+id` 唯一兜底。
- review 路由错误会把远端条目发到本地 store(或反之)—— `origin` 必须随条目精确携带,review 时取条目自身的 origin,不取"当前来源"。

## 不做的事

- 不碰 `git_sync` / store 模型。
- 不动 `remaining_pending` 语义。
- 不加 UI 自动化测试。
- 不碰 TUI `src/ui/`(已冻结)。
