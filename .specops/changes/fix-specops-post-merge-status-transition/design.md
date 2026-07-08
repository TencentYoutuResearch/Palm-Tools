# Design

## 状态机流转

当前（断裂）：

```
proposed ──(apply-run)──?? ──(archive-change)──> archived
```

`completed` 存在于类型枚举但从未被写入；apply 不触碰 proposal.md；archive 直接从 `proposed` 跳到 `archived`。

修复后：

```
proposed ──(apply-run 成功)──> completed ──(archive-change)──> archived
```

- apply 成功（patch 落到主工作区）→ 自动写 `completed`。
- 用户 commit 后显式调 archive → 写 `archived` 并移 folder。

## 为什么不用 `merged`

`DocumentStatus`（`spec.ts:8`）已含 `completed`，且 `archiveChange`（`commands.ts:482`）已会写 `archived`。新流转链路 `proposed → completed → archived` 自然衔接，无需新增枚举值。

引入 `merged` 的代价：

- 改 `STATUSES` 集合（`spec.ts:47`）、`defaultStatusForKind`、所有读状态的 UI/扫描代码。
- `merged` 与 `completed` 语义高度重叠——SpecOps 里 "run 已 apply" 等于 "补丁已落到工作区并合并"，用户接下来 commit + archive。`completed` 足以表达 "实施完成，待归档"。

## 为什么 apply 自动设 `completed`

用户痛点是 "合并完后状态没变"。若仍需手动调一个新命令，等于没修。

`applyRunPatch`（`run.ts:297+`）在 `withApplyLock` 内成功 merge 分支（`run.ts:359`），是天然的同步点——在同一个锁内追加一次 proposal.md 状态写入，事务边界清晰。用户随后的 commit 是 git 层动作，不影响 SpecOps 状态机；`completed` 表达的是 "SpecOps 视角下实施已完成"，不是 "已 push 到 main"。

## `change_id` 可选，不强制

14 个 legacy run.json 无此字段。强制必填会破坏读路径。`readRun`（102 行）backfill 为 null（与 `review_results` backfill 模式一致，108 行）。apply 路径读 `run.change_id`：null 时跳过（quick-run 不受影响），有值时才写 proposal.md。

这让 "quick-run"（`server/index.ts:1023`，无关联 change folder 的临时 run）不受影响——quick-run 的文档是内联创建的，不归档。

## `change_id` 放 RunRecord 而非复用 session.document_path

`SpecOpsSessionRecord` 已有 `document_path`（`session.ts:92`）和 `findSpecOpsSessionByRunId`（`session.ts:340`）能反查。但：

- session 记录是运行时状态，会被 close/cancel。
- run 可能脱离 session 独立存在（CLI 直接 `POST /api/runs`）。
- `applyRunPatch` 接收的是 `RunRecord`，不应反向查 session 文件系统。

把 `change_id` 放 run 上，apply 路径自洽。`change_id` 即 proposal.md frontmatter 的 `id` 字段，与 `archiveChange` 入参一致，便于复用查找逻辑。

## 失败语义

`markChangeCompleted` 是 best-effort：

- `changeId === null` → 直接 return（quick-run）。
- 找不到匹配 folder → 静默 return（外部 run / folder 已被手动移走）。
- 写入失败 → `console.warn`，不抛（apply 主流程不应被状态更新阻断）。

这与 `commitPlanDocs`（179-199 行）的 try/catch 模式一致——文档侧失败只 warn，不阻断主流程。

## 向后兼容

- 14 个现有 run.json（全 null change_id）：`readRun` backfill 为 null，apply 时不触碰任何 proposal.md。
- 17 个 `proposed` changes：apply 不会被触发（没有对应 run），状态保持 `proposed`。archive 仍可执行（前置条件放宽）。
- 2 个手动改 `completed` 的历史数据：状态已对，apply 不会重复处理。
- 2 个 archive folder 仍 `proposed`：不在本提案修复范围（legacy 迁移已执行过，不可逆；`archiveChange` 现在会正确写 `archived`）。

## 为何 Task 5 要改两份 skill 文档

已核实：`apps/specops/src/skills/specops.*.md` 与 `.codebuddy/skills/specops.*.md` 内容完全一致（`diff` 验证为 IDENTICAL），是手动维护的两份镜像。`package.json` 的 build 脚本不自动同步 `.codebuddy/skills/`，只重新生成 `dist/skills/`。故两份都需手动编辑。
