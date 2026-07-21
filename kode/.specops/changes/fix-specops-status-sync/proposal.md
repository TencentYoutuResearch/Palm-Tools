---
schema_version: 1
id: fix-specops-status-sync
kind: bug
title: 修复 SpecOps session 中 intake / plan / build / verify / apply 阶段状态不同步的问题
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/domain/session.ts
  - apps/specops/src/domain/run-monitor.ts
  - apps/specops/src/domain/run.ts
  - apps/specops/src/server/index.ts
---

# 修复 SpecOps session 中 intake / plan / build / verify / apply 阶段状态不同步的问题

## Motivation

用户原话（verbatim）：

> specops的document中，intake plan build verify apply这些状态没有同步，你修复下

### 现状诊断（基于代码和数据探索，非主观判断）

SpecOps 工作流定义了从 `clarify` → `analyze_request`（Intake）→ `plan_discussion`/`solution_options`/`plan_approved`（Plan）→ `run_in_worktree`（Build/Implementation）→ `verify` → `review` → `apply_patch`（Apply）→ `completed` 的完整阶段链。Session 记录包含 `phase` 字段（当前阶段）和 `workflow.steps[]`（各步骤状态与时间戳）。Run 状态机独立运行，通过 `reconcileRunBackedSessions` 映射到 session phase。

实际运行中，存在以下三处不同步：

#### 1. Run 状态变更未主动传播到 Session phase（最严重）

Run 状态机独立于 Session 状态机。当 Run 状态变化（通过 `transitionRun`），对应的 Session phase 仅在以下路径更新：

- `run-monitor.ts:177` — `publishReviewAction` 主动写 session phase → `review`
- `reconcileRunBackedSessions` — 仅通过 `GET /api/sessions` 和 `GET /api/sessions/:id` 触发（`server/index.ts:497,505`）

其他关键路径缺失主动传播：

| Run 状态变更 | 触发位置 | Session phase 是否更新 |
|---|---|---|
| `running` → `awaiting_verify` | `advanceRun`（run-monitor.ts:134 调 verifyRun） | ❌ 直接跳到 `review` |
| `running` → `awaiting_review` | `publishReviewAction`（run-monitor.ts:177） | ✅ → `review` |
| `awaiting_review` → `running`（反馈回灌） | `decideRun`（run-loop.ts） | ❌ 依赖 server/index.ts 响应中手动配置 |
| `running` → `failed`/`cancelled` | `transitionRun`（run.ts） | ❌ 仅 reconcile 时修复 |
| `completed`（apply 成功后） | apply 路径（server/index.ts:744） | ✅ → `completed`（在 server 响应中手动设置） |

#### 2. Workflow step states 与实际 phase 不同步（持久化历史数据）

磁盘数据已证实存在不一致。示例 session `e56b6365-2e69-4329-a90d-829f738b8747`：

```
phase: completed          # session 已完成
state: completed
workflow.current_phase: review    # ❌ 应该为 completed，但停留在 review
steps:
  review:   state=active          # ❌ 应该为 done
  apply_patch: state=pending       # ❌ 应该为 done
  completed:  state=pending       # ❌ 应该为 done
```

`syncWorkflow` 函数（`session.ts:222-258`）已在 `normalizeRecord`（每个读写路径）中运行，理论上应自动修复此问题。但数据显示该同步要么：
- 未在最终一次写入时运行（历史代码），要么
- 由于 `workflow` 对象引用方式的微妙问题未能生效

#### 3. Intake receipt 完成后到 `run_in_worktree` 的跳转可能丢失

`reconcileCompletedIntakeSessions`（`server/index.ts:218-263`）仅在 GET API 请求时执行。如果 intake 完成后，用户立即执行下一操作（如直接创建 Run），intake 完成阶段的自动跳转（`analyze_request` → `run_in_worktree`）尚未触发。

### 磁盘证据

- 20 个 session 记录中，至少 1 个存在明显的 workflow step state 不同步（`e56b6365`）。
- 若干 session 的 `workflow.current_phase` 与 `phase` 字段不一致。
- 早期（`plan_discussion` 之前的）workflow step 时间戳全部相等（均为 `syncWorkflow` 被调用时的 `now()`），丢失了真实的阶段时间。

### 为何现在修

既有的 `fix-specops-post-merge-status-transition` 修复了 proposal.md 文档 `status` 字段的缺失转换（`proposed → completed`），但本次报告的是 **session 运行态**的不同步，两者正交但同样影响用户体验。console UI 中的阶段进度条、当前步骤高亮、等待动作指示等依赖于正确的 workflow step state。

## Scope

### In scope

- 在 `transitionRun`（`run.ts`）的成功路径中主动触发 session phase 同步：当 run.state 变化时，查找关联的 session 并更新其 `phase`/`state`/`required_action`。
- 在 `run-monitor.ts` 的 `advanceRun` 中，走 `awaiting_verify` → `verify` session phase，而非直接跳到 `review`，使 UI 能看到 verify 阶段。
- 为 `reconcileSessions` 增加启动时的一次性全量修复，修复现有 desynced session 数据。
- 增加一个简易的 session 级别 phase 同步钩子，在每次 session 读取时确保 `workflow.steps` 与 `phase`/`state` 一致（验证现有 `syncWorkflow` 是否生效）。
- 增加单元测试覆盖 Run 状态变化后的 session phase 同步。

### Out of scope

- 不新增 API 端点或修改协议格式。
- 不改 `SpecOpsPhase` 枚举或 `WorkflowStepState` 类型定义。
- 不改 `constitution.md`（不涉及 PTY/backend/run-isolation 不变量）。
- 不改 `fix-specops-post-merge-status-transition` 引入的 `change_id`/`markChangeCompleted` 逻辑。
- **不做全量历史数据修复**——仅修复读取路径（reconcile 时自动修复），不写一次性 migration 脚本。
- 不改 UI 渲染逻辑（console 前端），只确保后端数据正确。
- 不处理 session 时间戳不准确的问题（所有历史时间戳固化在磁盘上的 `now()` 值无法回溯）。

## Design decisions

### Run 状态变化时主动同步 session，不依赖 reconcile

当前设计仅在 GET API 响应中调一次 `reconcileSessions`。这意味着如果 Run 在后台异步变化（如 run-monitor 自动 verify），session phase 到下一次 GET 请求才更新。最佳方案是在 `transitionRun` 的成功路径中作为副作用同步 session phase——同一事务边界，无需额外协调器。

### 保留 `reconcileSessions` 作为兜底修复

启动时和 GET API 路径仍需 `reconcileSessions` 来修复因进程重启、异常中断等导致的存量不同步。这两种机制并存但不冲突：`transitionRun` 负责主动推，`reconcile` 负责兜底扫。

### 分离 `verify` 和 `review` session phase

当前 `run-monitor.ts` 的 `advanceRun` 从 `running` 直接跳到 `review` session phase，跳过了 `verify`。这会使用户看不到"正在验证"的阶段。应在 verify 开始前先将 session phase 设为 `verify`，`awaiting_review` 时再设为 `review`。

## Constitution conflicts

无。本提案不触及 `constitution.md` 列出的任何不变量（PTY lifecycle、backend default args、run isolation）。

## Acceptance criteria

- [ ] `transitionRun` 在 run 状态从 `running` → `awaiting_verify` 时，自动将关联 session 的 `phase` 设为 `verify`，`state` 设为 `awaiting_user`，`required_action` 设为 `{ kind: 'verify' }`。
- [ ] `transitionRun` 在 run 状态从 `running` → `failed`/`cancelled` 时，自动将关联 session 同步为对应终止态。
- [ ] `run-monitor.ts` 的 verify 路径先发 session phase `verify`，再执行 verify，成功后切换至 `review`。
- [ ] `reconcileRunBackedSessions` 覆盖所有 Run 状态，包括 `preparing`。
- [ ] 现有不不同步的 session 数据在下次 GET /api/sessions 时被自动修复。
- [ ] 无 `transitionRun` 调用处的回归（11 处引用，涵盖 createRun、decideRun、等）。
- [ ] `pnpm test`（apps/specops）全绿；新增测试覆盖 run→session phase 同步。

## Out of scope

见上文 Scope / Out of scope 小节。
