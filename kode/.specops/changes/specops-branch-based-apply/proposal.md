---
schema_version: 1
id: specops-branch-based-apply
kind: feature
title: SpecOps apply 改走 branch-based merge,解决多 worktree 合入与文档未提交问题
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/domain/run.ts
  - apps/specops/src/domain/run-loop.ts
  - apps/specops/src/server/index.ts
  - apps/specops/tests/server.test.ts
  - apps/specops/tests/run.test.ts
---

# SpecOps apply 改走 branch-based merge,解决多 worktree 合入与文档未提交问题

## Motivation

用户在实测 SpecOps workflow 时踩到三个串联的流程缺陷,根因都是 specops 用
`--detach` worktree + `git apply --3way` patch 的模型绕开了 git 合并拓扑:

1. **plan_discussion 文档没提交就拉 worktree**:plan approved 后 agent 在主仓工作树写
   `.specops/changes/...` 文档(`index.ts:559`),receipt 验证通过后 phase 转
   `run_in_worktree`(`index.ts:648-660`)。但此时文档**还在工作树未提交**,
   `launchRun` 用 `HEAD` 建 worktree(`run.ts:152` 的 `git worktree add --detach <path> HEAD`)
   基于的是 plan 之前的 commit,文档带不进 worktree。agent 在 worktree 里看不到刚写的
   proposal.md/tasks.md。

2. **apply patch 成功后没 commit**:`applyRunPatch`(`run.ts:224`)就是
   `git apply --3way <patch>`,打完补丁结束,没 `git add` + `git commit`。patch 内容留在
   工作树漂着,下一次 Run 的 base_commit 还是旧的,apply 又会撞。用户以为"apply 了"等于
   "落地了",其实没进 git 历史。

3. **多个并行 Run(worktree)无法合入**:当前 `applyRunPatch` 直接打 patch 到主仓工作树,
   无锁、无冲突检测、无串行化。Run A apply → 工作树脏(未提交)→ Run B apply → 可能
   冲突或叠加在 A 的脏改动上,谁也搞不清状态。实测中出现过工作树 `UU` 半破状态
   (unmerged files),`git apply` 报 `does not exist in index`,需要手动 `git reset` +
   `git checkout` 才能恢复。

业界共识(见调研)很一致:**一个 worktree 一个 branch(不是 detach),串行 merge +
每步 gate,upfront conflict detection,冲突 escalate human**。specops 当前实现跟这套
完全相反,本提案切换到 branch-based merge 模型,一次解决三个问题。

### 用户原话(三个问题)

> 那这里有流程问题，因为plan discussion是在main上进行的，但plan approve这个流程没有把
> 文档这些变更提交，就直接拉worktree去做implement了，就导致了head不一样了
>
> apply patch成功也没有提交commit这个要补上
>
> 在另外一个场景，如果开了多个session任务是不同的worktree这个怎么合入，流程怎么走呢

## Scope

切换到 branch-based worktree + merge 模型,并补齐前置检查、串行化、文档提交点。

### 1. createRun 建 branch 而非 detach(`run.ts`)

- `git worktree add --detach <path> <base>` → `git worktree add -b specops/run-<id8> <path> <base>`
- `RunRecord` 新增字段 `branch: string`,持久化 branch 名。
- worktree 里 agent 的改动仍然由 `collectRunPatch` 用 `git diff base_commit` 收集
  (兼容现有 patch 文件落盘逻辑),但 apply 不再读 patch 文件,改读 branch。

### 2. apply 改走 `git merge`(`run.ts::applyRunPatch`)

- 旧:`git apply --3way <patchPath>`
- 新:`git merge --no-ff --no-edit <run.branch>`,失败 `git merge --abort` 后抛
  `merge_conflict`,带清晰文案(告诉用户手动 merge 或 abort 后基于新 HEAD 重跑)。
- merge 成功后 HEAD 自然推进,返回 `{ commit: <new head> }`。
- `applyCompletedRun` / `applyWithVerify` 同步改返回值,带 commit hash。
- 保留 `collectRunPatch` / `output.patch` 文件用于 review 展示 diff,**不再用于 apply**。

### 3. plan_approved 文档提交点(`server/index.ts`)

- 在 `index.ts:648`(receipt 验证通过、文档解析 OK 之后,`updateSpecOpsSession` 之前)
  加:`git add .specops/changes/ .specops/state/intakes/ && git commit -m "specops(plan): <title>"`。
- 只 add `.specops/` 路径,不卷入用户其它未提交改动。
- commit message 用 `specops(plan):` 前缀,跟代码 commit 区分。
- 失败(如工作树有 `.specops/` 外的冲突)不阻断,但 log warn —— 文档提交是 best-effort,
  不行就 fallback 到现状(worktree 看不到文档,agent 在 prompt 里带文档内容)。

### 4. apply 前置检查(`run.ts::applyRunPatch` 开头)

- **工作树干净检查**:`git status --porcelain` 过滤掉 `.specops/` 路径后非空 → 抛
  `workspace_dirty`,提示用户先 commit/stash 非 specops 改动。
- **HEAD ≠ base_commit 检查**:抛 `workspace_diverged`。但与旧方案不同 —— branch-based
  模式下 HEAD 推进是正常的(上一个 Run merge 过了),此时应该走 `git merge` 让 git 自己
  处理(可能 fast-forward,可能冲突)。所以这条检查**只在工作树脏时**触发,HEAD 推进
  本身不拦。
- **upfront conflict detection**:`git merge-tree --write-tree --name-only HEAD <run.branch>`,
  有冲突文件就抛 `merge_will_conflict`,带冲突文件列表,让用户 apply 前就知道。

### 5. apply 串行化(`run-loop.ts` 或 `run.ts`)

- 进程内 mutex(基于 Promise queue),key 是 `workspace_root`。
- 同一个主仓的 apply 串行,不同主仓并行。
- `applyRunPatch` / `applyCompletedRun` / `applyWithVerify` 都走 `withApplyLock(workspace, ...)`。

### 6. cleanup 同步更新(`run.ts::cleanupRun`)

- worktree remove 后,branch 也要删:`git branch -D <run.branch>`。
- `--force` remove worktree 已有,branch 删除补上。

### 7. rollback 适配(`run.ts::rollbackRunPatch`)

- 当前 rollback 是 `git apply -R <patch>` 反向打。branch-based 下改成:如果 apply 产生了
  merge commit,rollback = `git reset --hard <pre-merge-head>`。需要在 apply 时把
  pre-merge head 记进 RunRecord(新字段 `pre_apply_commit`)或 run state 目录。
- 失败 fallback:提示用户手动 `git reset --hard HEAD@{1}`。

### 8. 前端 / API 返回值

- `apply` / `apply_with_verify` action 的响应增加 `commit` 字段,前端可展示"已提交到
  `<short-hash>`"。
- `apply-status` 预检查接口(可选,`GET /api/runs/:id/apply-status`):返回
  `{ can_apply, blockers: [...], conflicts: [...] }`,前端 apply 按钮据此 disable +
  tooltip。本次可只做后端检查,前端预检查作为 follow-up。

## Acceptance criteria

- [ ] **plan approved 后文档已提交**:`plan_approved` phase 走完后,`git log` 能看到
      `specops(plan): <title>` commit,内容是 `.specops/changes/<id>/` +
      `.specops/state/intakes/<id>.json`。后续 `launchRun` 用 `HEAD` 建 worktree 时,
      worktree 里能读到 proposal.md/tasks.md。
- [ ] **apply 后有 commit**:`apply` / `apply_with_verify` 成功后,`git log` 能看到 merge
      commit(`Merge branch 'specops/run-<id8>'`),HEAD 推进。响应 body 带 `commit` 字段。
- [ ] **apply 走 git merge,不再 git apply**:apply 失败时不再留 `UU` 半破状态 ——
      `git merge --abort` 后工作树回到 apply 前的干净状态。冲突错误信息带
      `git merge <branch> 手动解` 或 `git merge --abort 后基于新 HEAD 重跑` 的指引。
- [ ] **多 Run 串行 apply**:Run A apply 成功后 HEAD 推进;Run B(基于旧 base)apply 时,
      `git merge` 检测到冲突 → abort → 抛 `merge_conflict`,工作树保持干净。两个 Run 同时
      点 apply,后到的等先到的释放锁,不会交错污染工作树。
- [ ] **upfront conflict detection**:`apply-status` 或 apply 前置检查用 `git merge-tree`
      模拟,冲突文件列表在错误信息里返回。
- [ ] **工作树脏拦截**:apply 前工作树有非 `.specops/` 的未提交改动 → 抛 `workspace_dirty`,
      不进行 merge(避免卷入用户改动)。
- [ ] **cleanup 删 branch**:`cleanupRun` 后 `git branch -d specops/run-<id8>` 成功,
      `git worktree list` 不再列该 worktree。
- [ ] **rollback 可用**:apply 后 rollback 能把 HEAD 回退到 pre-merge commit,
      `git log` 不再有 merge commit。
- [ ] **测试覆盖**(`pnpm test` 绿):
  - createRun 建 branch(断言 `git branch --list specops/run-*` 有输出)。
  - apply 产生 merge commit(断言 HEAD 推进 + merge commit message)。
  - apply 冲突时 abort + 抛 `merge_conflict`(断言工作树干净,无 UU)。
  - 多 Run 串行(A 先 apply 成功,B apply 冲突)。
  - 工作树脏拦截。
  - plan approved 文档提交点(断言 `specops(plan):` commit 存在)。
  - rollback 回退。
- [ ] **向后兼容**:已有 RunRecord(无 `branch` 字段)apply 时降级到旧 `git apply --3way`
      + 不 commit,并 log warn。避免历史 Run 无法 apply。

## Out of scope

- **resolver agent 自动解冲突**:本次冲突 escalate human,不 spawn agent 自动解。作为
  follow-up proposal。
- **task partitioning / paths 重叠检测**:利用 proposal.md 的 `paths:` 字段在 intake 阶段
  预判多 Run 冲突。作为 follow-up。
- **前端 apply-status 预检查接口的 UI 集成**:后端检查本次做,前端按钮 disable + tooltip
  作为 follow-up。
- **移动端 / flutter 客户端适配**。
- **rebase vs squash merge 策略选择**:本次固定 `--no-ff --no-edit`(保留 merge commit
  便于追溯哪个 Run 合进来的)。如果用户偏好 linear history,后续可加配置项。
- **跨主仓的 Run 合并**(不同 workspace_root 的 Run 互不影响,不需要处理)。

## Constitution conflicts

- **SpecOps runs 必须隔离自用户工作区**:`specops-run-isolation` invariant 要求 Run 在
  链接 worktree 下执行、diff/verify 不直接针对用户主 worktree。本提案**保留**这个隔离
  (Run 仍在 cache 目录的 worktree 跑),只改 apply 落地方式(从 patch 改 merge)。
  apply 是用户显式批准的动作,符合 invariant 里"applying approved output is a separate,
  explicit action"。无冲突。

- **PTY lifecycle / backend args**:不触碰。无冲突。

## Design notes

### 为什么 `--no-ff` 而不是 fast-forward 或 rebase

`--no-ff` 强制产生 merge commit,历史里能清楚看到"这是 specops Run X 合进来的"。
fast-forward 会丢失这个信息(HEAD 直接指向 run branch 顶)。rebase 会改写 run branch
的 commit hash,且 conflict 处理更复杂(逐 commit rebase)。`--no-ff --no-edit` 是最
简单且信息最完整的选型。

### 为什么保留 `output.patch` 文件

review 阶段前端要展示 diff(`collectRunPatch` 的输出),patch 文件是 review UI 的数据
源。apply 不再读它,但 review 还需要。两条数据流分开:review 读 patch 文件,apply 读
git branch。

### 为什么 `pre_apply_commit` 要记

rollback 需要知道 apply 前的 HEAD 才能 `git reset --hard` 回去。merge commit 的 parent
就是 pre-apply HEAD,理论上能从 `git log` 拿,但显式记录更稳(避免中间被其它 commit
污染)。存在 RunRecord 新字段 `pre_apply_commit: string | null`。

### 串行锁的粒度

key = `workspace_root`。同一个主仓的 apply 串行,不同主仓(理论上 specops 一次只服务
一个主仓,但 CLI 模式可能多实例)并行。锁是进程内 Promise queue,不跨进程 —— specops
server 是单进程,够用。如果未来多实例,需要文件锁(flock),但那是后续问题。

### 文档提交点的 commit message 格式

`specops(plan): <title>` —— title 取 `titleFromDocument` 的结果。不加 `Co-authored-by`
之类的 trailer,保持干净。如果 `.specops/changes/` 之外有 staged 改动(不应该有,但
防呆),commit 只 add `.specops/` 路径,不 `git add -A`。
