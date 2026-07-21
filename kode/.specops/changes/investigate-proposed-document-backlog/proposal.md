---
schema_version: 2
id: investigate-proposed-document-backlog
kind: investigation
document_class: work_item
work_type: investigation
title: 调查 changes 文档大量处于 proposed 状态的原因并清理
status: cancelled
verifies:
  - specops
paths:
  - .specops/changes/
  - apps/specops/src/domain/run.ts
  - apps/specops/src/domain/commands.ts
---

# 调查 changes 文档大量处于 proposed 状态的原因并清理

## Motivation

用户原话（verbatim）：

> 你看看当前还是有很多文档在changes下面的状态是proposed，为啥没有改变呢

### 现象

截至 2026-07-01，`.specops/changes/` 下有 **19 个 active change folder**，其中 **17 个处于 `status: proposed`**，仅 2 个是 `completed`。没有 `implemented`、`draft` 等中间状态。

### 根因：流程链条上缺失 `proposed → completed` 的自动转换

SpecOps 的生命周期定义为：

```
proposed → (approval) → run created → run executing → verify → decide → apply → completed → archived
```

但代码中**没有任何路径将 proposal 的 status 从 `proposed` 设为 `completed`**。整个链路上有三个断裂点：

1. **`RunRecord` 与 change proposal 没有数据层关联。** `RunRecord`（`run.ts:29-52`）原本没有 `change_id` 字段。apply 时即便想更新 proposal 也无从得知是哪一个。

2. **`completed` 状态值存在但从未被写入。** `DocumentStatus` 枚举含 `completed`，但唯一写 proposal status 的代码是 `archiveChange`（写 `archived`）。

3. **`archive-change` 前置条件形同虚设。** 文档说 "Change should be in `completed` status before archiving"，但 `completed` 从不被设置，archive 仍照常执行，直接 `proposed → archived`。

### 交叉验证结果

通过 git log 与 session 记录交叉验证，确认了每个 proposal 的实际完成状态：

| Folder | Proposal Status | Tasks | 实际完成 | 裁决 |
|---|---|---|---|---|
| `specs-frontmatter-batch` | completed | 13/13 | frontmatter 已加至 11 个 spec 文件 | **已完成** |
| `migrate-docs-to-specops` | completed | 36/36 | 文件已 git mv | **已完成** |
| `fix-gate-errors-and-intake-ordering` | proposed | 12/13 | gate suppression + intake ordering 已实现 | **已完成** |
| `fix-specops-session-expand-control-location` | proposed | 0/6 | commit `2c3ace8` 已实现 | **已完成** |
| `workspace-panel-expand-button` | proposed | 0/6 | WorkspacePanel.svelte 已在 `2c3ace8` 创建 | **已完成** |
| `fix-gui-remote-memory-not-visible` | proposed | 0/9 | run `755ec613` 已完成并 merge | **已完成** |
| `fix-specops-session-resume` | proposed | 0/7 | commit `39e22a8` 已实现 | **已完成** |
| `7dff952b` | proposed | 0/9 | run `4b124083` 已完成，registry 已更新 | **已完成** |
| `c58dc251` | proposed | 8/8 | investigation 完成，发现已记录 | **已完成** |
| `specops-branch-based-apply` | proposed | 0/11 | commit `6f827f1` 已实现 | **已完成** |
| `fix-specops-post-merge-status-transition` | proposed | 0/11 | run `5c1305ed` 已 merge（`1663010`），`change_id` + `markChangeCompleted` 已合入 main | **已完成** |
| `gui-dark-mode-tab-grid-bg` | proposed | 0/8 | run `4b124083` 已 merge，但 CSS 修复**未完全应用** | **部分完成** |
| `fix-gui-status-bar-vertical-center` | proposed | 0/8 | plan commit `95692dc` 存在，但无 run commit | **部分完成** |
| `cleanup-specops-document-staleness` | proposed | 2/21 | constitution populated, archives created，19 tasks 未完成 | **部分完成** |
| `fix-specops-independent-region-scroll` | proposed | 0/6 | plan commit 存在，无 run commit | **未完成** |
| `fix-gate-signals-diagnostics` | proposed | 0/8 | 无 run commit | **未完成** |
| `355425ba` | proposed | 0/7 | 无 run commit，PTY UTF-8 边界保护未实现 | **未完成** |
| `investigate-gate-signals-28` | proposed | 0/6 | investigation 未执行 | **未完成** |
| `fix-migrate-docs-proposal-staleness` | proposed（已归档） | - | bug 已修复，已移至 archive | **已过时** |

### 流程修复已就位

`fix-specops-post-merge-status-transition`（commit `75d07d1` → merge `1663010`）已经实施：
- `RunRecord` 新增 `change_id` 字段
- `markChangeCompleted()` 函数实现
- `applyCompletedRun` / `applyWithVerify` 成功后自动调用 `markChangeCompleted`
- 从此以后，**通过 SpecOps Run 完成的 change 将自动从 `proposed` 转换为 `completed`**

### 为什么 proposals 堆积

1. **流程修复之前**（commit `75d07d1` 之前），任何 run 完成都不会更新 proposal 状态
2. 大部分工作通过 `specops(plan):` 格式的 commit 直接完成，跳过了正式的 SpecOps Run
3. `cleanup-specops-document-staleness` 诊断了此问题但**自己也是 `proposed`**，形成死循环
4. 没有定期审查和清理的机制

## Scope

### In scope

1. 分析 proposals 堆积的根因（已完成，见上文）
2. 将**已实际完成**的 proposals 手动标记为 `status: completed`，勾选对应 tasks
3. 归档已过时的 proposal（`fix-migrate-docs-proposal-staleness` 已在 archive 下有副本）
4. 记录仍未完成和部分完成的 proposals 状态

### Out of scope

- 修改 SpecOps server 代码（`fix-specops-post-merge-status-transition` 已完成流程修复）
- 实施尚未完成的 proposals（属于各自 change 的范围）
- 审查每个 proposal 的实现质量
- 自动化 staleness detection（属于 `cleanup-specops-document-staleness` 的 Out of scope）

## Design decisions

### 标记 `completed` vs 归档

- **标记为 `completed`**：工作已实际完成且合入 main，只是 proposal 状态未更新。保持 change folder 在原位，便于后续归档。
- **不主动归档**：archive 是显式步骤（用户确认 commit 后才归档），本 investigation 不越权。
- **`fix-migrate-docs-proposal-staleness`**：已在 `changes/archive/` 下有副本，active 目录下的为重复。将其从 active 目录移除（已在 archive 中）。

### 部分完成的 proposals 处理

- `gui-dark-mode-tab-grid-bg`：CSS 修复未完全应用，标记为 `completed` 不合适。保留 `proposed`，勾选已完成的任务。
- `fix-gui-status-bar-vertical-center`：无 run commit 但 plan 已存在。保留 `proposed`。
- `cleanup-specops-document-staleness`：部分完成（constitution populated, archives created），勾选已完成任务，保留 `proposed` 供后续完成。

## Acceptance criteria

- [ ] 11 个已完成的 proposals 的 `proposal.md` 中 `status` 改为 `completed`
- [ ] `fix-migrate-docs-proposal-staleness` 的 active 目录副本已清理（archive 中已有）
- [ ] 3 个部分完成的 proposals 的 `tasks.md` 中已完成的任务已勾选
- [ ] 5 个未完成的 proposals 保持不变（`proposed`）
- [ ] `pnpm test`（apps/specops）全绿

## Out of scope

见上文 Scope / Out of scope 小节。

## Constitution conflicts

无。本 investigation 仅修改 `.specops/changes/` 下的文档状态，不触及 PTY lifecycle、backend default args、run isolation 等不变量。
