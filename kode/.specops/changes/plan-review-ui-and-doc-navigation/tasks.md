# Tasks

- [x] `documents.ts` — 新增 `refreshState()` 和 `pendingDocSelection` store
- [x] `DocTree.svelte` — 添加刷新按钮（tree-header + refresh-btn）
- [x] `IwikiModule.svelte` — onMount 时自动刷新文档列表，watch `pendingDocSelection` 完成跨模块导航
- [x] `Composer.svelte` — plan_review 渲染：plan markdown 卡片 + "查看文档"按钮 + Approve/Revise 按钮
- [x] 服务端 `src/server/index.ts` — 新增 `POST /api/sessions/{id}/plan_response` 端点
- [x] `App.svelte` — 监听 `pendingDocSelection`，切换模块到 iwiki
- [x] 运行 `pnpm test` 验证（175 passed）
