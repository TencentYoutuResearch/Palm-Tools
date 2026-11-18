---
schema_version: 2
id: fix-monitor-directory-groups
kind: bug
document_class: work_item
work_type: bug
title: 按目录分组 Monitor 会话并保持 Worker 列表顺序
status: proposed
verifies:
  - svelte
paths:
  - apps/gui/src/App.svelte
  - apps/gui/src/lib/monitor_groups.ts
  - apps/gui/tests/monitor_groups.test.ts
---

# 按目录分组 Monitor 会话并保持 Worker 列表顺序

## Motivation

Worker 模式的 tab 按 cwd 分组，但 Monitor 模式把远端会话直接平铺，导致同一
目录的会话无法快速聚合，也和 Worker 模式的信息结构不一致。

## Scope

- Monitor 会话按 cwd 分组。
- 目录按会话在 Worker 列表中的首次出现顺序排列。
- 组内会话保持 Worker 返回顺序。
- 目录名取路径最后一段，兼容 POSIX 和 Windows 路径。
- 多个目录同名时显示父路径提示。
- 多目录时支持与 Worker 模式相同的折叠交互。

## Acceptance criteria

- [x] Monitor 会话按目录显示 group header。
- [x] group 顺序与 Worker 返回列表中的首次出现顺序一致。
- [x] group 内的会话顺序与 Worker 返回顺序一致。
- [x] Windows `D:\...` 路径显示正确的目录名。
- [x] 缺少 cwd 的会话进入 Other，不隐藏。
