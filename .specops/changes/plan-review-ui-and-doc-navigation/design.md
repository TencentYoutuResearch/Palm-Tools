# 设计说明

## 架构概览

本次变更覆盖三个层面：

| 层 | 文件 | 变更 |
|----|------|------|
| 前端 store | `documents.ts` | +`refreshState()`, +`pendingDocSelection` |
| 前端 UI | `DocTree.svelte`, `IwikiModule.svelte`, `Composer.svelte` | 刷新按钮、自动刷新、plan_review 渲染 |
| 前端入口 | `App.svelte` | 跨模块导航 effect |
| 服务端 | `src/server/index.ts` | +`plan_response` 路由和处理器 |

## DocTree 刷新

**方案**：手动刷新按钮（DocTree header） + 模块切换自动刷新（IwikiModule onMount）

- `refreshState()` 是 `loadState()` 的别名，重新请求 `/api/state` 刷新 `workspaceState`
- DocTree header 添加 `⟳` 按钮，点击调用 `refreshState()`
- IwikiModule `onMount` 调用 `refreshState()`，确保每次切换到 iwiki 都拿到最新数据

## plan_review 渲染

Composer.svelte 新增 `kind === 'plan_review'` 分支：

```
┌─────────────────────────────────────┐
│  Plan Review                        │
│  ┌─────────────────────────────────┐│
│  │ (plan markdown rendered here)   ││
│  └─────────────────────────────────┘│
│  [📄 View document]                 │
│  [✓ Approve plan]  [✗ Revise]       │
└─────────────────────────────────────┘
```

- `action.markdown` 用 `<Markdown>` 组件渲染
- "View document" 设置 `pendingDocSelection` → 触发导航
- "Approve plan" / "Revise" 调用 `POST /api/sessions/{id}/plan_response`

## plan_response 端点

新增 `POST /api/sessions/{id}/plan_response`：

```json
{ "plan_id": "...", "accept": true, "note": "optional feedback" }
```

服务端处理：
1. 调用 `kode.planResponse(kode_session_id, planId, accept)` 通知 codebuddy
2. 若 `accept`：追加 system transcript，清除 required_action
3. 若 `!accept`：发送反馈文本到 kode session，清除 required_action

## 跨模块导航

1. Chat 端点击"View document" → `pendingDocSelection.set(docPath)`
2. `App.svelte` `$effect` 监听到 → `activeModule.set('iwiki')`
3. IwikiModule 挂载 → `$effect` 检测 `pendingDocSelection` → `refreshState()` → 找到文档 → `selectDocument()` → 清除 `pendingDocSelection`

## 关键设计决策

- **不轮询**：手动刷新 + 模块切换刷新，简单可控
- **导航意图用 writable store**：避免跨模块耦合，各模块自主消费 `pendingDocSelection`
- **服务端端点最小化**：只加 `plan_response`，复用 `kode.planResponse()` 桥接
- **不添加 i18n 翻译**：使用 `t()` fallback 显示英文 key，后续可在 i18n JSON 中补充中文翻译
