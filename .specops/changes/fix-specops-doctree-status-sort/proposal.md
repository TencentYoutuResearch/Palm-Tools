---
schema_version: 1
id: fix-specops-doctree-status-sort
kind: bug
title: SpecOps 文档列表组内按状态排序优化
status: proposed
verifies:
  - specops
paths:
  - apps/specops/frontend/src/components/iwiki/DocTree.svelte
---

# SpecOps 文档列表组内按状态排序优化

## Motivation

SpecOps 的 DocTree 按文档类型分组合并展示，但**每组内条目按服务端 mtime 排序**（最新文件优先）。用户期望每组内 **active 状态的文档排在前面**，便于快速定位活跃文档。

## Scope

对 DocTree 组件每个类型分组内的文档列表，按 status 优先级重新排序：`active > proposed > completed > draft > archived`。只改前端渲染逻辑，不改后端 scan/sort 的 flat sort。

## Acceptance criteria

- [ ] Specs 分组内 active 状态的 spec 排在最前
- [ ] Changes 分组内 proposed 状态的 change 排在 active 之后
- [ ] Archive 分组内 archived 状态排在最后
- [ ] 未识别的 status 降级到组尾
- [ ] 现有 specops 测试不失败

## Out of scope

- 不改后端 `commands.ts` 的 `scanWorkspace` mtime 排序
- 不改 app.js 旧控制台的渲染
- 不改搜索/过滤功能
- 不添加 mtime 作为 status 内二级排序

## Constitution conflicts

无冲突。本提案不涉及 PTY 生命周期、backend 默认参数、worktree 隔离等 constitution invariant。
