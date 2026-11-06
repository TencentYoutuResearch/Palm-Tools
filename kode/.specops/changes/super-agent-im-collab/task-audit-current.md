# P0–P6 主任务逐项证据审计 — 2026-11-06

本矩阵只判断当前主清单每一整条任务是否有执行证据覆盖，不因代码/文件存在而标完成。`已证`才建议 `[x]`；`部分`表示列出的子项有证、整条仍缺要求；`未证`表示本轮没有足够执行证据；`后置`只用于用户明确延后的页面设计；`optional-not-adopted`表示任务本身明确可选且本期未采用。后置不等于验收豁免。

## 汇总结果与证据边界

- 项目检查handle89913 exit0：Rust982/0/7ignored，GUI0 errors/2 warnings；349-file manifest unchanged，并于本次JS-only postfix后独立复核仍无变化。此前pnpm no-TTY attempt是已解决的环境失败。
- 当前Node runner final report：1186 total/1179 pass/0 fail/7 skip；805 files changed/missing/added all empty (`aggregate-coordinator-format-final-result.json`)。工具句柄在新轮次前已过期，结果JSON的exit_code为null，所以此处只报告最终runner统计，不虚构进程exit receipt。
- P4.3定向检查通过：Rust messaging171/0/1ignored，JS8/8，same-hash Home/Host4/4，catalog1/1，compatibility18/18。Coordinator null prior参数拒绝12/12及same-operation受控纠错/恢复通过。当前source actual runner报告1 pass/0 fail、54 completed decisions（Builder25+generated team29；48 native usage+6 admitted provider receipts），三阶段通过并归档，原dirty workspace保持；两次自然close、Hub restart后同Team新operation唤醒、reservations held0/team reserved0均通过。Source503/runtime3402复核无差异，binary SHA匹配；Sol独立recheck也确认source/runtime无改变与54个正usage/stop/0failure。16003的失败仍保留为历史、原因未知，不归因于独立Coordinator参数问题。
- 真实供应商余额/账单对账未声称通过。54-decision Builder run自己的结算 harness 未断言`reserved=0`/全部reservation finalized；清理前checkpoint是Coordinator active/held39/finalized=false。另有独立真实idle专项现已证明自然释放、唯一结算及再次唤醒；两份证据不可合并改写成54-case自身的终态。
- `P5.1–5.8` 所列功能已有当前Node/browser/Hub用例执行证据并按条文标记；用户后置的是后续页面视觉设计，不抹去既有功能验收。P5.9两项fixture证据：原390px probe的13项覆盖长无空格中文编辑/发送、Tab/Enter及空态；新增functional-state专项17/17覆盖offline owner HTTP503、budget/cancel_unconfirmed/旧attempt、缺失证据与receipt-safe recovery，并断言真实Hub缓存/同id GET receipt后只POST一次。仍不宣称生产壳层窄屏布局或完整a11y认证，这些已由页面设计后置。P5.10非视觉SSE cursor/rAF/后台暂停/虚拟窗口专项及冻结797文件Node checkpoint均通过。
- AC7 task-worktree受控实现证据仍有效：Rust6 targeted、11个isolatedHub情景、Builder browser regression均通过。最新真实free-hy结果 `live-builder-upstream-drain-wording-fixed-result.json` exit0，57决策通过配置的Builder→generated-team implement/review/verify，交付明确`unintegrated`且`original_workspace_modified=false`。自然Coordinator close、Hub restart、同团队新消息唤醒也通过；两reservation finalized/held=0、team reserved=0。43次上游EOF与14次peer-close后drain到EOF。797 Node和348 Rust基线manifest无变化，498 source/3402 runtime未变化，pinned binary SHA匹配。该真实完成checkpoint早于P4.3模板增量，不能作为新模板的实际供应商验证。此前reported-model-name过滤/措辞失败作为历史证据保留。
- P4.3模板的Rust/JS/Home/catalog/compatibility定向证据通过，含baseline reproduction gate、exact artifact、prior-artifact rework、owner unreproducible waiver与final-verify refusal。独立Coordinator null-prior问题修复及同操作纠正测试通过，并非16003已知原因。新actual53629/current-source普通feature runner通过1/0：54决策、usage/stop全部有效、三阶段交付、自然close/restart/wakeup、workspace归档及reservation释放都通过；manifest 503 source/3402 runtime与独立复核一致，binary SHA相同。结果`evidence/terminal-stream-20261105/live-builder-coordinator-format-diagnostic-result.json`、`sol-final-actual-independent-check.json`。真实Builder自主发现/生成新模板包的自由模型专项未单独覆盖；当前已配置feature actual、template catalog/save/register测试及bugfix受控Home/Host分层验证通过，留作证据边界。16003失败历史保留，原因未知且没有raw stack，不归因于独立修复。

## P0 — 契约、兼容取证与实施基线

| ID | 状态 | 已证子项 / 尚缺 | 证据入口 |
|---|---|---|---|
| 0.1 | 已证 | 获得实现授权并使用隔离 worktree；未擅自提交/推送/清理用户现场。 | tasks 当前验收范围；本轮工作树状态 |
| 0.2 | 已证（契约层） | proposal/design/remote-protocol/architecture review与本次AC map逐项交叉核验；未采用的扩展单列，不把未实装optional provider当基础协议缺口。 | `proposal.md`, `design.md`, `architecture-review.md`, `specs/remote-protocol.md`, `ac-review-current.md` |
| 0.3 | 已证（用户预算/核算政策） | 全资源coverage、unknown/partial freshness、team budget fallback、估算与internal pricing标签、usage_unresolved门禁和owner诊断均有实际实现测试。真实supplier balance/账单未接入时标记unknown，不伪造差额核对；不是本期真实账单验收要求。 | AC6；Builder actual log/result；`builder-accounting-checkpoint.md` |
| 0.4 | 已证（当前支持的executioner） | Native loop 的role/effort、工具、quota/usage、停止/恢复有当前aggregate与actual evidence；7项中的可选ACP/provider/plugin契约按named skip/unsupported明示，未把相似API推断成支持。 | aggregate skips; `native-role-*`; current Builder/SSH logs; AC5 |
| 0.5 | 已证 | v1双向 compatibility由 Rust websocket tests覆盖（新客户端接旧Hello、新服务与旧客户端、旧Frame字段/新Frame拒绝）；CLI help/model discovery、effort runtime schema与真实 argv capture覆盖 effort 与不注入 prompt。 | `crates/kode-bridge/src/messaging/link.rs`, `wire.rs`; `apps/specops/tests/model-discovery.test.ts`; `integrations/dsh/test/model-reasoning.test.js`; `crates/kode-core/tests/effort_launch.rs`; project check |
| 0.6 | optional-not-adopted | 上游路线 spike 明确可选；没有采用上游/fork 实验，本期保持现路线。 | task 条目授权条件 |
| 0.7 | 已证 | promote 只影响 blank official session、失败promotion重用同一half-created identity且retry只提交一次；旧session清理另需用户指示不是本条验收前置。 | aggregate lines606/922–923; session create/promotion tests |
| 0.8 | 已证（条件步骤不适用） | 本期使用Goal/worktree、未采用SpecOps Run；“如采用Run”条件性analyze不触发。实施基线已形成，工期估算属于计划记录而非当前验收门禁。 | Goal/worktree；tasks.md 0.8 原文 |

## P1 — 现有 Agent 通信可靠性

| ID | 状态 | 已证子项 / 尚缺 | 证据入口 |
|---|---|---|---|
| 1.1 | 已证（受支持动作） | 创建/发送/派单/上游推理收尾均使用原身份与准确receipt恢复；未知结果进入可查询/冻结状态，不对非幂等模型/工具动作盲重放。 | P1创建恢复、通信故障、upstream drain及WorkRun诊断用例 |
| 1.2 | 已证 | Host、JS/Rust MCP具有条数及8192序列化UTF-8保守预算的分页/续读；长Unicode全文还原、游标边界与参与者范围实测。这里本来就是保守长度预算，不是精确tokenizer或整会话累计上限。 | tasks P1「阶段取证备注」真实STDIO/HTTP用例 |
| 1.3 | 已证（当前支持路径） | 本地/远端cancel、lost stop/reply ack、进程组停止、租约/epoch fence、迟到报告与重启恢复有多个real Hub/Host/process场景。未扩成无限旧attempt排列组合。 | `collaboration-host-crash.test.js`, remote/SSH cancellation logs, AC8 |
| 1.4 | 已证 | session/receipt 查询拆索引、游标恢复、EXPLAIN 两索引命中且无全表扫描、迁移兼容已在主清单证据中记录。 | tasks P1「事件查询取证」；对应 schema/query tests |
| 1.5 | 已证 | v2 Hello/Capabilities、v1 DTO 裁剪、普通旧节点通信与缺能力提示有真实兼容测试。 | tasks P1「官方存储崩溃取证」/native persistence 证据 |
| 1.6 | 已证（当前认证协议） | 双Hub传输在认证Host binding内传递受限命令/回执/事件；owner/team/operation scope及幂等关联拒绝伪造主体。不是未部署的新物理机或额外签名scheme验收。 | `actual-ssh-scoped-current.log`; protocol/route tests; AC8/9 |
| 1.7 | 已证（请求的故障类别） | 丢派发响应、远端重启/home等待、cancel ack丢失、迟到报告、重复receipt均由双Hub/进程恢复场景覆盖；不要求所有故障顺序排列。 | `remote-collaboration-host-crash.test.js`, `actual-ssh-scoped-current.log` |
| 1.8 | 已证 | 持久幂等键/指纹、原身份查询恢复、参数冲突拒绝、提交后丢响应与多进程重启均覆盖。 | tasks P1「创建恢复取证」 |
| 1.9 | 已证（当前适配器范围） | 持久inbox/outbox、accepted/delivered/consumed/reported receipt、native实际input-consumption与无法证明时的unverifiable标注有独立Host/native/Hub用例。 | tasks P1「通信故障取证」「消费链路取证」 |
| 1.10 | 已证（迁移入口） | owner/team/session scope、撤销拒绝、Home accounting route owner-only与分页cursor均有验证；旧session迁移兼容由Rust/Node migration tests覆盖。 | AC9；WorkRun diagnostic integration；project tests |
| 1.11 | 已证（当前remote合同） | 唯一owner路由、dual-Host同电脑SSH、离线/重启/顺序/重复receipt和独立取消路径有证据。Proposal不要求另一台物理机，故不列为缺口。 | `actual-ssh-scoped-current.log`; SSH checkpoint |
| 1.12 | 已证 | 当前 owner/operation/team scoped 查询、queue/lease/reason 与故障诊断有证；健康检查和不启动付费任务的故障 fixture 在前序专项中有记录。 | tasks P1/1.12 既有取证；AC9；WorkRun targeted |

## P2 — 执行能力、模型与预算

| ID | 状态 | 已证子项 / 尚缺 | 证据入口 |
|---|---|---|---|
| 2.1 | 已证（当前选择字段） | explicit/inherited/allowedModels硬过滤、profile revision、model/effort/role/assignment/workspace selection provenance及固定上下文均由profile/native/Builder tests覆盖。 | AC5；`native-role-*`; current aggregate |
| 2.2 | 已证（支持执行器） | Rust effort config/provenance、JSONL实际生效值、默认参数边界通过；未安装/不支持的ACP变体以named skip明确，不宣称支持。 | project check; aggregate skips; AC5 |
| 2.3 | 已证（后端字段合同） | 本地/远端创建与WorkRun Assignment透传，并对不兼容来源显式拒绝有执行证据。TS/mobile迁移已明确后置，非本后端子项。 | AC5/8; OpenSSH evidence; mobile scope instruction |
| 2.4 | 已证 | registry按stable profile ID合并desktop edits，旧会话保留immutable launch snapshot；AgentProfiles测试验证role/responsibility/pin变化重用model discovery cache，而执行env/args变化及显式refresh才重新probe。 | `shared-agent-registry.test.js`; `agent-runtime.test.js` `discovery reuses role-only edits...`; aggregate line948 |
| 2.5 | 已证（当前执行器范围） | Builder/Coordinator使用受控official loop，支持适配器的prepare/start/recover/status/stop/tools/usage/artifact有测试；optional未安装ACP executors保留unsupported/skip名单。 | AC5; native/Builder tests; 7 skips |
| 2.6 | 已证（当前可配置profile） | capability schema/revision/source/validity、ranking/pin/hard filter和实际选择通过；未注册资源不会被推断可执行。 | AC5; native role tests |
| 2.7 | 已证（已集成来源） | Home account binding/epoch、共享预算、limit/window/partial/stale quota 与可信collector API有测试；未配置provider仍标unknown并走团队预算策略。 | AC6/9; Home/Rust tests |
| 2.8 | 已证（无凭证fixture） | CodexSession idle `rateLimits/updated`与节流read测试通过；Rust rollout tests核对rollout UUID、metadata和busy/idle event；本条不要求读取凭证或真实余额。 | `codex-quota.test.js`; Rust `jsonl_tail`/rollout tests; aggregate lines297/1257/1451–1456; project check |
| 2.9 | 已证（connector与受控HTTP） | DeepSeek/OpenRouter固定GET connector、response parse/decimal/scope/TTL/限流collector通过4项owned HTTP-server测试；真实供应商账户未配置/访问，真实账户余额仍未验且不宣称可用。 | `src/provider-balances.js`; `test/provider-balances.test.js`; aggregate；AC6 |
| 2.10 | 已证（内部记账合同） | atomic reservation、唯一usage charge、known/unknown usage门禁、Builder/Coordinator/Worker计量来源与held/finalized生命周期已测试；真实供应商账单差额没有伪称支持。 | AC6; Builder/WorkRun diagnostic logs/results |
| 2.11 | 已证（configured sources） | 资源排序/硬过滤、预算拒绝、known exhausted拒绝及unknown/stale team-budget policy有rank/coverage/resource tests；不要求未配置来源的真实quota组合。 | AC5/6; current Node/project tests |
| 2.12 | 已证（审计来源） | 实际model/effort、usage、reservation/operation correlation、coverage与owner authority可查；已知provider采集副作用隔离有测试。 | AC5/6; `live-builder-accounting-generated-team-delivery.log` |
| 2.13 | 已证（ledger contracts） | 并发预留、预算拒绝/缺usage、不重复计费、不确定费用及结算唯一性有Rust/Node/isolatedHub证据；真实provider账单对账只在可用账单样本时才可执行，不是伪造模拟条目。 | AC6; current project tests; Builder/idle accounting results |

## P3 — 无界面的团队、权限、事件与工作流

| ID | 状态 | 已证子项 / 尚缺 | 证据入口 |
|---|---|---|---|
| 3.1 | 已证（当前单用户团队合同） | stable Superagent/team/run identity、revision与RuntimeSession binding在Home/Host/Coordinator/Builder消息持久化测试覆盖；多角色/会话轮换保留身份。多Coordinator不是一期多人或物理拓扑要求。 | AC1/2; Builder actual |
| 3.2 | 已证 | Rust migration、backup/rollback、旧库fixture、约束索引和user_version经当前`./run.sh check`通过；349-source manifest无变更。 | `project-final-manifest-check.json`; AC12 |
| 3.3 | 已证（必要事件/证据索引） | append-only会话/operation/WorkRun状态、artifact/evidence索引、cursor和归档查询用于真实trace/restart；任务要求的数据路径可查。 | AC11; current protocol/evidence |
| 3.4 | 已证 | owner/team grants、route auth、跨team/non-owner拒绝在isolatedHub/双Hub路由测试覆盖；模型/Worker不能以session工具绕过受限命令。 | WorkRun diagnostics targeted; AC9 |
| 3.5 | 已证 | Host→Home authenticated proxies与admin-only Home route已测试；功能按当前collab-api routes实现，不要求每入口实现同名模块。 | usage-guide routes; WorkRun integration |
| 3.6 | 已证（单owner范围） | model/usage/operation correlation、授权/配置revision与凭证脱敏边界可审计；未来多人字段只作为预留，不宣称多人隔离。 | AC11; protocol spec |
| 3.7 | 已证（当前声明式包） | Workflow schema/version/frozen dependencies、DAG、review/verify/waiver、受限返工、命令/skill binding均有测试；模型不能任意生成或执行JS workflow。 | current feature/bugfix template tests; AC3/4 |
| 3.8 | 已证（关键状态合同） | WorkRun/stage/assignment revision/attempt/epoch、waiting-accounting fence、旧receipt/revision拒绝在真实流程及Rust tests覆盖；不需要穷举全状态排列。 | WorkRun integration; Rust targeted; AC6 |
| 3.9 | 已证（required evidence gate） | 精确artifact snapshot、独立review/registered verification、waiver、产物变更后的失效与拒绝交付有Home/Rust/Host当前测试；最新bugfix4/4强化baseline/rework/waiver路径。 | live/controlled Builder tests; `luna-home-integration-final.log`; AC3 |
| 3.10 | 已证 | 创建/派单saga、原子预算/容量预留、稳定session/assignment、幂等report/final reply有分布于aggregate的覆盖；独立真实idle专项又证明自然close会产生唯一final settlement。不要把这一独立专项改写成54-call Builder案例的最终reservation快照。 | `aggregate-work-run-accounting-current.log`; `live-builder-accounting-generated-team-delivery.log`; `live-coordinator-idle-accounting.log/result.json` |
| 3.11 | 已证 | Coordinator消费输入、进度摘要、Worker问询/预算或usage错误归所属Superagent收口；IM联系人不暴露Worker session。 | WorkRun accounting integration; AC2/3 |
| 3.12 | 已证 | Watch/recovery去重、waiting_user/resource/accounting、prior_run关联及restart覆盖已有aggregate；独立真实idle专项证明同一team/contact/conversation/session的新消息创建新operation/control revision并正常唤醒，前次关闭后reserved=0。 | current aggregate; `live-coordinator-idle-accounting.log`, `live-coordinator-idle-result.json`, `live-coordinator-idle-checkpoints.json` |
| 3.13 | 已证（当前双Hub协议） | Home为唯一预算/决策权威；受限remote assignment/report/read/request/cancel由真实OpenSSH/双Hub场景验证。proposal不要求异地机房或所有失联排列。 | `actual-ssh-scoped-current.log`; AC8/9 |
| 3.14 | 已证（受支持quota relay） | 共享账号额度与team budget authority已测试；remote quota observation保留Home/Host/账户scope，不向无关节点转发。未配置资源维持unknown。 | AC6/8; current project tests |
| 3.15 | 已证（必要归档） | artifact/hash/evidence archive分段校验与restart后读取有双Hub证据；无需要求所有raw remote session payload离线可用。 | AC11; SSH evidence |
| 3.16 | 已证（当前事件路径） | team/run/assignment correlation ID在message/receipt/usage/status实际链路保持，且不新增第二底层消息机制。 | WorkRun integration; AC11 |

## P4 — 创建助手、多团队与完整无界面闭环

| ID | 状态 | 已证子项 / 尚缺 | 证据入口 |
|---|---|---|---|
| 4.1 | 已证 | 当前source真实Builder流程25个Builder decisions后生成团队；29 team decisions完成，受限工具/归档与workspace约束成立，原dirty workspace未被改动。16003是较早独立失败，原因未知；最新链已经通过。 | `live-builder-coordinator-format-diagnostic-result.json`; `sol-final-actual-independent-check.json`; Builder browser/HTTP tests; AC2 |
| 4.2 | 已证（通用方法） | workflow-builder访谈/规格转为通用模板，bugfix复现/隔离/review/verify/archive抽为声明式步骤；核心没有TAPD/M3/M4/部署专用工具，领域流程留在project adapter。 | workflow question/template tests; `root-design-decision.md`; AC3 |
| 4.3 | 已证（声明式feature/bugfix流程） | Rust/JS/Home/catalog/compatibility定向通过；Coordinator argument registration fix12/12与same-operation correction/restart/replay证据通过。当前source real feature Builder→generated team链54决策通过，三阶段及交付归档等断言通过。它不专项证明Builder自主发现/生成新模板包；该行为非要求。16003失败历史原因未知，未将它归因于Coordinator参数问题。 | `live-builder-coordinator-format-diagnostic-result.json`; `sol-final-actual-independent-check.json`; `coordinator-argument-postfix-targeted-result.json`; `p59-coordinator-invalid-args-postfix-semantic-final.result.json`; bugfix Home/Host integration; AC3 |
| 4.4 | 已证 | actual Builder explicit activation与资源/权限/预算/项目绑定检查进入生成团队，后续全流程通过。16003较早失败作为历史保留；本轮不声称它已被归因为任何特定缺陷。 | `live-builder-coordinator-format-diagnostic-result.json`; actual Builder fixtures; AC2/5 |
| 4.5 | 已证（当前runtime） | Coordinator stable operation/status/queue、owner authority、active/passive mode与WorkRun恢复有真实与isolatedHub测试；不要求无限lease轮换组合。 | WorkRun integration; AC2/3 |
| 4.6 | 已证（当前支持executor） | Worker role/stage prompts、依赖隔离、usage/stop与audit interface已在native/Builder/SSH路径执行验证；optional executor不冒称已支持。 | actual Builder; native role tests; AC5 |
| 4.7 | 已证 | 当前source真实Builder明确激活→生成团队→implement/review/verify→Superagent交付，54决策全部completed且usage/stop有效；交付归档unintegrated，原dirty workspace不变。自然close、重启、同团队新operation唤醒及预算held归零也由本轮断言。供应商账单 reconciliation 不作虚假声称。 | `live-builder-coordinator-format-diagnostic-result.json`; `sol-final-actual-independent-check.json`; AC2/3 |
| 4.8 | 已证（明确故障路径） | review/verify失败返工与上限waiting_user、信息不足提问、余额耗尽等资源等待/拒绝及Coordinator恢复有不同故障场景覆盖；不需要所有异常出现在一个real run。 | AC4/6; automatic workflow; WorkRun diagnostics targeted |
| 4.9 | 已证（当前声明的调度合同） | Home task-worktree fixed-base与派生scope有Rust6/11 isolatedHub/Builder browser测试；公平轮转、shared budget/account cap、shared device lock、two-team parallel/rework/resume有专门用例；真实57生命周期再证archive/close/wakeup。物理异地机器及无限队列排列不在任务要求。 | `design.md` §6.3；`evidence/task-worktrees-20261105/README.md`; `work-run-fairness.test.js`; `shared-team-resources.test.js`; `shared-exclusive-resource.test.js`; live57 result |
| 4.10 | 已证 | 专门的`shared-expert-pressure.test.js`本轮aggregate 19.45s通过：两队同步等待共享专家预算、无未授权模型重试；授权加额后两队升级模型并完成，断言charges/reservations、held=0、spend与独立workspace。 | aggregate line952; `shared-expert-pressure.test.js`; `fixture-automatic-workflow.js` assertions |

## P5 — IM/session 双视图

| ID | 状态 | 已证子项 / 尚缺 | 证据入口 |
|---|---|---|---|
| 5.1 | 已证（功能） | collab loader验证sidebar/main槽位owner、原组件保留与dispose卸载恢复；页面后续视觉改版是另一项，不撤销此功能验收。 | `collab-client.test.js`; `desktop-composition.test.js`; aggregate |
| 5.2 | 已证（最小功能） | React seats真实Chrome用例验证联系人、发送一次、IM/Session切换保留draft；collab package/client模式骨架与session导航测试通过。 | `collab-render.test.js`; `collab-client.test.js`; aggregate line355 |
| 5.3 | 已证 | Cordis mode switch明确无session side effects；desktop shell保留两类draft、session ID与team authority；loader teardown恢复原slot。 | `collab-navigation.test.js`; `desktop-collab-shell.test.js`; `collab-client.test.js`; aggregate lines345/479 |
| 5.4 | 已证（功能） | Browser实际展示工作过程/查看详情、stage与evidence；trace UI可搜索/下载，工作会话通过受管只读按钮打开且拒绝写入。 | `desktop-builder-resources.test.js`; `work-run-trace-browser.test.js`; aggregate; AC13 |
| 5.5 | 已证（功能） | Chrome覆盖联系人pin/archive、offscreen unread/read、搜索与分离draft；pipeline/decision/cancel用例覆盖请求关联、阶段摘要、结果、停止和结构化决定。 | `contact-directory-browser.test.js`; `collab-unread-browser.test.js`; `delivery-decision-browser.test.js`; `desktop-collab-pipeline.test.js`; aggregate |
| 5.6 | 已证（当前功能范围） | 当前Browser/Hub用例覆盖workspace/project、model selection、workflow dependency、budget/resource coverage、capability revision与activation grant；session只在显式只读排障入口出现。 | `desktop-builder-resources.test.js`; `workflow-dependencies-browser.test.js`; `team-capability-update-browser.test.js`; aggregate; AC5/6 |
| 5.7 | 已证（检索/导出功能） | owner在Home restart后搜索并下载完整native trace；cross-source cursor/export tests检查manifest/watermark/count/byte budget、foreign/corrupt拒绝且不重放旧操作。 | `work-run-trace-browser.test.js`; aggregate lines1012–1016/1091; AC11 |
| 5.8 | 已证 | Chrome/Hub restart保留IM/session分离draft与导航；接受发送丢reply后恢复同一receipt且不重复消息/执行；takeover/resume及普通native Session身份有实际shell/Hub回归。 | `contact-directory-browser.test.js`; `conversation-draft-browser.test.js`; `desktop-collab-shell.test.js`; `intervention-browser.test.js`; aggregate |
| 5.9 | 部分（功能专项通过；生产布局/a11y后置） | 原390px probe的13项覆盖长中文输入/发送、Tab/Enter及空态；新增17项functional-state专项覆盖owner offline503、budget/cancel_unconfirmed/stale attempt、缺失证据/404、刷新保稿与同id receipt防重复POST，renderer/router 10文件hash一致。完整生产壳层窄屏适配和a11y认证由页面设计后置，不能以fixture截图宣称完成，也不新增为本期阻塞项。 | `evidence/terminal-stream-20261105/luna-ui-p59-390-*`; `evidence/terminal-stream-20261105/candidate/p59-functional-states-README.md`; `evidence/terminal-stream-20261105/candidate/p59-functional-states.result.json`; `evidence/terminal-stream-20261105/candidate/p59-functional-states.log` |
| 5.10 | 已证（非视觉实现/专项/冻结全量checkpoint） | Owner-only Host SSE bridge轮询Home持久messages/cursor API（非Home原生push）；cursor续接、断连abort、背压、大page；client隐藏暂停、rAF合并、REST/SSE竞态保护及变量高度虚拟窗口。29/29 targeted含Chrome5000历史+1000 burst、节点/scroll/draft保持、长历史remount；单独unread=1 Chrome通过。797文件Node checkpoint 1176/1169/0/7 exit0且manifest changed/missing/added为空，包含上游drain改动。Node99965之后通过1185/1178/0/7、804文件manifest无变化，但它是当前Coordinator修复前基线；805-file aggregate最终报告1186/1179/0/7且manifest无变化。P5.10非视觉性能已证；实际免费模型流程的自然close/restart与唤醒在单独AC7生命周期补验，不混入P5.10结论。P5.9指定功能状态17/17通过，生产壳层窄屏/a11y完整认证后置。 | `evidence/terminal-stream-20261105/p510-checkpoint.md`; `p510-targeted-current.log`; `p510-unread-virtualized-regression.log`; `aggregate-upstream-drain-final.log`; `aggregate-upstream-drain-final-manifest-check.json`; `aggregate-final.log`; `aggregate-final-manifest-check.json`; `aggregate-coordinator-format-final.log`; `src/conversation-stream-route.js`; `project-hosts.js`; `packages/collab/{message-stream.js,message-window.js,data.js,visible-refresh.js,client-source.js}` |

## P6 — 集成验收与发布准备

| ID | 状态 | 已证子项 / 尚缺 | 证据入口 |
|---|---|---|---|
| 6.1 | 已证（自动检查与manifest） | Node final reporter1186/1179/0/7；805-file manifest changed/missing/added均空。Node运行器句柄已过期，exit code为null，仅记录终态测试统计。项目检查89913为982 Rust passes/7 ignored、GUI0 errors/2 warnings；349-file source recheck无变化。 | `aggregate-coordinator-format-final-result.json`; `project-final-delivery-recheck.json`; `root-project-final-environment-fixed.log` |
| 6.2 | 已证（当前source实际闭环） | 最新actual runner1 pass/0 fail，54决策含25 Builder/29 generated-team、48 native usage/6 provider receipts、全部usage/stop有效且0 failure。三阶段归档、原workspace不变、自然close两轮、Hub restart及同Team新operation wakeup、reserved0都已断言。16003历史失败仍未知原因，未将其归因。 | `live-builder-coordinator-format-diagnostic-result.json`; `sol-final-actual-independent-check.json`; `live-builder-coordinator-format-diagnostic.log` |
| 6.3 | 已证（本期接口范围） | remote-protocol、usage guide、verification/handoff说明与factory/prompt/tools/consumed/slot迁移检查已由owner更新；视觉重设计交下一页面owner。 | `specs/remote-protocol.md`; `usage-guide.md`; `verification-command-guide.md`; current handoff |
| 6.4 | 用户事项（不阻塞代码Goal） | 用户最后review/决定是否继续视觉设计属于交付后事项。安装/提交/发布未获授权，不作为完成代码交付的必要动作。 | proposal authorization; current scope |

## 后端必需缺口判断

截至2026-11-06，未发现尚未实现的本期必需后端功能缺口；已授权后端与非视觉验收目标闭合。当前 Node runner报告1186/1179/0/7，805文件manifest无新增/缺失/变更；项目check89913 exit0，Rust982/0/7ignored、GUI0/2warnings，349文件无变化。当前真实 Builder→生成团队runner报告1/1通过、54决策（Builder25/team29），独立source/runtime复核无变化。证据入口见 `acceptance-audit.md`、`ac-review-current.md` 与 `final-completion-prerequisites.md`。

保留的边界不是本期代码缺口：P5.9生产壳层窄屏视觉和完整a11y认证由后续页面设计负责；未配置真实供应商账户，因此不声称真实余额；Builder自主发现/生成新模板包的自由模型专项未单独覆盖，但当前feature actual、catalog/save/register测试与bugfix受控分层验证已通过；历史actual16003失败原因未知且不归因于后续修复。安装/提交/发布和用户最终产品review不阻塞已授权代码交付。
