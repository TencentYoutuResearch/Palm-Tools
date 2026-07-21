# Design

## 状态同步架构

当前（断裂）：

```
Run state machine          Session state machine
(preparing/running/         (clarify/analyze_request/
 awaiting_verify/            plan_discussion/...
 awaiting_review/            run_in_worktree/
 completed/failed/           verify/review/
 cancelled)                  apply_patch/completed)
         │                           │
         └── transitionRun ──→  ❌ 无自动传播
         └── advanceRun ────→  ✅ publishReviewAction 只处理 review
         └── reconcile ─────→  ✅ 但仅 GET 请求触发
```

修复后：

```
Run state machine          Session state machine
         │                           │
         └── transitionRun ──→  ✅ 主动同步 session phase
         └── advanceRun ────→  ✅ verify 阶段分离通知
         └── reconcile ─────→  ✅ 启动时全量修复 + GET 兜底
```

## Run state → Session phase 映射表

所有同步共享同一映射，提取为 `sessionUpdateForRunState` 纯函数：

| Run state | Session phase | Session state | Required action |
|---|---|---|---|
| `preparing` | 无变化 | 无变化 | 无变化 |
| `running` | `run_in_worktree` | `active` | null |
| `awaiting_verify` | `verify` | `awaiting_user` | `{ kind: 'verify' }` |
| `awaiting_review` | `review` | `awaiting_user` | `{ kind: 'review', patch_files }` |
| `completed` | `apply_patch` | `awaiting_user` | `{ kind: 'apply_patch' }` |
| `applied_failed` | `apply_patch` | `awaiting_user` | `{ kind: 'apply_patch' }` |
| `failed` | `failed` | `failed` | null |
| `cancelled` | `cancelled` | `cancelled` | null |

注意：`awaiting_review` 的 `patch_files` 需要从 worktree git diff 中获取——与现有 `changedFilesForRun` 函数（server/index.ts:270-288）相同。

## 为什么在 `transitionRun` 中同步，而非另起协调器

`transitionRun` 是所有 Run 状态变化的统一入口（run.ts 的 11 处调用的共同目标）。在它内部增加 session 同步副作用：

- **事务边界清晰**：Run 状态写入成功后，立即同步 session——同一个函数调用栈，无需额外调度。
- **不会遗漏**：任何 Run 状态变化都必须经过 `transitionRun`，100% 覆盖。
- **无额外并发**：`transitionRun` 已持有 Run 的原子写入锁（临时文件 + rename），session 同步在此锁内串行执行。

## 失败语义

Session 同步是 best-effort：

- `transitionRun` 找不到关联 session（`run_id` 从未绑定 session）→ 静默跳过。
- 磁盘写入失败 → `console.warn`，不抛异常——Run 状态机不应被 session 元数据更新阻断。
- 与 `markChangeCompleted`（commands.ts:459-481）的处理模式一致。

## 为什么 `advanceRun` 要分离 verify 阶段

当前 `advanceRun`（run-monitor.ts:108-168）在 auto-verify 完成后直接推送 `review` action，跳过了 `verify` step。这导致 UI 显示的阶段进度条从 `running` 直接跳到 `review`，用户看不到"正在验证"这一中间状态。

修复方案：在调 `verifyRun(run)` 之前，先设 session phase 为 `verify`/`awaiting_user`/`{ kind: 'verify' }`，等 verify 完成后再调 `publishReviewAction` 推到 `review`。注意这里时序是异步的（verifyRun 是 async），需要确保 verify 完成后才切换。

## 向后兼容

- 现有 session 记录（20 个）的 desynced workflow steps：reconcile 读取时会触发 `normalizeRecord` → `syncWorkflow`，自动修复 step states。
- 现有 session 记录丢失了真实的预计划阶段时间戳：这是历史数据的固有限制，不尝试修复。
- 现有 run 记录（14 个）无 `change_id`，不影响 session 同步（session 按 `run_id` 匹配）。

## 为什么不在 session-monitor.ts 中做同步

`session-monitor.ts` 负责拉取会话 transcript 和 kode session 状态，不关心 Run 状态变化。Run 状态变化由 `run-monitor.ts` 和 `run.ts` 管理。保持职责分离：Run 状态变化 → run.ts 通知 session；kode session 状态变化 → session-monitor.ts 更新 agent。

## 为什么不需要改 `syncWorkflow`

`syncWorkflow`（session.ts:222-258）已经正确实现了「根据 `record.phase` 和 `record.state` 同步所有 workflow step states 和时间戳」的逻辑。它唯一的问题是历史代码未调用它。本提案的 Task 1~3 确保所有写入路径都经过 `transitionRun`（触发 `syncWorkflow`），启动时的 reconcile 还会额外修复存量数据。
