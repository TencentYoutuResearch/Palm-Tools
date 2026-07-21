# Tasks

- [ ] Task 1 — `RunRecord` 加 `change_id: string | null` 字段 + `createRun` 透传 + `readRun` backfill  【verify: specops】
  - 文件：`apps/specops/src/domain/run.ts`
  - `RunRecord` 接口（29-52 行）在 `kode_session_id` 后加 `change_id: string | null`。
  - `createRun`（117 行）签名加 `changeId?: string | null`，构造 run 对象时设 `change_id: changeId ?? null`。
  - `readRun`（102 行）加 `if (run.change_id === undefined) run.change_id = null`（与 `review_results` backfill 模式一致）。
  - 测试：`createRun` 带 changeId 时 record 含该字段；不带时为 null；读 legacy run.json（无字段）不崩。

- [ ] Task 2 — 新增 `markChangeCompleted` 辅助函数  【verify: specops】
  - 文件：`apps/specops/src/domain/commands.ts`（与 `archiveChange` 扫描逻辑放一起）
  - 签名：`export async function markChangeCompleted(workspace: string, changeId: string | null): Promise<void>`
  - 实现：复用 `archiveChange`（442-493 行）扫描模式——遍历 `changes/`（跳过 `archive/`），找 `proposal.md` frontmatter `id === changeId`，`parseDocument` → 设 `status: 'completed'` → `atomicWrite(serializeDocument(...))`。
  - `changeId === null` 直接 return；找不到匹配 folder 静默 return。
  - 测试：有匹配 folder 时状态变 completed；无匹配不报错；changeId 为 null 时 no-op。

- [ ] Task 3 — apply 成功后自动调用 `markChangeCompleted`  【verify: specops】
  - 文件：`apps/specops/src/domain/run-loop.ts`
  - `applyCompletedRun`（307-316 行）：在 `return { applied: true, commit: result.commit }` 前，若 `run.change_id !== null` 调用 `markChangeCompleted(run.workspace_root, run.change_id)`；`applied: false`（no_changes）分支也调用。
  - `applyWithVerify`（318-356 行）：`allOk` 分支（349-351 行）transition 到 `completed` 后调用；`applied_failed` 分支不调用。
  - 用 `try/catch` 包裹，失败只 `console.warn`（与 `commitPlanDocs` 179-199 行模式一致）——状态更新失败不阻断 apply 主流程。
  - 测试：apply 成功后 proposal.md 状态为 completed；change_id 为 null 时 proposal 不变。

- [ ] Task 4 — server 路径透传 `change_id`  【verify: specops】
  - 文件：`apps/specops/src/server/index.ts`
  - `POST /api/runs`（969-1022 行）：解析 body 读 `raw.change_id`（string 可选），传给 `launchRun`。
  - `launchRun`（`run-loop.ts:37`）签名加 `changeId?: string`，透传 `createRun`。
  - `run_in_worktree` action（423-454 行）：从 `session.document_path` 用 `canonicalDocumentKey`（`session.ts:357`）反解 folder，再从 folder 取 change_id（读 proposal.md frontmatter）；拿不到则传 undefined。
  - `POST /api/quick-run`（1023-1071 行）：不传 change_id（保持现状）。
  - `POST /api/runs/{id}/apply` 和 session action `apply`：不需改——`applyCompletedRun` 从 `run.change_id` 自取。
  - 测试：带 change_id 创建 run 后 record 含该字段。

- [ ] Task 5 — 更新 skill 文档（src 原件 + `.codebuddy/skills/` 镜像，两份都改）  【verify: specops】
  - `specops.create-run.md`：Request Body（13-28 行）加可选 `change_id` 字段说明。
  - `specops.apply-run.md`："After Apply"（30-42 行）说明"proposal.md 状态自动变为 completed，用户只需 commit + archive"。
  - `specops.workflow.md` Phase 5（75-86 行）：明确 apply→completed（自动）、archive→archived 的自动转换。
  - `specops.archive-change.md` Prerequisite（31-35 行）：改为"apply-run 已自动置为 completed；历史 proposed 亦可直接 archive（向后兼容）"。
  - `dist/skills/*.md` 由 `pnpm build` 重新生成，不需手改。

- [ ] Task 6 — `archiveChange` 兼容性 + legacy 路径注释  【verify: specops】
  - 文件：`apps/specops/src/domain/commands.ts`
  - `archiveChange`（442-493 行）：不强制校验 `completed`——若当前为 `proposed` 仍允许归档（兼容 17 个历史 proposed）。可在返回 diagnostics 加 `warning`（非 error）提示 "change was proposed, not completed"。
  - `commands.ts:176-194` legacy archive 迁移：已执行过，不改代码。在函数上方注释说明 "手动 mv 不会更新 status；必须用 archiveChange 才会置 archived"。
