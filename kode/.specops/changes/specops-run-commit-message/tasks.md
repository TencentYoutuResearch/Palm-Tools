# Tasks

- [ ] 在 `apps/specops/src/domain/run.ts` 新增私有 helper `runCommitMessage(run)`：
      读取 `run.change_id` 对应的 `.specops/changes/<id>/proposal.md` frontmatter
      `title` 与 `kind`，按映射表产出 Conventional Commits 首行；读不到 proposal
      时回退到 `run.tasks[current_task].title`，再回退到 `specops run <short-id>`
- [ ] 在 `runCommitMessage` 里拼 body trailer：`Run-Id:` / `Change-Id:` / `Task:`
- [ ] 修改 `collectRunPatch`（run.ts:232）把 `specops(run): ${run.run_id}` 替换为
      `await runCommitMessage(run)`
- [ ] 首行 ≤ 72 字符截断逻辑（超长加 `…`）
- [ ] 在 `apps/specops/tests/run.test.ts` 新增测试：
      ① 关联 change_id 的 Run，commit message 首行为 `feat: <title>` 且含 trailer；
      ② quick-run（change_id=null）回退到 `chore: specops run <short-id> — <task>`；
      ③ proposal 文件不存在时回退路径不崩
- [ ] `pnpm test`（apps/specops）全绿
- [ ] 手动跑一次 SpecOps Run，`git log --oneline` 目视确认新 commit message 可读
