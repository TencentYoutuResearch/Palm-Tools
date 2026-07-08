---
schema_version: 1
id: plan-review-ui-and-doc-navigation
kind: feature
title: SpecOps plan_review 渲染与跨模块文档导航
status: proposed
verifies:
  - specops
paths:
  - apps/specops/frontend/src/components/chat/Composer.svelte
  - apps/specops/frontend/src/App.svelte
  - apps/specops/frontend/src/components/iwiki/IwikiModule.svelte
  - apps/specops/frontend/src/components/iwiki/DocTree.svelte
  - apps/specops/frontend/src/lib/stores/documents.ts
  - apps/specops/src/server/index.ts
---

# SpecOps plan_review 渲染与跨模块文档导航

## Motivation

plan_review 是 SpecOps 工作流的关键阶段：agent 提出计划后，用户需要审查并决定批准或修改。当前实现有两个问题：

1. **plan_review 无专用 UI**：`Composer.svelte` 只处理 `kind === 'answer'`，plan_review 降级为纯文本 "Action required: plan_review"，没有 plan markdown 渲染，没有 Approve/Revise 按钮
2. **DocTree 不自动刷新**：会话后台创建的 planning 文档（proposal/tasks/design）不会自动扫入 DocTree，用户手动切换过去看不到新文档
3. **无跨模块导航**：chat 视图无法跳转到 iwiki 文档视图定位到对应文档

## Scope

- DocTree header 添加刷新按钮，手动重扫 workspace 文档
- IwikiModule 挂载时自动刷新文档列表
- Composer.svelte 添加 plan_review 渲染：plan markdown 卡片 + "查看文档"跳转按钮 + Approve/Revise 按钮
- 服务端新增 `POST /api/sessions/{id}/plan_response` 端点
- 跨模块导航：chat 端点击"查看文档" → 切换到 iwiki → 选中对应文档

## Acceptance criteria

- [ ] plan_review 操作在 Composer 中显示完整的 plan markdown 内容
- [ ] "View document" 按钮可点击，跳转到 iwiki 模块并打开对应文档
- [ ] Approve/Revise 按钮可点击，调用服务端 plan_response 端点
- [ ] DocTree 刷新按钮可手动触发文档重扫
- [ ] 从 chat 切换到 iwiki 时自动刷新文档列表
- [ ] 现有 specops 测试不失败

## Out of scope

- 不改造服务端 intake/plan_review 生成逻辑
- 不添加自动轮询
- 不改旧版 app.js 控制台
- 不添加 i18n 翻译（使用 t() fallback 显示英文 key）

## Constitution conflicts

无冲突。本提案不涉及 PTY 生命周期、backend 默认参数、worktree 隔离等 constitution invariant。
