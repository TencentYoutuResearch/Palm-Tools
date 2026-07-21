# Tasks

- [ ] 1. 后端 resume handler 覆盖所有活跃 phase(`apps/specops/src/server/index.ts:283-321`)
  - [ ] 1.1 把 `clarify` / `plan_discussion` / `solution_options` / `plan_approved` 加入
        "活着 re-attach / 死了重建" 分支,与 `analyze_request` 同策略。
  - [ ] 1.2 抽一个 helper(如 `pickResumeUuid(session, phase)`)从 `session.agents` 里按
        phase 选 purpose 匹配的最近 agent 的 `session_uuid`。
  - [ ] 1.3 把 `kode.createSession(..., session.kode_session_id?.toString())` 改为传
        `pickResumeUuid(...)`;UUID 为空时降级为不带 resume 的新 session 并 log。
  - [ ] 1.4 终结态(closed/completed/failed/cancelled)到 resume 时返回更明确的 409
        `session_terminal`(可选,防呆);日常 UI 已隐藏按钮。

- [ ] 2. 前端 "Open in kode" 可见性修正(`apps/specops/src/server/public/app.js:298`)
  - [ ] 2.1 `canOpenAgentSession` 改为 `Boolean(session.kode_session_id) && !terminalState`,
        去掉 `run_id || analyze_request || clarify` 限定。
  - [ ] 2.2 同步检查 `#resume-session` 与 `#open-terminal` 在 plan 阶段 session 上的显示。

- [ ] 3. 测试(`apps/specops` 下 `pnpm test`)
  - [ ] 3.1 resume handler 单测:`clarify`/`plan_discussion`/`plan_approved` phase 在 kode
        session 仍活时走 re-attach,返回 200 且不调 `createSession`。
  - [ ] 3.2 resume handler 单测:kode session exited 时,用 `agents[].session_uuid` 重建,
        断言 `createSession` 收到的是 UUID 而非数字 id。
  - [ ] 3.3 resume handler 单测:`agents` 里没有 `session_uuid` 时降级为不带 resume 的
        新 session,返回 200。
  - [ ] 3.4 前端 `showSession` 测试:plan 阶段 session 的 `#open-terminal` 可见。

- [ ] 4. 验证
  - [ ] 4.1 `pnpm test`(apps/specops)绿。
  - [ ] 4.2 手动:在一个 plan_discussion session 上点 resume 与 Open in kode,不再报
        `unsupported_resume_phase`,历史能从 `--resume <uuid>` 恢复。
