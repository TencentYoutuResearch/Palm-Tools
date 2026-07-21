# Tasks

## 0. 复现与定界(先做)
- [ ] 在 GUI 里手动把 MemoryPanel 顶部来源下拉切到 "Remote: <endpoint>",确认远端 pending 内容能否显示。能 → 实锤默认来源 UX 问题;不能 → 先排查远端 vault/bridge(见下一条)。
- [ ] 若手动切仍空:确认远端 `~/.kode-memory/vault/pending/` 非空,且远端 bridge 启动日志无 "memory store/budget disabled"(`crates/kode-bridge/src/lib.rs:59-80`);`curl` 远端 `/api/v1/memory/pending` 看返回。

## 1. Pending 面板聚合所有来源(核心)
- [ ] `apps/gui/src/lib/ipc.ts`:给 `MemoryPending` 加前端侧可选 `origin`(`'local' | { endpointId: string }` 或等价标注),不改后端字段。
- [ ] `apps/gui/src/lib/MemoryPanel.svelte`:把 `source`(`:39`)从"单选本地/远端"改为"聚合"语义。
- [ ] `MemoryPanel.svelte` `refresh()`(`:86-111`):并发拉 `listPending()` + 对每个已配置 endpoint 拉 `listPendingRemote(endpointId)`,合并结果,每条打 `origin`。用 per-source `Promise.allSettled`,单源失败只记局部错误,不整体 bootError。
- [ ] `MemoryPanel.svelte` 列表渲染:每条标注来源徽标(Local / Remote: <display_name>)。合并去重按 `origin + id`。
- [ ] `MemoryPanel.svelte` `review()`(`:161-184`):按选中条目的 `origin` 路由到 `memoryIpc.review` 或 `memoryIpc.reviewRemote(endpointId, …)`。
- [ ] `MemoryPanel.svelte` 事件订阅(`:124-129`):`onPendingCount` / `onRemotePendingCount` 触发时都 refresh(聚合态下不再按 source 过滤)。
- [ ] `apps/gui/src/App.svelte`:确认徽章计数(`:236`)与面板可见条目口径一致;徽章点开(`:1271`/`:1376`)进入聚合视图。

## 2. Browse 面板支持远端历史
- [ ] 决策:远端 recent 用方案 (a) 新增后端路由,还是 (b) 用空 search 近似(见 design.md)。
- [ ] (若方案 a)`crates/kode-bridge/src/lib.rs`:新增 `/api/v1/memory/recent` GET 路由,复用 store `list_recent`;`apps/gui/src-tauri/src/memory.rs` 新增 `memory_list_recent_remote`;`apps/gui/src-tauri/src/lib.rs` 注册命令;`ipc.ts` 加 wrapper。补 bridge 路由回归测试。
- [ ] `apps/gui/src/lib/MemoryBrowsePanel.svelte`:加来源选择/聚合;远端 search 走 `memory_search_remote`;远端 recent 走方案产物。
- [ ] Browse 远端 detail:暂用 search hit 字段直接渲染(不接 backlinks),待用户确认。

## 3. 验证
- [ ] 真机目视:远端有 pending 时点徽章直接看到内容并能审核;某远端断开时其余来源仍显示 + 局部错误。
- [ ] 真机目视:Browse 能看到远端历史 facts。
- [ ] 徽章计数与面板条目数一致。
- [ ] `cargo test -- --test-threads=1` 全绿。
