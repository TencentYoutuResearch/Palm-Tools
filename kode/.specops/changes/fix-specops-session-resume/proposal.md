---
schema_version: 1
id: fix-specops-session-resume
kind: bug
title: 修复 SpecOps session resume 的 unsupported_resume_phase 与 kode session id 漂移
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/server/index.ts
  - apps/specops/src/server/public/app.js
  - apps/specops/src/adapters/kode.ts
  - apps/specops/src/domain/session.ts
---

# 修复 SpecOps session resume 的 unsupported_resume_phase 与 kode session id 漂移

## Motivation

用户原话:

> 我现在遇到在specops里的session resume点击后报错了unsupported_resume_phase，并且打开session逻辑也不太对，因为我的kode session的id可能变了，你看看怎么处理下

实际表现有两个独立问题:

1. **`unsupported_resume_phase` 报错**:`apps/specops/src/server/index.ts:320` 的 resume handler 只覆盖了
   `run_in_worktree` / `analyze_request` / `review` / `apply_patch` 四个 phase。其它活跃 phase
   (`clarify` / `plan_discussion` / `solution_options` / `plan_approved`)会直接落到第 320 行返回
   `400 unsupported_resume_phase`。但前端 `app.js:282` 的 resume 按钮在
   `!terminalState`(非 closed/completed/failed/cancelled)时就显示,于是用户点了必然报错。

2. **kode session id 漂移导致 resume 拿不到历史**:resume 在重建 kode session 时(index.ts:303)
   把 `session.kode_session_id?.toString()` 当作 `resumeSessionUuid` 传给 `kode.createSession`。
   但 `SpecOpsSessionRecord.kode_session_id: number | null` 是 kode bridge 的**内部数字主键**
   (自增 SessionId),不是 codebuddy 的 session UUID。`adapters/kode.ts:41-56` 的
   `createSession` 第 4 参数 `resumeSessionUuid` 会被原样塞进 HTTP body 的
   `resume_session_uuid` 字段,bridge 再传给 `--resume <uuid>`(见
   `apps/gui/src-tauri/src/transport/remote.rs:604-606` 与
   `transport/local.rs:126`)。数字 id 既不是 UUID,kode 进程重启后数字主键也会重新分配,
   `--resume 42` 永远拉不到历史。真正该传的 UUID 存在 `SessionAgent.session_uuid`
   (`domain/session.ts:60`),由 `recordAgent` 从 `KodeSession.session_uuid`
   (`adapters/kode.ts:9`)写入,但 resume 路径从未读取它。

## Scope

修复范围限定在 SpecOps server + 前端 + adapter 层,不动 kode bridge / GUI transport。

### In-scope 改动

1. **resume handler 覆盖所有活跃 phase**(`apps/specops/src/server/index.ts`):
   把 `clarify` / `plan_discussion` / `solution_options` / `plan_approved` 纳入 resume 策略。
   这些 phase 的 kode_session_id 指向一个 still-running 或已 exited 的 kode session,策略与
   `analyze_request` 一致:活着就 re-attach monitor;死了就用 UUID 重建。

2. **resume 用真正的 UUID,而非数字 id**(`apps/specops/src/server/index.ts` + `domain/session.ts`):
   - 从 `session.agents` 里取最近一个 `purpose` 匹配当前 phase 的 agent
     (clarify→`clarify`、plan 阶段→`plan`、intake/analyze→`intake`、run→`implement`)的
     `session_uuid`,作为 `resumeSessionUuid` 传给 `kode.createSession`。
   - 没有可用 UUID 时,降级为不带 resume 的全新 session(并 log warn),不要把数字 id
     当 UUID 硬塞。
   - 重建后 `recordAgent` 已经会把新的 `ks.session_uuid` 写进 agents,无需额外改动。

3. **前端 "Open in kode" 覆盖所有有 kode_session_id 的活跃 session**
   (`apps/specops/src/server/public/app.js:298`):
   `canOpenAgentSession` 当前只认 `run_id` 或 `analyze_request`/`clarify`。改成:
   只要 `session.kode_session_id` 非 null 且 `!terminalState` 就显示,让
   `plan_discussion` / `solution_options` / `plan_approved` 也能点开。

4. **resume 按钮可见性与后端能力对齐**(`app.js`):
   前端 `canResume` 不变(`kode_session_id && !terminalState`),但确保后端 handler
   覆盖所有 `canResume` 为 true 的 phase,避免再出现"按钮可见但点了 400"。

### Out-of-scope

- 不改 kode bridge 协议(`GET /api/v1/sessions/:id` 已经返回 `session_uuid`,够用)。
- 不改 GUI transport 的 `resume_session_uuid` 语义(它本来就是 UUID)。
- 不引入新的 phase 或新状态机分支。
- 不重写 `SessionAgent` schema,只在 resume 路径里读它。

## Acceptance criteria

- [ ] 处于 `clarify` / `plan_discussion` / `solution_options` / `plan_approved` phase 的
      SpecOps session,点击 resume 不再返回 `unsupported_resume_phase`;活着则 re-attach,
      死了则用 UUID 重建。
- [ ] resume 重建路径传给 `kode.createSession` 的是 codebuddy UUID(从 `agents[].session_uuid`
      取),不是数字 `kode_session_id`。新建后 `kode_session_id` 更新为新 bridge id,
      `agents` 追加一条 `purpose: 'repair'` 记录且 `session_uuid` 正确。
- [ ] agents 里没有可用 UUID 时,resume 走"全新 session,不带 resume"降级,返回 200 而非
      把数字 id 当 UUID 硬塞导致 `--resume 42` 静默失败。
- [ ] `plan_discussion` / `solution_options` / `plan_approved` phase 的 session 在 UI 上
      "Open in kode" 按钮可见且可点。
- [ ] `pnpm test`(apps/specops)绿;新增/更新的测试覆盖:resume 各 phase 分支、UUID 取值、
      UUID 缺失降级。
- [ ] `unsupported_resume_phase` 仅在 phase 真正不可恢复(终结态走 close 路径,理论上
      到不了 resume)时才可能出现,日常 UI 路径触发不到。

## Out of scope

- bridge `/api/v1/sessions/:id` 返回字段的调整。
- `Session::new` 里 `--resume` 在 codebuddy 侧的语义。
- mobile / flutter 客户端的 resume 适配。
- 把 `kode_session_id` 字段从 record 里删掉或改类型(影响面太大,单独提案)。
- 多 agent 并存的 phase 选择策略重设计(本次用"最近一个 purpose 匹配的 agent"已足够)。

## Constitution conflicts

无。本次改动不触碰 PTY lifecycle、backend default args、run isolation 任何 invariant。
resume 重建仍在 worktree 内执行(`run.worktree_path`),符合 specops-run-isolation。
