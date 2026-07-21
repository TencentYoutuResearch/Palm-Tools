# Tasks

- [ ] Task 1 — `transitionRun` 增加主动 session phase 同步副作用  【verify: specops】
  - 文件：`apps/specops/src/domain/run.ts`
  - 在 `transitionRun`（约 450 行）的成功路径中，查找关联的 SpecOps session（通过遍历 sessions，匹配 `run_id`）。
  - 根据 run 的新 state 映射 session phase：
    - `preparing` → 无变化
    - `running` → `phase: 'run_in_worktree'`, `state: 'active'`
    - `awaiting_verify` → `phase: 'verify'`, `state: 'awaiting_user'`, `required_action: { kind: 'verify' }`
    - `awaiting_review` → `phase: 'review'`, `state: 'awaiting_user'`, `required_action: { kind: 'review', patch_files }`
    - `completed` → `phase: 'apply_patch'`, `state: 'awaiting_user'`, `required_action: { kind: 'apply_patch' }`
    - `failed` → `phase: 'failed'`, `state: 'failed'`
    - `cancelled` → `phase: 'cancelled'`, `state: 'cancelled'`
    - `applied_failed` → `phase: 'apply_patch'`, `state: 'awaiting_user'`, `required_action: { kind: 'apply_patch' }`
  - 用 try/catch 包裹，失败只 `console.warn`（不阻断 Run 状态机）。
  - 测试：创建 session + run，transition run 状态后断言 session.phase 正确。

- [ ] Task 2 — `advanceRun` 增加 verify 阶段 session 通知  【verify: specops】
  - 文件：`apps/specops/src/domain/run-monitor.ts`
  - 在 `advanceRun` 的 `verifyRun(run)` 调用之前，先调 `updateSpecOpsSession` 设置 session phase 为 `verify`。
  - 现有 `publishReviewAction` 负责 `verify` 完成后通知 `review`，保持不变。
  - 测试：模拟 monitor advance，验证 session phase 经历了 `verify → review` 两个阶段。

- [ ] Task 3 — `reconcileRunBackedSessions` 增加启动时修复 + 覆盖所有状态  【verify: specops】
  - 文件：`apps/specops/src/server/index.ts`
  - `reconcileRunBackedSessions` 当前处理 `awaiting_review`/`awaiting_verify`/`completed`/`applied_failed`/`failed`/`cancelled`——缺少 `preparing`（跳过即可）。
  - 在 server 启动路径（`serve` 函数中）增加一次 `reconcileSessions` 调用，确保进程重启后 session 状态与 Run 一致。
  - 不需要单独修复 `syncWorkflow`——该函数在每个读写路径中自动运行，启动时的 reconcile 会触发它。

- [ ] Task 4 — 提取共享的 `sessionPhaseForRunState` 映射函数  【verify: specops】
  - 文件：可新建 `apps/specops/src/domain/run-sync.ts`（或放在 `run.ts` 底部）
  - 提取 Task 1/2/3 中重复的 run state → session phase 映射逻辑为单个纯函数：
    - `function sessionUpdateForRunState(run: RunRecord): { phase: SpecOpsPhase; state: SpecOpsSessionState; required_action: RequiredAction | null } | null`
  - 这样 `transitionRun`、`advanceRun`、`reconcileRunBackedSessions` 三处共享同一映射。
  - 保证未来新增 Run 状态时只需改一处。

- [ ] Task 5 — 更新 skill 文档（src 原件 + `.codebuddy/skills/` 镜像）  【verify: specops】
  - `specops.workflow.md` Phase 5（75-86 行）：明确 session phase 与 Run state 的自动同步关系。
  - 只在 src 原件与 `.codebuddy/skills/` 镜像中改，`dist/skills/` 由 `pnpm build` 重新生成。

- [ ] Task 6 — 验证现有 session 数据修复  【verify: specops】
  - 启动 server 后，确认 session `e56b6365-2e69-4329-a90d-829f738b8747` 的 `workflow.current_phase` 和 step states 被自动修复。
  - 写一个最小集成测试（读取磁盘 session → `normalizeRecord` → 验证 step states）。
