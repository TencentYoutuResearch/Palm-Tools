---
schema_version: 1
id: fix-specops-post-merge-status-transition
kind: refactor
title: 修复 SpecOps 合并后 changes 文档状态不更新的流程缺口
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/domain/run.ts
  - apps/specops/src/domain/run-loop.ts
  - apps/specops/src/domain/commands.ts
  - apps/specops/src/server/index.ts
  - apps/specops/src/skills/specops.create-run.md
  - apps/specops/src/skills/specops.apply-run.md
  - apps/specops/src/skills/specops.workflow.md
  - apps/specops/src/skills/specops.archive-change.md
  - .codebuddy/skills/specops.create-run.md
  - .codebuddy/skills/specops.apply-run.md
  - .codebuddy/skills/specops.workflow.md
  - .codebuddy/skills/specops.archive-change.md
---

# 修复 SpecOps 合并后 changes 文档状态不更新的流程缺口

## Motivation

用户原话（verbatim）：

> 目前specops执行完成合并完后，没有将对应的changes文档状态改变，你看看怎么优化下流程

### 现状诊断（基于代码探索，非主观判断）

SpecOps 的 Phase 5 流程（`specops.workflow.md:75-86`）定义为：run `completed` → `apply-run`（把 patch 落到主工作区）→ 用户 commit → `archive-change`（移 folder 到 `changes/archive/`，置 `status: archived`）。但实际数据流存在三处断裂：

1. **`completed` 状态从未被任何代码路径设置。** `DocumentStatus` 枚举（`apps/specops/src/domain/spec.ts:8`）为 `'draft' | 'active' | 'proposed' | 'completed' | 'archived'`——`completed` 存在但从未被写入。唯一写 proposal `status:` 的地方是 `archiveChange`（`apps/specops/src/domain/commands.ts:482`）写 `archived`。
2. **Run 与 change proposal 没有数据层关联。** `RunRecord`（`apps/specops/src/domain/run.ts:29-52`）没有 `change_id` 字段——14 个 `run.json` 全为 null/缺失。`applyRunPatch`（`run.ts:297+`）只 mutate git 状态，即便想更新 proposal 也无从得知是哪一个。
3. **`archive-change` 的前置条件形同虚设。** `specops.archive-change.md:35` 说 "Change should be in `completed` status before archiving"——但 `completed` 从不被设置，archive 仍照常执行。

### 磁盘证据

- 17 个 active change 全为 `status: proposed`。
- 2 个已移入 `changes/archive/` 的 folder 仍为 `proposed`（legacy 迁移 `commands.ts:176-194` 直接 `rename`，不更新 frontmatter）。
- 2 个被手动改为 `completed`（无任何工具支持）。
- 0 个 `merged`（该状态在类型中根本不存在）。

### 为何现在修

既有提案 `cleanup-specops-document-staleness` 诊断了同一病灶，但它只清理存量脏数据，并**刻意把 "Adding automated staleness detection to the SpecOps server" 列为 Out of scope**。本提案补上它跳过的那一半——修复流程本身，而不是反复手动清理。

## Scope

### In scope

- 给 `RunRecord` 加 `change_id: string | null` 字段（可选，向后兼容 14 个 legacy run.json）。
- 新增 `markChangeCompleted(workspace, changeId)` 辅助函数：扫描 `changes/` 找匹配 `id` 的 proposal.md，置 `status: completed`，原子写回。
- 在 `applyCompletedRun` 和 `applyWithVerify` 的成功分支自动调用 `markChangeCompleted`——补上 `proposed → completed` 的缺失转换。
- `POST /api/runs` 接受可选 `change_id`；`run_in_worktree` action 从 `session.document_path` 反解并透传。
- 同步更新 4 份 skill 文档（`create-run` / `apply-run` / `workflow` / `archive-change`）的 src 原件与 `.codebuddy/skills/` 镜像——两份手动维护，`pnpm build` 只重新生成 `dist/`。
- `archiveChange` 放宽前置条件：允许 `proposed` 直接归档（兼容 17 个历史 proposed），但可加 `warning` diagnostic。

### Out of scope

- **不引入 `merged` 状态值。** 用既有的 `completed`（改枚举 + 所有消费方波及面过大，且 `merged` 与 `completed` 语义高度重叠）。
- **不做 run↔change 的反向查询 API。** 只在 apply 时单向写状态，不新增"列出某 change 的所有 run"端点。
- **不自动 commit。** apply 后用户仍需手动 commit（git 层动作，SpecOps 不接管）。
- **不自动 archive。** archive 仍是显式步骤（用户确认 commit 后才归档）。
- **不修改 `cleanup-specops-document-staleness` proposal。** 那是文档清理任务，本提案是流程修复，互不干涉。
- **不重构 `archiveChange` 的扫描逻辑为公共 helper。** `markChangeCompleted` 复制少量扫描代码即可，不值得提前抽象（YAGNI）。
- **不改 `constitution.md`。** 本提案不涉及 PTY / backend / run-isolation 等核心不变量。
- **不处理 `355425ba` / `c58dc251` 等手动改 `completed` 的历史数据。** 它们已是 `completed`，apply 不会重复处理（状态已对）。
- **不改 legacy archive 迁移代码**（`commands.ts:176-194`）——已执行过，仅加注释说明"手动 mv 不会更新 status"。

## Design decisions

### 用 `completed`，不引入 `merged`

`DocumentStatus` 已含 `completed`，且 `archiveChange` 已会写 `archived`。新流转链路 `proposed → completed → archived` 自然衔接，无需新增枚举值。引入 `merged` 需改 `STATUSES` 集合（`spec.ts:47`）、`defaultStatusForKind` 及所有读状态的 UI/扫描代码，波及面与收益不成比例。

### apply 自动设 `completed`，而非要求显式触发

用户痛点正是"合并完后状态没变"。若仍需手动调用一个新命令，等于没修。`applyRunPatch` 在 `withApplyLock` 内成功 merge 分支（`run.ts:359`），是天然的同步点——在同一个锁内追加一次 proposal.md 状态写入，事务边界清晰。用户随后的 commit 是 git 层动作，不影响 SpecOps 状态机；`completed` 表达的是"SpecOps 视角下实施已完成"，不是"已 push 到 main"。

### `change_id` 在 RunRecord 上，可选

14 个 legacy run.json 无此字段。强制必填会破坏读路径。`createRun`（`run.ts:117`）加可选 `changeId?: string | null` 参数，`readRun`（102 行）backfill 为 null（与 `review_results` 的 backfill 模式一致，108 行）。apply 路径读 `run.change_id`：为 null 时跳过（quick-run 不受影响），有值时才写 proposal.md。

### `change_id` 放 RunRecord 而非复用 session.document_path

`SpecOpsSessionRecord` 已有 `document_path`（`session.ts:92`）和 `findSpecOpsSessionByRunId`（`session.ts:340`）能反查。但 run 可能脱离 session 独立存在（CLI 直接 `POST /api/runs`），`applyRunPatch` 接收的是 `RunRecord` 不应反向查 session 文件系统。把 `change_id` 放 run 上，apply 路径自洽。`change_id` 即 proposal.md frontmatter 的 `id` 字段，与 `archiveChange` 入参一致，便于复用查找逻辑。

## Constitution conflicts

无。本提案不触及 `constitution.md` 列出的任何不变量（PTY lifecycle、backend default args、run isolation）。run isolation spec 规定"applying approved output is a separate, explicit action"——本提案不改变这一性质，apply 仍是显式动作，只是 apply 成功后追加一次 best-effort 状态写入。

## Acceptance criteria

- [ ] `RunRecord` 含 `change_id: string | null` 字段；`createRun` 接受可选 `changeId` 参数。
- [ ] 读无 `change_id` 字段的 legacy run.json 不崩（backfill 为 null）。
- [ ] `applyCompletedRun` 成功后，若 `run.change_id` 非空，对应 proposal.md 的 `status` 变为 `completed`。
- [ ] `applyWithVerify` 的 `allOk` 分支同样触发状态更新；`applied_failed` 分支不触发。
- [ ] `run.change_id === null` 时 apply 不触碰任何 proposal.md（quick-run 不受影响）。
- [ ] `markChangeCompleted` 找不到匹配 folder 时静默返回（不抛错）。
- [ ] `archiveChange` 仍能归档 `proposed` 状态的 change（不阻断历史数据）。
- [ ] `POST /api/runs` 接受可选 `change_id`；`run_in_worktree` action 能从 session.document_path 反解并透传。
- [ ] skill 文档（create-run / apply-run / workflow / archive-change）反映新的自动状态转换。
- [ ] `pnpm test`（apps/specops）全绿；新增测试覆盖 change_id 透传、apply 后状态更新、legacy 兼容。
- [ ] 现有 14 个 run.json（全 null change_id）和 17 个 proposed changes 不受影响——无破坏性迁移。

## Out of scope

见上文 Scope / Out of scope 小节。
