---
schema_version: 2
id: specops-run-commit-message
kind: refactor
document_class: work_item
work_type: refactor
title: "SpecOps worktree commit 信息带上规范提交，而不是 specops(run): uuid 无效信息"
status: cancelled
verifies:
  - specops
paths:
  - apps/specops/src/domain/run.ts
  - apps/specops/tests/run.test.ts
---

# SpecOps worktree commit 信息带上规范提交，而不是 specops(run): uuid 无效信息

## 用户原始请求

> specops worktree commit信息带上规范提交，而不是specops(run): uuid无效信息

## Motivation

当前 `collectRunPatch` 在 `apps/specops/src/domain/run.ts:232` 把 agent 在 worktree
里的工作提交到 Run 分支时，commit message 写死成：

```ts
await execFile('git', ['-C', run.worktree_path, 'commit', '-q', '--allow-empty',
  '-m', `specops(run): ${run.run_id}`], { encoding: 'utf8' }).catch(() => undefined)
```

`run.run_id` 是一串 UUID（如 `bbe39d34-5b8e-4c50-9c8b-2b2112b5d11e`），导致 `git log`
里堆满了对人毫无意义的提交：

```
9ca072f Merge branch 'specops/run-bbe39d34'
c815dd4 specops(run): bbe39d34-5b8e-4c50-9c8b-2b2112b5d11e
1831792 specops(run): bbe39d34-5b8e-4c50-9c8b-2b2112b5d11e
9ec2bd0 specops(run): bbe39d34-5b8e-4c50-9c8b-2b2112b5d11e
...
```

用户无法从 commit message 判断这个 Run 做了什么；`git log --oneline`、`git log
--grep`、PR review、changelog 生成全部失效。本仓库其它提交都遵循 Conventional
Commits（`feat:` / `fix:` / `refactor:` …，见 `git log` 历史），而
`specops(run): <uuid>` 既不符合规范也没有人类可读的描述。

## Scope

**In scope:**

- 修改 `collectRunPatch`（`apps/specops/src/domain/run.ts`）生成的 commit message，
  让它带上：
  1. Conventional Commits 风格的 type（默认 `chore`，当 Run 关联到 change 提案
     且提案 `kind` 已知时用对应的规范 type：`feature`→`feat`、`bug`→`fix`、
     `refactor`→`refactor`、`investigation`→`docs`）
  2. 人类可读的 subject —— 优先取 `run.change_id` 对应的 proposal title；其次取
     当前 task 的 `title`；都没有时回退到 `specops(run): <short-id>`，但 short-id
     只取 UUID 前 8 位，不再贴全 UUID
- 让 commit message body 带上结构化的 trailer，便于机器解析：
  ```
  Run-Id: <full uuid>
  Change-Id: <change_id 或 "quick-run">
  Task: <current task title>
  ```
- 新增/更新 `apps/specops/tests/run.test.ts` 里的测试，断言 commit message 不再
  等于 `specops(run): <uuid>` 且包含可读 subject

**Out of scope:**

- 不改 `applyRunPatch`（合并回主 workspace 时的 `--no-ff` merge commit message 本
  身就是 `Merge branch 'specops/run-<id8>'`，可读性可接受）
- 不改 Run 状态机、worktree 隔离策略、base_commit 解析逻辑
- 不改 `specops.toml` 的 `[gate.suppress]`（`suppress_commit_types` 已经覆盖
  `chore/feat/fix/refactor/test/debug/docs`，新格式会自动被 gate 抑制，无需改配置）
- 不引入新的 verify 项

## Acceptance criteria

1. `collectRunPatch` 产生的 commit message 首行形如
   `feat: <proposal title>` / `fix: <proposal title>` / `refactor: <proposal title>`
   / `docs: <proposal title>`，且首行 ≤ 72 字符（超长截断并加 `…`）
2. 当 Run 没有 `change_id`（quick-run）或读不到 proposal 文件时，回退到
   `chore: specops run <short-id> — <current task title>`，其中 short-id =
   `run.run_id` 前 8 位十六进制，不再出现完整 UUID
3. commit message body 包含 `Run-Id:`、`Change-Id:`、`Task:` 三个 trailer 行
4. 当 proposal 的 `kind` 为 `feature`/`bug`/`refactor`/`investigation` 之外的
   值（含 `spec`）时，用 `chore` 作为 type
5. 新增测试覆盖：① 关联 change_id 的 Run；② quick-run（change_id=null）；③
   proposal 文件不存在的回退路径
6. `pnpm test`（apps/specops）全绿
7. 手动 `git log --oneline` 验证新提交可读（非自动化验收，记在 tasks.md）

## Out of scope

- Conventional Commits scope 段（`feat(scope): ...` 里的 `(scope)`）——SpecOps
  Run 跨多个子模块，固定 scope 反而误导，本期不加
- Break change 标记（`!:`）——SpecOps Run 不表达 breaking change
- 多行 body 里贴 diff stat ——`git log` 本身能看，重复无价值
- 给 `specops(plan)` 类提交（如 `ebf3efa specops(plan): …`）做同样改造——那是另一
  条代码路径（`specops plan` 子命令），本提案只动 Run worktree commit

## Constitution conflicts

无。本提案不违反 `constitution.md` 中任何 invariant：
- 不影响 PTY 生命周期独立句柄（`pty-lifecycle.md`）
- 不影响 backend 默认参数无 positional（`backend-default-args.md`）
- 不影响 Run 隔离（`specops-run-isolation.md`）——commit 仍写在 Run 自己的
  worktree/分支上，不碰主 workspace

## 设计说明

### type 映射

| proposal `kind` | commit type |
|---|---|
| `feature` | `feat` |
| `bug` | `fix` |
| `refactor` | `refactor` |
| `investigation` | `docs` |
| `spec` / 空 / 未知 | `chore` |

### subject 来源优先级

1. `run.change_id` 非空 → 读
   `.specops/changes/<change_id>/proposal.md` 的 frontmatter `title`
2. 读不到 → `run.tasks[run.current_task]?.title`
3. 仍读不到 → 字面量 `specops run`

### short-id 定义

`run.run_id.replace(/-/g, '').slice(0, 8)` —— 与 `branchNameFor()` 已有的 short-id
逻辑一致（`run.ts:104-107`），避免引入第二种截断方式。

### 示例输出

关联 change：
```
feat: SpecOps worktree commit 信息带上规范提交

Run-Id: bbe39d34-5b8e-4c50-9c8b-2b2112b5d11e
Change-Id: specops-run-commit-message
Task: 修改 collectRunPatch 的 commit message 生成逻辑
```

quick-run：
```
chore: specops run bbe39d34 — Add isolated.txt

Run-Id: bbe39d34-5b8e-4c50-9c8b-2b2112b5d11e
Change-Id: quick-run
Task: Add file
```

### 实现落点

- 新增私有 helper `runCommitMessage(run: RunRecord): Promise<string>`，放
  `apps/specops/src/domain/run.ts` 内，`collectRunPatch` 调用之
- 读 proposal 用现成的 `parseDocument`（`apps/specops/src/domain/spec.ts`）——
  避免在 run.ts 里手写 YAML 解析
- `collectRunPatch` 的 `.catch(() => undefined)` 保留：commit 失败不应让整个
  collect 崩溃（已 worktree add 的内容仍能进 patch）
