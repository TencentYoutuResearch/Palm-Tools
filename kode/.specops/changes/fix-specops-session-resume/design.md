# Design

## 两个根因

### 1. resume handler 的 phase 白名单不全

`apps/specops/src/server/index.ts:283-321` 的 `kind === 'resume'` 分支用一串 `if` 区分策略:

| phase | 当前行为 |
|---|---|
| `run_in_worktree` + kode session 活着 | re-attach monitor(正确) |
| `run_in_worktree` / `analyze_request` + 有 run_id | 用 `kode_session_id.toString()` 重建 |
| `review` / `apply_patch` | 返回当前 state,前端展示 review/apply UI |
| **其它** | `400 unsupported_resume_phase` |

漏掉的活跃 phase:`clarify` / `plan_discussion` / `solution_options` / `plan_approved`。
这些 phase 在 `domain/session.ts:8-21` 的 `SpecOpsPhase` 联合里都存在,且 createSession 流程
里确实会进入(intake→`plan_discussion`、clarify→`clarify`、plan approve→`plan_approved`)。

前端 `app.js:282` `canResume = Boolean(session.kode_session_id) && !terminalState`,
并不按 phase 过滤,于是按钮可见但点击 400。

**修法**:把"活着 re-attach / 死了重建"分支的 phase 条件从
`run_in_worktree || analyze_request` 扩到所有非终结、非 review/apply 的活跃 phase。
review / apply_patch 保持原样(那两个 phase 不需要重建 kode session,前端要的是 review UI)。

### 2. resume 重建传错了 id 类型

`index.ts:303`:
```ts
const ks = await kode.createSession(session.backend_key, run.worktree_path, undefined, session.kode_session_id?.toString())
```

`SpecOpsSessionRecord.kode_session_id: number | null`(`session.ts:75`)是 kode bridge 的
**自增数字主键**(`SessionId`,见 `kode-bridge/src/lib.rs:547` 的 `SessionDto.id`)。
进程重启后这个数字会重新从 1 分配,而且它根本不是 codebuddy 的 session UUID。

而 `adapters/kode.ts:41` `createSession` 第 4 参数 `resumeSessionUuid` 会被塞进 HTTP body 的
`resume_session_uuid`(`kode.ts:52`),bridge 端 `transport/remote.rs:604` / `local.rs:126`
原样传给 `--resume <uuid>`。codebuddy 的 `--resume` 只认它自己写进 jsonl 的 UUID。

**真正该传的 UUID 在哪**:`SessionAgent.session_uuid`(`session.ts:60`),由
`recordAgent`(`index.ts:138-140`)从 `KodeSession.session_uuid`(`kode.ts:9`)写入。
bridge `GET /api/v1/sessions/:id` 的 `SessionDto.session_uuid`(`lib.rs:554,585`)
返回的就是 codebuddy UUID。所以 agents 里已经有数据,只是 resume 路径没读。

## 设计决策

### D1: phase → agent purpose 映射

一个 SpecOps session 可能有多个 agent(clarify / plan / intake / implement / repair)。
resume 时要拿"当前 phase 对应那一次 kode session"的 UUID。映射:

| SpecOps phase | 对应 agent `purpose` |
|---|---|
| `clarify` | `clarify` |
| `plan_discussion` / `solution_options` / `plan_approved` | `plan` |
| `analyze_request` | `intake` |
| `run_in_worktree` / `verify` | `implement` |
| `review` / `apply_patch` | `review`(理论上不会走重建) |

取 `session.agents` 里**最后一个** purpose 匹配的 agent(`agents` 是 append-only,
`attachSessionAgent` 在 `session.ts:346-353` 对同 `kode_session_id` 会 in-place 更新而非
追加,所以同 purpose 多次 repair 不会无限增长,取最后一条即可)。

### D2: UUID 缺失时降级,不硬塞数字 id

老 session record 可能因为历史 bug 没有 `session_uuid`(字段一直存在,但早期 recordAgent
拿到的 `KodeSession.session_uuid` 可能是 undefined → 存成 null)。此时:

- 不传 `resumeSessionUuid`(= `undefined`),`kode.createSession` 走全新 session。
- log warn(`specops resume: no session_uuid in agents, starting fresh`)。
- 仍返回 200,前端按新 session 继续。

不返回错误,因为用户的诉求是"能继续干活",而不是"必须恢复历史"。

### D3: 不改 record schema

`kode_session_id: number | null` 保持不变。它仍然是"当前绑定的 bridge session 数字主键",
用于 `kode.getSession` / `focusSession` / `sendPrompt` / `killSession` 这些 bridge API。
只是**不能**把它当 UUID 用到 `--resume`。这次只修 resume 这一处误用,不连带改字段类型
(改字段会影响所有读 record 的代码,超出本次 bugfix 范围)。

### D4: 前端 canOpenAgentSession 简化

`app.js:298` 现在的
`Boolean(session.kode_session_id) && (Boolean(session.run_id) || phase === 'analyze_request' || phase === 'clarify') && !terminalState`
里的 phase 白名单和后端 resume 一样不全。改成纯能力判断:
`Boolean(session.kode_session_id) && !terminalState`。能不能 open 是"有没有活着的 kode
session 可聚焦"的问题,不该按 SpecOps phase 限制。

## 数据流(修复后)

```
用户点 resume
  → POST /api/sessions/:id/action { kind: 'resume' }
  → handler:
      phase ∈ 活跃集合 && kode_session_id != null
        → kode.getSession(kode_session_id)
        → 活着: re-attach watchRun + watchSpecOpsSessionTranscript, state=active, 200
        → 死了:
            uuid = pickResumeUuid(session, phase)   // 从 agents[].session_uuid
            ks = kode.createSession(backend_key, worktree_path, undefined, uuid)
            updateRecord(kode_session_id = ks.id, state=active)
            recordAgent(ks, 'repair')               // 顺手把新 UUID 存进 agents
            watchRun + watchSpecOpsSessionTranscript
            200
      phase ∈ {review, apply_patch}: state=active, 200
      终结态: 409 session_terminal(防呆)
```

## 风险

- **agents 为空或 purpose 不匹配**:D2 降级处理,不 block。
- **多个同 purpose agent**(经过多次 repair):取最后一条,语义上是最新的修复尝试,合理。
- **plan phase 的 kode session 其实是 plan-only session,不是 run session**:resume 重建
  时 `run.worktree_path` 可能不存在(plan phase 不一定有 run)。需要在重建分支里区分:
  plan/clarify/analyze phase 没有 run_id 时,cwd 用 `session.workspace_root` 而非
  `run.worktree_path`。这是本次改动要顺手处理的边界。
