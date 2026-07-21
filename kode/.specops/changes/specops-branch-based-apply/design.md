# Design

## 模型切换:patch-based → branch-based

### 当前(patch-based)

```
主仓 HEAD = base
  ↓ createRun
worktree(--detach, base) ← agent 改文件
  ↓ collectRunPatch: git diff base_commit → output.patch
  ↓ applyRunPatch: git apply --3way output.patch
主仓工作树(未提交) ← patch 内容漂着
```

问题:
- worktree detached,改动没进 branch,只能靠 patch 文件传递。
- apply 直接打工作树,不 commit,HEAD 不推进。
- 多 Run apply 撞工作树,无隔离,冲突留 UU 半破状态。

### 切换后(branch-based)

```
主仓 HEAD = base
  ↓ createRun
worktree(-b specops/run-<id>, base) ← agent 改文件
  ↓ collectRunPatch: git diff base_commit → output.patch(仅 review 用)
  ↓ applyRunPatch: git merge --no-ff specops/run-<id>
主仓 HEAD = merge commit(推进)
```

改动:
- worktree 在 branch 上,改动天然固化到拓扑。
- apply 走 `git merge`,merge commit 就是落地,HEAD 推进。
- 多 Run apply 各自 branch 独立,串行 merge,冲突走 git 原生机制(abort 干净)。

## 三层冲突防御

业界调研(bseen / buildthisnow)共识:不要一次性 merge 多个,要分层防御。

### 第一层:工作树干净检查(apply 入口)

apply 前过滤掉 `.specops/` 路径后,工作树必须干净。脏 = 用户有未提交改动,merge 会卷入,
拒绝。错误码 `workspace_dirty`,列出脏文件。

为什么允许 `.specops/` 脏:specops 自己会写 `.specops/state/sessions/`、`runs/` 等,这些
是 runtime 状态,不该拦。

### 第二层:upfront conflict detection(merge 前)

`git merge-tree --write-tree --name-only HEAD <run.branch>`:
- 输出 commit hash + 冲突文件名(如有)。
- 有冲突 → 抛 `merge_will_conflict`,带文件列表,apply 前用户就知道。
- 无冲突 → 继续 `git merge`。

这层是"告诉你别白点",避免 merge 到一半失败再 abort(虽然 abort 干净,但提前告知更友好)。

### 第三层:merge 本身的冲突处理

即使前两层过了,`git merge` 仍可能因为 race(检查到 merge 之间主仓被改)失败。这时:
- `git merge --abort` 回到干净状态。
- 抛 `merge_conflict`,带指引:① `git merge <branch>` 手动解;② `git merge --abort`
  后基于新 HEAD 重跑 Run。

三层叠加:第一层防用户改动卷入,第二层提前告知,第三层兜底 + 干净回滚。

## 串行化:per-workspace mutex

```ts
const applyLocks = new Map<string, Promise<unknown>>()

async function withApplyLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const prev = applyLocks.get(workspace) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => { release = r })
  applyLocks.set(workspace, prev.then(() => next))
  await prev
  try {
    return await fn()
  } finally {
    release()
    // 清理:如果当前锁就是 next 的后继,删 key 防泄漏
    if (applyLocks.get(workspace) === prev.then(() => next)) {
      applyLocks.delete(workspace)
    }
  }
}
```

key = `workspace_root`。同主仓串行,不同主仓并行。specops server 单进程,进程内锁够用。

锁粒度:覆盖 `applyRunPatch` 全程(含前置检查 + merge + writeRun)。不覆盖 verify
(verify 是只读,不需要锁)。

## plan_approved 文档提交点

### 位置

`server/index.ts:648` 那个 `updateSpecOpsSession` 之前 —— receipt 验证通过、文档解析 OK、
`isDocOnly` 判断之后,phase 转换之前。

### 为什么这里提交

1. 此时文档已经落盘(receipt 验证过),可以 add。
2. 还没转 `run_in_worktree` phase,后续 `launchRun` 用 `HEAD` 建 worktree 时能带上文档。
3. 只 add `.specops/changes/<id>/` + `.specops/state/intakes/<id>.json`,不卷其它。

### commit message

`specops(plan): <title>` —— title 用 `titleFromDocument` 结果(已在那段代码里算出)。
不带 `Co-authored-by` 等 trailer,保持干净。

### 失败处理

best-effort:
- 如果 `git add` / `git commit` 失败(比如 `.specops/` 外有 index lock 竞争),log warn,
  不阻断 phase 转换。fallback 到现状(worktree 看不到文档,但 agent prompt 里带文档内容,
  现有 `promptForTask` 已经这么做了)。
- 如果工作树有 `.specops/` 外的 staged 改动,`git commit` 只提交 `.specops/` 路径
  (`git commit -- <paths>`),不卷其它。

## apply 返回值与 RunRecord 扩展

### RunRecord 新字段

```ts
interface RunRecord {
  // ... 现有字段 ...
  branch: string | null          // specops/run-<id8>;null = 老记录
  pre_apply_commit: string | null // apply 前 HEAD,rollback 用;null = 未 apply 过
}
```

### applyRunPatch 返回值

```ts
export async function applyRunPatch(run: RunRecord): Promise<{ commit: string }>
```

老记录(branch=null)返回 `{ commit: '' }`(没 commit,但不报错)。

### rollback 用 pre_apply_commit

```ts
export async function rollbackRunPatch(run: RunRecord): Promise<void> {
  if (run.pre_apply_commit === null) {
    throw new SpecOpsError('not_applied', `Run ${run.run_id} 未 apply 过,无法 rollback`)
  }
  await execFile('git', ['-C', run.workspace_root, 'reset', '--hard', run.pre_apply_commit])
  run.pre_apply_commit = null
  await writeRun(run)
}
```

老记录(patch-based)保留 `git apply -R <patch>` 路径。

## 向后兼容

老 RunRecord(无 `branch` / `pre_apply_commit` 字段)反序列化时:
- TypeScript 层:字段标 `string | null`,JSON.parse 缺字段 = `undefined`,运行时 `?? null`。
- apply 路径:`if (run.branch === null) { 走旧 git apply --3way + 不 commit + log warn }`。
- rollback:`if (run.pre_apply_commit === null && 有 patch 文件) { 走旧 git apply -R }`。

这样历史 Run 不至于卡死,但用户会看到 warn 提示"这是老格式 Run,建议重跑"。

## review 与 apply 数据流分离

```
worktree(branch) ──┬── collectRunPatch → output.patch → review UI(diff 展示)
                   │
                   └── applyRunPatch → git merge branch → HEAD 推进
```

- `output.patch` 文件**保留**,review UI 还要读它展示 diff。
- apply **不再读** patch 文件,改读 branch。
- 两条数据流独立,review 失败不影响 apply,反之亦然。

## cleanup 与 branch 生命周期

```
createRun:  git worktree add -b specops/run-<id> <path> <base>
            → branch 存在,worktree 存在
apply:      git merge specops/run-<id>
            → branch 仍存在(merge 不删 source branch)
cleanupRun: git worktree remove --force <path>
            git branch -D specops/run-<id>    ← 新增
            → branch 删,worktree 删
```

branch 删除用 `-D`(强制),因为 merge 后 branch 已合入,`-d` 也能用,但 `-D` 更稳
(防止未合入但用户想强制清理的场景)。

## 多 Run 场景完整流程(回答用户第三个问题)

场景:session A、session B 两个 Run,改不同文件,基于同一 base。

1. createRun A → branch `specops/run-A`,worktree A。
2. createRun B → branch `specops/run-B`,worktree B。
3. A、B 并行跑(agent 各自在自己 worktree)。
4. A 点 apply:
   - 拿 workspace 锁。
   - 工作树干净检查 ✓。
   - `git merge-tree HEAD specops/run-A` 无冲突 ✓。
   - `git merge --no-ff specops/run-A` → HEAD 推进到 `merge-A`。
   - 释放锁。
5. B 点 apply:
   - 拿 workspace 锁(等 A 释放)。
   - 工作树干净检查 ✓。
   - `git merge-tree HEAD specops/run-B` —— 此时 HEAD = `merge-A`,B 基于 base,
     如果 A 改的文件 B 也改了 → 冲突文件列出 → 抛 `merge_will_conflict`。
   - 用户看到:"Run B 与当前主仓冲突,文件:X.ts、Y.ts。请手动 merge 或基于新 HEAD 重跑。"
   - 用户选项:
     - a. `git merge specops/run-B` 手动解冲突。
     - b. `git merge --abort` 后,基于新 HEAD 重跑 B(`launchRun` base 用当前 HEAD)。
     - c. 放弃 B。

场景变种:A、B 改完全不同文件 → B 的 `merge-tree` 无冲突 → B 也自动 merge 成功。
这是"task partitioning"的自然结果,不需要 specops 额外做 paths 重叠检测(那个作为
follow-up,本次 out of scope)。

## 风险与权衡

### merge commit 污染历史

`--no-ff` 每个 Run 产生一个 merge commit。如果用户偏好 linear history,不爽。
- 缓解:commit message 用 `specops(apply):` 前缀,易于识别 / 过滤。
- follow-up:加配置项 `specops.apply.strategy = merge | squash | rebase`。本次固定 merge。

### `git merge-tree` 版本依赖

`--write-tree --name-only` 是 git 2.38+ 的语义。macOS 系统 git 可能较老。
- 缓解:specops.toml 已经有 `verify` 配置,可以在 createRun 时检查 git 版本,不够就
  fallback 到"跳过 upfront detection,直接 merge 让 git 自己报冲突"。
- 本次先假设 git 2.38+(用户环境是 macOS 2024+,git 应该够新)。如果验证不够,加 fallback。

### 老记录兼容的复杂度

branch=null 的老记录走旧路径,代码里要维护两条 apply 路径。
- 缓解:加一个 deprecation warn,引导用户重跑老 Run。预计 1-2 个版本后删旧路径。
- 本次必须兼容(否则用户的历史 Run 卡死)。

### 串行锁不跨进程

specops server 单进程,锁够用。CLI 模式(`specops run apply`)如果跟 server 同时跑,
锁失效。
- 缓解:CLI apply 也走同一个锁逻辑(只要同进程内串行)。跨进程靠 git index lock 兜底
  (`git merge` 本身会拿 index lock,两个进程同时 merge 第二个会失败)。
- 本次不引入文件锁,依赖 git index lock 做跨进程隔离。

## 不做的事(follow-up proposal 候选)

- **resolver agent 自动解冲突**:冲突时 spawn 新 kode session 读冲突文件自动 resolve。
- **task partitioning**:intake 阶段用 `paths:` 字段预判多 Run 冲突,重叠就串行 createRun。
- **apply strategy 配置**:merge / squash / rebase 三选一。
- **前端 apply-status 预检查 UI**:后端检查本次做,前端按钮 disable + tooltip 后续。
- **删除老 patch-based apply 路径**:1-2 个版本后。
