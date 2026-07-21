# Tasks

- [ ] 1. RunRecord schema 扩展(`run.ts`)
  - [ ] 1.1 新增字段 `branch: string`(createRun 时填 `specops/run-<id8>`)。
  - [ ] 1.2 新增字段 `pre_apply_commit: string | null`(apply 前填,rollback 用)。
  - [ ] 1.3 向后兼容:读老 RunRecord(无 `branch`)时,`branch` 降级为 `null`,
        apply 走旧 `git apply --3way` 路径 + log warn。

- [ ] 2. createRun 建 branch(`run.ts:152`)
  - [ ] 2.1 `git worktree add --detach <path> <base>` →
        `git worktree add -b specops/run-<id8> <path> <base>`。
  - [ ] 2.2 `run.branch = branchName`,写入 RunRecord。
  - [ ] 2.3 worktree add 失败的 catch 分支同步更新(state='failed')。

- [ ] 3. apply 改走 git merge(`run.ts::applyRunPatch`)
  - [ ] 3.1 删除 `git apply --3way <patchPath>`,改 `git merge --no-ff --no-edit <run.branch>`。
  - [ ] 3.2 merge 前:`git rev-parse HEAD` 存进 `run.pre_apply_commit`,writeRun。
  - [ ] 3.3 merge 失败 catch:`git merge --abort` → 抛 `merge_conflict`(带 branch 名 +
        指引文案)。
  - [ ] 3.4 merge 成功:`git rev-parse HEAD` 返回 `{ commit: <hash> }`。
  - [ ] 3.5 老记录(`run.branch === null`)走旧 `git apply --3way` + 不 commit,log warn。

- [ ] 4. apply 前置检查(`run.ts::applyRunPatch` 开头,branch-based 路径)
  - [ ] 4.1 工作树脏检查:`git status --porcelain=v1 -z`,过滤 `.specops/` 路径后非空 →
        抛 `workspace_dirty`(列出脏文件)。
  - [ ] 4.2 upfront conflict detection:`git merge-tree --write-tree --name-only HEAD <run.branch>`,
        有冲突文件 → 抛 `merge_will_conflict`(带文件列表)。

- [ ] 5. 串行锁(`run-loop.ts` 或新文件)
  - [ ] 5.1 实现 `withApplyLock<T>(workspace, fn)`:Map<workspace, Promise> queue。
  - [ ] 5.2 包住 `applyRunPatch` / `applyCompletedRun` / `applyWithVerify`。
  - [ ] 5.3 锁释放用 try/finally,异常不卡死队列。

- [ ] 6. plan_approved 文档提交点(`server/index.ts:648` 附近)
  - [ ] 6.1 receipt 验证通过、文档解析 OK 后,在 `updateSpecOpsSession` 之前:
        `git add .specops/changes/ .specops/state/intakes/` →
        `git commit -m "specops(plan): <title>"`。
  - [ ] 6.2 只 add `.specops/` 路径,不 `git add -A`。
  - [ ] 6.3 失败(无改动 / git 错误)不阻断流程,log warn,继续走原 phase 转换。
  - [ ] 6.4 title 用 `titleFromDocument` 结果;commit message 不带 trailer。

- [ ] 7. cleanup 删 branch(`run.ts::cleanupRun`)
  - [ ] 7.1 worktree remove 后追加 `git branch -D <run.branch>`(老记录 branch=null 跳过)。
  - [ ] 7.2 branch 删除失败不抛(worktree 已 remove,branch 残留无害),log warn。

- [ ] 8. rollback 适配(`run.ts::rollbackRunPatch`)
  - [ ] 8.1 branch-based 路径:`git reset --hard <run.pre_apply_commit>`(有 pre_apply_commit
        时)。
  - [ ] 8.2 无 pre_apply_commit(老记录或未 apply 过)→ 抛 `not_applied`,提示无 rollback 目标。
  - [ ] 8.3 reset 后清 `run.pre_apply_commit = null`,writeRun。
  - [ ] 8.4 老记录(patch-based)保留 `git apply -R <patch>` 路径。

- [ ] 9. API 返回值 + 前端
  - [ ] 9.1 `applyCompletedRun` / `applyWithVerify` 返回 `{ commit, applied, reason? }`。
  - [ ] 9.2 `server/index.ts` 的 `apply` / `apply_with_verify` action 响应带 `commit` 字段。
  - [ ] 9.3 前端 `app.js` apply 成功后展示 "Applied as <short-hash>"(可选,最小改动)。

- [ ] 10. 测试(`apps/specops/tests/`)
  - [ ] 10.1 `run.test.ts`:createRun 后 `git branch --list specops/run-*` 有输出。
  - [ ] 10.2 `run.test.ts`:apply 后 HEAD 推进,`git log --merges` 有 merge commit,
        message 含 branch 名。
  - [ ] 10.3 `server.test.ts`:apply 冲突(造两个 Run 改同文件)→ 响应 `merge_conflict`,
        工作树干净(无 UU)。
  - [ ] 10.4 `server.test.ts`:多 Run 串行 —— A apply 成功,B apply 冲突,B 不污染 A 的结果。
  - [ ] 10.5 `server.test.ts`:工作树脏(非 .specops/)→ `workspace_dirty` 拦截。
  - [ ] 10.6 `server.test.ts`:plan_approved 文档提交点 —— `git log` 有 `specops(plan):`。
  - [ ] 10.7 `server.test.ts`:rollback 后 HEAD 回退到 pre_apply_commit。
  - [ ] 10.8 `run.test.ts`:老 RunRecord(无 branch 字段)apply 走旧路径 + 不崩。

- [ ] 11. 验证
  - [ ] 11.1 `pnpm test`(apps/specops)绿。
  - [ ] 11.2 手动 e2e:intake → plan → approve → run_in_worktree → verify → apply,
        全流程 git log 干净(有 plan commit + merge commit)。
  - [ ] 11.3 手动 e2e:两个 Run 改同文件,A apply 后 B apply 报冲突且工作树不破。
