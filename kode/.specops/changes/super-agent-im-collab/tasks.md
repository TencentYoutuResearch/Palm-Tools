# Tasks — Superagents IM v2（通信优先修订）

> 当前范围（2026-11-06）：用户明确页面设计由后续工作处理；当前验收以已有 IM/session 兼容回归和后端端到端为主。AC1–AC13 不因子集通过而整体标记完成。

## 2026-11-06 当前验收状态

- 当前Node runner最终报告`aggregate-coordinator-format-final.log`：1186项/1179通过/0失败/7跳过；最终结果JSON中的工具句柄已过期，exit_code为null，本记录只引用runner统计。805-file manifest changed/missing/added均空，见`aggregate-coordinator-format-final-result.json`。修复前99965的1185/1178/0/7、804文件manifest仅为基线。项目检查89913通过（Rust982/0/7ignored、GUI0/2warnings），349-file结果经独立交付复核无变化；本轮Rust未改。
- 当前项目检查handle89913 exit0：Rust 982通过 / 0失败 / 7忽略（29 suites），GUI 0 errors / 2 warnings；349文件manifest changed/missing均空，见`evidence/bugfix-template-candidate/project-final-manifest-check.json`。首次检查因pnpm no-TTY auto-install保护中止属于环境失败，安全warn模式重跑已通过，历史保留在同目录。
- P5.10 非视觉性能专项29/29通过；Chrome覆盖5000条变量高度历史+1000条突发/remount和单独unread=1回归。最新797文件 Node checkpoint亦通过。详见 `p510-checkpoint.md`、`p510-targeted-current.log`、`p510-unread-virtualized-regression.log`。
- AC7 task-worktree有6项Rust targeted、11个受控isolatedHub情景和1项Builder browser regression通过，包含双团队同仓隔离。较早实际free-hy `live-builder-upstream-drain-wording-fixed-result.json` exit0：57决策（Builder24+team33；56 native usage+1 admitted provider receipt），三阶段通过并交付`unintegrated`归档（原workspace未修改）；自然close、Hub restart、同团队新消息唤醒通过，两reservation finalized/held=0、team reserved=0。运行时43 upstream EOF、14 peer-close后drain到EOF；498 source/3402 runtime unchanged，pinned binary SHA匹配。它早于P4.3模板增量，作为历史实际基线，不改写54-decision held39观察。
- P4.3模板语义定向证据通过Rust messaging171/0/1ignored、JS8/8、same-hash Home integration4/4、catalog1/1、compatibility18/18。Coordinator空`prior_run_id`的独立controlled复现和参数纠错12/12已通过，不动authorize/body；Luna同operation纠错postfix也通过（7 calls，0 agent error，1 workflow run + reply，lost-reply恢复与Hub restart幂等）。当前真实feature链`live-builder-coordinator-format-diagnostic.log` runner最终1通过/0失败，54决策（Builder25 + team29；native48 + provider receipts6），三阶段通过、真实归档并保持原dirty workspace、两轮natural close、Hub restart后同Team新operation唤醒及reserved=0等断言均通过。`live-builder-coordinator-format-diagnostic-result.json`记录503 source/3402 runtime一致；Sol独立重hash也确认source/runtime无差异，binary SHA为44bd01…7946。此证据证明已配置流程真实端到端，不证明Builder自主发现或生成新模板包（未专项实测，且非本期门槛）。16003失败留作历史且原因未知；不归因于Coordinator参数问题，也不影响后续通过的当前链。Node最终805-file manifest无差异；项目349-file manifest无差异。当前backend与非视觉交付目标已满足。
- 资源持有缺失修复后，remote official Worker pipeline/cancel-busy/cancel-tool/takeover-tool/question 5个隔离Hub模式和2项资源门禁单测通过，见 `remote-dispatch-resources-fixed-*.log`。这是针对 Node aggregate 中已定位的合法waiting态，不代表完整aggregate已通过。
- 最新 WorkRun 诊断 targeted：28 通过、0 失败、0 跳过，见 `work-run-accounting-diagnostics-node-targeted.log`；其中14个纯投影验证已包含在28内。真实 isolatedHub 普通 Worker null-usage 流程覆盖 owner/Home、Coordinator 可读状态、持久 waiting-accounting fence、重启后不盲重试与权限/网络边界。
- 较早实际 Builder→生成团队交付 `live-builder-accounting-generated-team-delivery.log` exit 0：Builder22 + team32，共54真实决策均known usage，Coordinator20/implement4/review5/verify3，三阶段通过，交付/重启保持/cleanup通过；629项运行清单仅私有binary在采样期间变化，3402项runtime清单与运行中快照匹配但非启动时快照。后续AC7 free-hy新harness尝试未通过，因此此历史成功不可替代当前新链路证据，也不能声称重启binary字节完全相同。
- 54-decision Builder 实跑的结算范围：该 harness 未断言团队最终 reserved=0 或每个 reservation 都 finalized；清理前 checkpoint 是 Coordinator active、held39、finalized=false，之后 fixture 被清理。不得追溯性地把新专项当成此 run 的最终结算快照。另有独立真实 idle-close 专项通过：6次actual决策均known usage、两轮自然idle_only close、每条reservation finalized=true/held0、唯一settlement row；预算50，spent从1/reserved0到2/reserved0。首次close后Hub重启，receipt/budget保持；同一team/contact/conversation/session新消息唤醒新operation/control revision2。binary restart SHA相同，631 repo/support/evidence + 3402 runtime manifest无变化。详见 `live-coordinator-idle-accounting.log`、`live-coordinator-idle-result.json`、`live-coordinator-idle-terminal-check.json`、`sol-coordinator-idle-accounting-analysis.md`。这是独立生命周期证据，不是供应商账单。
- 已配置团队31决策交付、同电脑双 Host OpenSSH 9 场景是单独证据。AC1–AC13逐条对照当前证据，不因子集通过整体标记完成。页面视觉设计/移动/TS迁移为用户后置；P5.9功能状态现17/17断言通过，生产壳层窄屏呈现和完整a11y认证由页面设计后续处理，不阻塞授权后端代码交付。P5.10非视觉专项29项、Chrome5000历史+1000突发/remount和unread=1均通过。用户最终验收是交付后的参与事项，不作为Goal技术工作无限期阻塞。

历史检查点保留追溯；其中旧的“运行中/失败/待重跑”不代表当前状态。

主清单 P0–P6逐项状态、确切缺口与“已证/部分/后置/optional-not-adopted”解释见[task-audit-current.md](task-audit-current.md)。不再把未穷尽所有排列组合或不同物理机器当作缺口；只保留条目所要求的行为未证明处。另见最终前置条件清单（原始验收记录，见 validation.md）。独立idle close/settlement与57-decision生命周期证据不追溯改写54-decision run的held39 checkpoint。

## 依赖与交付原则

```text
P0 契约与基线
 → P1 现有 Agent 通信可靠性
 → P2 执行能力、模型、团队预算
 → 通信底座验收闸门（使用现有 session/API）
 → P3 无界面团队与流程引擎
 → P4 创建助手、多个团队与远端完整闭环
 → P5 IM/session 双视图
 → P6 集成验收与发布准备
```

前两项交付即使不开发 IM 也改善现有 Agent 协作。底层“完善”限定为以下明确契约和故障用例，不包含群聊、多人、全量语言重写。具体工期待基线验证后估算。

## P0 — 契约、兼容取证与实施基线

- [x] 0.1 获得明确实现授权，记录工作区当前改动的归属和依赖。用用户已提交基线或获授权的快照/worktree，禁止擅自回滚/stash/提交现有改动。
- [x] 0.2 冻结 PrincipalRef、TeamSpec/Grant、WorkflowPack、ExecutionTarget/AccountBinding、Assignment、Evidence、event/version/epoch 契约，并对 proposal/design/tasks 做跨文档一致性检查。契约载于 proposal/design/remote-protocol，AC1–13映射与最终前置清单完成逐项复核；未被本期采用的扩展按范围单列。
- [x] 0.3 落实 D1 已确认政策：全资源 coverage、用户录入团队预算、计量来源/内部计价、估算和对账规则；没有真实余额不等于免费或不可登记。真实供应商账单不可得时明确估算/内部核价和待对账，不宣称供应商余额；Builder/Coordinator/Worker计量及预留/结算 evidence 覆盖，详见AC6。
- [x] 0.4 测试 dsh `0.2.1-rc.2` 的官方 loop 与 Kode driver：role prompt、工具限制、quota 通知、实际 model/effort、生效验证、停止/恢复和 consumed。列 native/partial/unsupported，不用同一 API 外形推断语义相同。当前支持路径有loop/driver证据；未采用的ACP/plugin/真实provider契约明确作为named skips/unsupported，而非伪称通过。详见aggregate skips与AC5。
- [x] 0.5 v1 未知 Frame 行为做最小双向 fixture；CLI effort 用 help/schema/模型目录验证，不发意外 positional prompt。Rust v1 client/server fixture、CLI/model discovery/effort 与 argv 不注入 prompt 证据见 [task-audit-current.md](task-audit-current.md)。
- [ ] 0.6 上游路线 spike（如获授权选做）：固定 commit、独立临时 profile、无用户凭证和真实任务；验证多实例路由、权限默认、同步 core 事务与 Hub 边界。无干净接缝则保持 C 路线，不无限投入 fork。
- [x] 0.7 检查现有 session-create promote 修复与失败半成品的幂等恢复。保留已修逻辑；清理旧会话另需用户指示，不能靠标题判断后删除。`explicit Kode selection promotes only its blank official session...` 与 `failed promotion recovers the same half-created identity and submits once on retry` 已通过；清理旧会话另需用户指示不是此任务的验收前置。
- [x] 0.8 形成实施基线和增量工期估算；本期采用Goal/worktree，没有采用SpecOps Run，因此条件性的SpecOps analyze不适用。计划估算属于实施阶段记录，不是当前代码验收门禁。

验收：冻结协议和行为契约，记录当前故障复现及不支持项。沿用现有技术栈，TS/移动端迁移及专项评估均后置；本阶段不做 IM。

## P1 — 现有 Agent 通信可靠性（独立交付）

- [x] 1.1 不确定提交结果查询/恢复；不能超时直接再建 Worker，不能对非幂等外部动作自动盲重试。持久创建、消息发送、工具/报告回执、上游推理收尾均有精确receipt/replay fence；未知结果进入可查询状态。
- [x] 1.2 批处理条数+总字数/token 预算、卡片全文续读；accepted/consumed/reported 分离，消费确认能力不足明确 approximate。Host、JS/Rust MCP使用有界分页和8192单位UTF-8估算预算；长消息、Unicode、权限及游标续读有真实STDIO/HTTP测试。
- [x] 1.3 取消/停止 ack、租约失效、迟到报告、cancel_unconfirmed；控制路径不等待模型 turn；WorkRun 终态不能被旧 attempt 改写。真实本地/远端模型和验证子进程取消、lost ack、Host/Hub重启、stop receipt及终态fence已有专项证据。
- [x] 1.4 查询拆分消息/终态收据索引和持久补发 cursor；EXPLAIN 证明索引有效，不因优化漏 receipt。
- [x] 1.5 v2 Hello/Capabilities 顺序和特性位；v1 出站 DTO 全字段裁剪；旧节点普通通信可用，自动流程明确提示缺能力。
- [x] 1.6 CollabCommand/Result/EventBatch 和 quota 同步作用域；签名/认证绑定与 replay id，跨节点不可伪造 human。当前 authenticated Host/Home envelope、owner/team/operation scope与幂等ID由双Hub/SSH测试覆盖。
- [x] 1.7 网络故障与租约：派发响应丢失、远端重启、home_hub 暂停、cancel ack 丢失、迟到报告、重复 receipt。当前双Hub/进程恢复和SSH场景按该故障类别验证，不要求异地硬件或所有排列组合。
- [x] 1.8 补齐持久 session 创建操作：幂等键、参数指纹、可查询结果；创建成功但响应丢失时查询同一结果，不重复创建。
- [x] 1.9 持久 outbox/inbox、认领租约、消费确认与故障恢复；区分 accepted、delivered、consumed、reported，无法证明 consumed 的执行器标 approximate。native session 与受管 WorkRun/remote assignment 路径均有真实测试。
- [x] 1.10 基础 owner 身份、操作权限、撤销检查及审计；消息/operation 迁移与游标查询先落地，不等待产品团队表。owner/team/operation scope、撤销拒绝、receipt及cursor已有Rust/Host/Home验证。
- [x] 1.11 跨机命令只路由给唯一 owner；离线、顺序、重复与终态收据有契约。取消独立控制路径，未收到停止确认不能显示已停止。同电脑双Host/OpenSSH和双Hub故障恢复覆盖当前支持remote合同；不要求新增物理机。
- [x] 1.12 补齐可查询的失败原因、correlation ID、队列/租约状态；通信健康检查与故障注入 fixture 不启动真实付费任务。

官方存储崩溃取证：`native-persistence-crash.test.js` 在独立 Node 24.9 子 Host 中加载官方 JSONL 后端及真实文件锁，覆盖 none/zstd；多次 SIGKILL 后同身份恢复、排队输入保留、取消记录持久化和取消幂等。测试禁止推理。`collaboration-host-crash.test.js` 已组合实际工具注册/执行、官方控制器与查询服务、Kode 工作区注册和 Hub、native driver 及官方 zstd 存储：派单提交后丢响应、Host/Hub 两次 SIGKILL 后保留同一 Worker/assignment，取消后不重新入队。现已在任何显式 resolve/retry 前检查 accepted 未消费任务自动恢复，终态取消后保持冷态。辅助图片/标题等未使用服务为 fixture，不含真实推理或远端 SSH。

事件查询取证：schema v14 增加发送方/接收方参与者游标索引；session 读事件使用两个索引范围的 UNION，保留终态收据并去重自发自收。EXPLAIN 验证两条索引生效且无 events 全表扫描；v13 迁移验证历史事件、游标、升级前备份及重复打开均保持正确。此项不单独代表整个 P1 通过。

阶段取证备注：1.2 已补齐 dsh Host、独立 JS MCP、桌面 Rust MCP 的有界预览与全文分页；真实 STDIO/HTTP 测试覆盖长消息批次、游标不跳跃、Unicode 全文还原和参与者权限。后续 message-pages 与 relayInput 已补充每页/每次输入 8192 序列化 UTF-8 字节的保守 token 估算预算，包含封装及转义；不代表整轮/整个会话累计 token 上限。创建、取消、重启另见下列组合证据；整个 P1 仍需阶段验收。

创建恢复取证（1.8）：`session-create-durable.test.js`、`session-create-controller.test.js` 覆盖持久幂等键/指纹、原身份恢复、迟到响应与工作区归属检查；`collaboration-host-crash.test.js` 已进一步组合真实官方控制器、工作区和 zstd 存储，验证进程死亡后同 Worker/assignment 恢复；`remote-collaboration-host-crash.test.js` 经生产 HTTP 创建/查询接口和真实跨 Hub 派单，覆盖创建提交后丢响应、查询/重试、四进程重启以及参数冲突。Native factory 在发布前等待 handle.flush。由此可验收持久创建操作契约；此勾选不代表真实 SSH 部署、付费模型消费或整个 P1 已通过。

创建工具派单取证：`session-create-tools-recovery.test.js` 从实际 Host 注册的创建/查询工具进入，经真实 creator 与 Hub，验证派单提交后丢响应、Hub SIGKILL 和 Host 服务重建后，重试恢复原 Worker 地址及 assignment ID；改任务冲突，accepted 后不重复认领。Worker 控制器与接收侧仍为 fixture，不能证明真实模型消费或生产会话存储恢复。

通信故障取证：`integrations/dsh/test/session-tools-recovery.test.js` 通过真实 STDIO session 工具与两个独立 Hub，验证发送回执被丢弃、目标离线、双方 SIGKILL/重启后，同一幂等键不重复建消息，终态 accepted 收据和关联回复仍能从原游标恢复，接收端不会再次认领已接受消息。HTTP fixture 仅负责注册及接收侧 claim/settle；此测试不证明真实 Worker 已消费、任务完成或 helper 创建恢复。

MCP 控制入口补齐：独立 JavaScript 与桌面 Rust MCP 增加 delivery_status、cancel_input、cancellation_status；取消工具受 Hub input_cancellation 能力约束，沿用发送者/参与者权限。共享真实 STDIO/HTTP 测试覆盖请求、查询、幂等及越权拒绝；并不代表 native runtime 的停止已经确认。

消费链路取证：native-factory 测试通过真实 STDIO send、Hub、Host 投递、native driver 和 Codex 协议测试进程，确认 consumed 对应实际 user/message 的 input ID 与事件序号；Hub SIGKILL、Host 通信服务重建后重发原键只执行一次。会话存储为受控实现，native driver 未跨进程重建；不能扩大为生产 Host 崩溃恢复验收。该链路另通过 MCP 取消排队输入，注入 cancellation/result 已落库但响应丢失；再次 Hub 重启后确认 queued_removed 可查询和幂等重试，取消输入未启动 turn，其他输入保留并只执行一次。故障测试还冻结 delivery 恢复请求：Host 独立取消循环仍完成 queued_removed，关闭时统一中止并等待两个循环退出。

验收：使用现有 session 工具验收本机/远端创建、发送、读取、等待、取消、重连和恢复。没有 IM 也必须可测、可排障。先定义通用 operation/attempt 契约，不依赖 TeamSpec 或完整工作流。

## P2 — 执行能力、模型与预算（仍使用 session 入口）

- [x] 2.1 新建 model-selection.js，统一显式/继承/allowedModels；创建前校验，fingerprint 包含 model/effort/role/assignment/workspace/revision。当前选择前硬过滤及requested/observed provenance由profile/resource/selection suites覆盖。
- [x] 2.2 Rust BackendConfig effort modes 与注入、模型发现 effort、JsonlMeta 生效值；修 ACP 选模型吞错；默认 argv 不含 positional，补必要回归。当前dsh/Codex支持路径有CLI/JSONL/provenance测试；可选ACP executors保留named skip，不据API形状虚构支持。
- [x] 2.3 本地/远端创建/手机透传新字段，明确 mismatch/unverifiable；旧节点不默默忽略。创建/远端派发/不兼容来源拒绝有执行证据；本条不要求移动端迁移，后者已明确后置。
- [x] 2.4 按 profile id 合并桌面端保存，保留 profile 扩展字段；职责变化不让无关模型缓存失效。`shared-agent-registry.test.js` 与 `agent-runtime.test.js` 验证stable ID/desktop edit、旧binding snapshot、role-only cache reuse、execution env/args变化才reprobe。
- [x] 2.5 ExecutionAdapter 能力矩阵：prepare/start/recover/status/stop、工具/权限、消费确认、artifact。Builder/Coordinator 使用受控官方 loop，CLI 工人各自实现窄接口。当前支持executor能力与生命周期有定向/集成测试；未采用ACP/plugin路径明确列为skip/unsupported。
- [x] 2.6 CapabilityProfile schema 与版本、来源、时效、用户钉住项；模型举例仅可编辑种子，不放业务 if 分支。Profile/ranking/pin/hard-filter与实际selection/provenance测试通过。
- [x] 2.7 账户绑定/epoch/共享关系与 quota schema：多 limit_id/window、单位/时间统一、部分/陈旧/重置/缺失；受信 collector API。Codex quota collector、remote scoped samples、stale/unknown/partial coverage及team-budget fallback有证据；未配置provider来源如实保持unknown。
- [x] 2.8 Codex app-server read/updated（空闲也接）、rollout 采集；按实际 backend 变体目录配置，不读取凭证。read/updated 限流退避，版本/登录方式核实。当前 Rust/JS evidence 覆盖 idle quota notification、read throttling、rollout identity/event；限定为无凭证 fixture 与本机已配置运行证据，详见 [task-audit-current.md](task-audit-current.md)。
- [x] 2.9 DeepSeek/OpenRouter 官方 HTTP connector；区分账户余额、key cap、组织预算。固定GET connector、解析/decimal/scope/TTL/限流与受控HTTP server四项测试已通过；没有真实供应商账户配置，故真实账户响应/余额未验，不虚称真实余额，仍按已配置团队预算和计量策略准入。
- [x] 2.10 供应商额度/团队预算/observed usage 分账；原子预留、唯一计费事件、差额对账、失败费用与不确定预留；Builder/Coordinator/Worker/子执行全部纳入。预算增额必须来自用户授权。当前账户/团队/usage事实分账、原子预留、唯一reservation、usage_unresolved冻结/诊断、估算标记和内部计价均有测试；未接入真实供应商账单时不宣称账单差额已核。
- [x] 2.11 resources/rank/coverage API 与工具：硬过滤→质量门槛→可解释排序；已知供应商耗尽拒绝新调用，未知/陈旧来源按团队预算政策处理，不以低分悄悄放行。已知/未知/陈旧/预算拒绝和可解释rank在当前source suites覆盖。
- [x] 2.12 实际模型/effort、quota freshness、每次选择和预留写 audit；任何提权/加钱/外部通知不能作为采集副作用。actual model/effort provenance、quota/evidence correlation、owner授权边界由native/Host/Rust tests覆盖。
- [x] 2.13 预算测试覆盖并发预留、估算后冲正、周期边界、重试计费、失败计费、不确定执行、无计量拒绝、真实额度耗尽；不把内部订阅核算价格叫供应商账单。覆盖耗尽场景使用权威fixture/ledger，不伪称内部订阅价格为供应商账单。

验收：AC5/6/12 的基础能力有证据；所有资源有 coverage，预算扣减可追溯，重复回报不重复收费，未知不按无限。P1/P2 闸门通过前不启动 IM 开发。

## P3 — 无界面的团队、权限、事件与工作流

- [x] 3.1 引入稳定 Superagent ID、team revisions、DM conversation，与 RuntimeSession binding 分离；支持内置 builder、多 coordinator、归档。Home/Host/Builder及消息持久化测试覆盖当前单用户团队语义。
- [x] 3.2 定义完整 DDL、FK/unique/check 与索引；统一迁移序列，SQLite 一致 backup、失败回滚、user_version，旧库 fixture 测试。Rust迁移/旧库/备份/回滚与current `./run.sh check`覆盖已执行条款。
- [x] 3.3 实现 append-only collab_events 与 artifact/evidence 索引、seq cursor；历史与投递 TTL 分离。消息/operation/WorkRun/receipt/evidence cursor与归档查询有当前Node/Rust/Hub证据。
- [x] 3.4 实现 TeamGrant、人类主体映射、成员读取、角色操作范围、撤销版本；所有入口共用授权检查，禁用旧 session/subagent 绕路。Home/Host/remote owner范围、撤销、非owner拒绝与角色工具边界已有集成验证。
- [x] 3.5 Host 新增 collab-api.js；按已认证身份代理。前端/模型均不得拿 admin token 或伪造 quota collector 身份。authenticated proxy与admin-only Home诊断路由有真实isolatedHub测试。
- [x] 3.6 审计保留配置/授权版本、因果 ID；安全过滤凭证，未来多人字段存在但不宣传已多人隔离。当前协议/audit与证据导出含版本及correlation；多人隔离不作为产品承诺。
- [x] 3.7 WorkflowPack v1 JSON schema、版本冻结、命令/skill 依赖检查；首期 DAG+受限返工，不执行模型任意生成 JS。feature/bugfix模板、依赖、waiver、artifact输入映射与旧hash兼容有验证。
- [x] 3.8 WorkRun/StageRun/Assignment 转移表、expected revision、attempt、fencing epoch；ready report 与整个需求 completed 分开。状态/epoch/revision/终态回执与waiting fences在当前Rust/JS/Home/Host测试覆盖。
- [x] 3.9 Evidence gate：精确 artifact snapshot、reviewer 独立 Assignment、verify 环境/命令/结果、waiver；新产物自动失效旧评审/验证。当前bugfix Home/Host integration4/4核对precise artifact、rework与waiver；旧workflow/verification suites保留兼容。
- [x] 3.10 创建/派单 saga 与 transactional outbox；预算/名额/资源锁原子预留；可确定 session_id、幂等 report 与最终回复。aggregate跨Hub、WorkRun、budget/outbox tests覆盖；独立实际Coordinator idle专项证实自然idle close后的唯一settlement和reserved=0。该专项独立于54-call Builder案例，后者终态仍按其checkpoint陈述。
- [x] 3.11 内部线程、订阅直通与 Coordinator digest；用户聊天与内部流分离；报告/问题通过主 Superagent 收口。当前Coordinator/Worker问题与计量异常结构化收口测试通过；不把Worker session暴露为IM联系人。
- [x] 3.12 重启恢复、Watchdog 去重/限次、waiting_user/resource 处理；新请求与旧终态 work item 通过 prior_run 关联。当前aggregate lifecycle suites + `live-coordinator-idle-accounting.log`覆盖自然idle close、restart receipt/budget稳定及同team新请求唤醒新operation。
- [x] 3.13 home_hub 单写权威、远端受限 binding、report/read/request/cancel 回路；无远端自主完成第二状态机。SSH/double Hub evidence验证当前supported remote contract与Home终态决策。
- [x] 3.14 远端额度样本归属与共享账号 budget authority；额度不上传中心服务、不转发给无关节点。当前remote accounting relay只回送权威 scoped observation，scope与权限有双Hub覆盖。
- [x] 3.15 必要证据安全传回 home_hub，hash/size 校验和缺失标注；远端离线仍可读已归档的交付证据。分段archive/hash/receipt与restart/offline读取已有双Hub/SSH测试。
- [x] 3.16 通用通信事件提升为团队工作事件时保持关联 ID；不能另建一套底层投递机制。team/run/assignment/session/call IDs贯穿message、receipt、usage和status测试。

验收：以 API/测试驱动实现一个团队的实现→独立评审→验证。AC3/4/8/9/11 的关键门禁与故障恢复不依赖界面。

## P4 — 创建助手、多个团队与完整无界面闭环

- [x] 4.1 实现 Builder 受限只读工具与可恢复草案，对用户选定项目取证，不扫描无关工作区/凭证。当前source actual diagnostic流程完整通过：Builder25 + generated team29，相关工具调用与团队交付正常；原16003失败仍保留历史，原因未知。
- [x] 4.2 从 workflow-builder 的访谈/规格提炼通用流程；从 palm-device 抽象方法，领域工具只由项目适配包引入。通用访谈、baseline/reproduction、独立review/verify与archive采用声明式模板；未把M3/M4/TAPD/部署命令放进核心工具，领域绑定仍由项目配置/适配包决定。
- [x] 4.3 首个 feature/bugfix 流程包；分离 WorkflowPack、ProjectBindings 与 DeliveryPolicy，按项目配置仓库/命令/证据/结束条件，不将具体平台或三阶段写死。模板定向测试及当前source actual 54-decision full configured pipeline通过。bugfix gate有Home/Host受控 integration；没有声称Builder实际自主生成新模板包（未专项实测）。可选第三方托管adapter无需穷举。
- [x] 4.4 团队草案预检与激活确认：交付终点、项目绑定、适配器能力、资源/权限/额度/工作区/skills。受控预检/激活及当前source Builder实际配置流程通过。
- [x] 4.5 Coordinator runtime：长期身份绑定、单活 lease、上下文恢复/轮换、工具白名单、明确请求自动执行、主动工作 observe/off。队列、恢复、lease/fencing及显式请求推进有当前Rust/Node/isolatedHub与live证据。
- [x] 4.6 Worker 角色化指令和流程包注入；必须走同一执行/审计接口，不能私开未计费未留档 subagent。当前role/selection/official-loop/usage/stop/evidence链覆盖各支持执行路径；未采用执行器仍显式限界。
- [x] 4.7 端到端正常例：创建团队→“实现这个需求”→实现→独立评审→验证→Superagent 交付。操作在隔离测试项目且使用已授权预算。真实 Builder case 54 decisions/known usage、三阶段 delivery 见 `evidence/terminal-stream-20261105/live-builder-accounting-generated-team-delivery.log`；不外推为 reservation 最终结算通过。
- [x] 4.8 异常例：评审失败返工、验证失败、信息不足问用户、余额不足换已授权资源/暂停、Coordinator 不可用的系统状态。自动返工/上限waiting_user、预算等待与授权后续跑、usage/accounting等待、失败状态可读与Coordinator恢复分别有isolatedHub/native evidence；不要求所有异常落在同一供应商链。
- [x] 4.9 多 Superagents 并行：团队上限+账户/Host 总上限+公平队列；共享 workspace 的 worktree 与共享设备锁。普通write Assignment固定base task worktree有Rust/Node控制覆盖；11个isolatedHub情景覆盖隔离、双团队串行/并行、rework、owner resume、remote；公平轮转、共享账户/预算、设备锁有独立测试；57决策真实生命周期另证任务工作树归档、自然close与wakeup。证据无需穷举所有调度排列或新增物理机器，见[task-audit-current.md](task-audit-current.md)与`evidence/task-worktrees-20261105/README.md`。
- [x] 4.10 两团队复用同账号并同时升级专家的预算压力测试；默认禁止未管控子执行绕开额度。`shared-expert-pressure.test.js` 本轮 aggregate 通过：两队并发触发专家重工，在共享额度受限时等待，授权加额后完成；断言模型、唯一结算 reservation、held=0、spent 和无额外盲调用。详见 [task-audit-current.md](task-audit-current.md)。

验收：暂用 session/测试客户端调用创建助手及 Coordinator；两个团队、至少一个远端 Worker，预算/权限/状态不串线。新用户 IM 尚未交付。验证至少两个交付终点与一个无远端平台配置；缺适配器拒绝激活依赖阶段，运行版本冻结，阶段完成不等于整个工作完成。

## P5 — IM/session 双视图

- [x] 5.1 小型只读/fixture 验证 sidebar/main/新建按钮槽位：确认 IM/session 的单一组件 owner 和卸载恢复方式；不手改上游生成文件。
- [x] 5.2 `packages/collab` 最小联系人/DM、模式切换骨架，复用现有设计系统；不做大而全任务板。
- [x] 5.3 验证双视图不会调用 create/start/stop，不丢普通 session 的导航/草稿，插件卸载恢复原组件。
- [x] 5.4 过程抽屉首版：阶段、角色、通信、产物、评审/验证；可跳 session 只读排障。
- [x] 5.5 联系人未读/需要你、搜索、归档；主对话请求关联、阶段摘要、结果、停止与结构化决策。
- [x] 5.6 团队高级设置：工作区、角色/模型偏好、流程、预算/专家策略、来源 coverage、授权版本；默认不暴露 session。
- [x] 5.7 工作过程完整事件/通信/工具与证据检索、只读回放、导出；保留策略与脱敏，不重执行历史动作。
- [x] 5.8 session/IM 草稿与导航恢复、明确 takeover/resume；普通 session 回归，不做历史隐式转换。
- [ ] 5.9 离线、无余额、待接入、取消未确认、证据失效/缺失、长中文/窄屏、键盘与无障碍状态。功能状态专项现17/17断言通过：390px fixture长无空格中文编辑/发送、Tab/Enter、空搜索/空对话、offline owner HTTP503、budget/cancel_unconfirmed/旧attempt呈现；真实Hub缓存/同id GET receipt后只POST一次。投影状态用受控HTTP，真实Hub侧404/503与receipt命中有明确断言。现有截图仅为fixture壳层；生产壳层窄屏布局和完整a11y认证仍由页面设计后续处理，不因此宣称已验证。详见`evidence/terminal-stream-20261105/candidate/p59-functional-states-README.md`。
- [x] 5.10 分页/虚拟化、SSE cursor、rAF 批量刷新、后台暂停；验证切换与高事件量不重建整条聊天。非视觉实现29/29 targeted、Chrome 5000历史+1000突发/remount、unread=1回归通过；797文件冻结Node checkpoint 1176/1169/0/7 exit0，manifest无差异。Host SSE是轮询Home持久消息/cursor API的bridge，不声称Home原生push。P5.10非视觉验收对其冻结源码已完成；更晚的真实free-hy lifecycle也在 `live-builder-upstream-drain-wording-fixed-result.json` 通过，不影响本条边界，详见 `p510-checkpoint.md` 与 `ac-review-current.md`。

验收：AC1/2/10 的产品体验落地，主界面仅 Superagents，底层会话仍可排障。本期不增加移动端迁移任务，现有接口保持兼容。

## P6 — 集成验收与发布准备

- [x] 6.1 Node 全量、受影响Rust单线程测试、GUI pnpm check与项目`./run.sh check`已执行；Node runner报告1186/1179/0/7，805-file manifest changed/missing/added均空；Rust项目检查89913为982/0/7ignored、GUI0/2warnings，349-file manifest无变化。Node runner统计为最终通过，但不补写过期工具句柄未提供的shell exit code。
- [x] 6.2 真实闭环与故障场景：当前source actual runner最终1通过/0失败，54决策（Builder25 + team29），48 native usage +6 admitted provider receipts，阶段归档/原dirty保留/两轮natural close/Hub restart/同Team新operation唤醒/reserved=0均经断言。16003历史失败仍记为原因未知，不归因于Coordinator null-prior参数修复；后续当前链全项通过。仅说明runner统计通过，不声称未观测的shell exit code。
- [x] 6.3 更新协议规范、用户操作说明与 dsh 升级检查表（factory、prompt/tools、消费事件、sidebar/main 槽位）。协议、操作指南、handoff和迁移检查内容已核对更新；视觉设计交后续页面owner。
- [ ] 6.4 用户验收完成且所需 checks 通过后才把 proposal 标 completed；commit/push/release 各按授权执行。最终proposal/用户验收状态由用户决定；不阻塞本次已授权代码交付，也不代为提交/发布。

验收：AC1–13 全部映射到证据；明确真实额度与团队预算覆盖，不能宣称所有供应商余额已支持。发布/提交仍需相应授权。

## 通信底座闸门

- 本地及远端：创建响应丢失、重复发送、消费者崩溃、Hub 重启、断线重连、收据重放、取消未确认、迟到报告、版本不匹配均有自动化证据。
- 幂等副作用、权限拒绝、实际模型/effort 回读、可审计状态和预算预留/结算可独立查询；不可观测能力显式标注。
- 旧 session 工具和现有 GUI/mobile 协议回归通过；不破坏用户已有会话或 profile。
- 不要求外部服务 exactly-once；不确定副作用进入可恢复/人工判定状态，不能无限重试。

## 后续版本

群聊、多人身份/组织 ACL、跨 Hub 迁移/高可用、更多业务流程包与外部 IM 另行设计。用户已明确 TS 和移动端迁移后续再规划，本期不做相关 spike 或替换，保留现有能力。

## 本轮检查

仅修改方案文档；既有业务文件按本轮开始时哈希验证。文档链接、阶段与验收编号检查不等于实现测试。

- P1 恢复补充：冷启动 pending 查询覆盖 accepted 后尚未消费的运行时投递及待处理取消，按消息去重；终态取消与已消费输入不独立触发恢复。组合 Host/Hub SIGKILL 测试在任何显式 resolve/retry 前检查 Worker 自动恢复，并检查取消后重启保持冷态。完整 P1 验收仍未完成。

- 远端创建组合取证：`remote-collaboration-host-crash.test.js` 使用双 Hub、双真实存储 Host、生产创建/查询 HTTP 路由和客户端；覆盖创建响应丢失后的同身份查询/重试、跨 Hub 派单/投递证据、四进程 SIGKILL 恢复及远端取消持久性。SSH 隧道和 owner admission transport 是 loopback fixture；不能据此声称真实 SSH/认证部署或模型消费已验收。

- P1 1.2 消息 read/wait 与全文续读预算：Host、JS MCP、Rust MCP 共用 8192 单位保守估算语义（序列化 UTF-8 字节，显式非实际 token 用量），同时保留条数和 code-point 限制；含 JSON 转义/元数据，游标不跨过未返回事件。真实双 MCP STDIO 路径验证多语言控制字符全文还原。此项不代表执行器精确 tokenizer、完整 Coordinator 批处理/控制优先级或全部生命周期查询预算已验收。

- P1 生命周期审计工具：补齐 JS/Rust MCP 的 capability-gated lifecycle_read，与 Host 统一 16 条/8192 保守估算预算；证据完整保留，独立游标不跳跃，单条过大时报错不推进。真实 STDIO 验证跨页到达取消终态、投递证据及非参与者消息隔离。

- P1 1.4 生命周期查询补充：通过消息参与者索引与 lifecycle_message(message_id,seq) 查询，UNION 去重自发自收；EXPLAIN 检查两侧索引且无消息/审计全表扫描，测试保留终态收据与后续游标。复用已有索引，无新迁移。

- P1 1.9 消费证据补充：移除无 snapshotEvents 时仅凭 followup/flush 上报 queued 的降级行为。此时保留 prepared，消息显式 uncertain/approximate；恢复可读事件后仅补报原 input 的持久证据，不重投。真实 Host/Hub 测试覆盖接口丢失与恢复，控制器冷恢复替身无历史时也明确保持 uncertain。

- P1 1.2 自动投递补充：完整 followup 对象（归属、回复指引、转义后正文）限制在 8192 保守估算单位，正文最多 4096 code points，续读位置按实际保留长度；真实 Host 测试检查最终入队对象大小。不是累计模型回合上下文预算。

## P1 验收核对（增量 104）

| 项目 | 已核实证据 | 判定/剩余边界 |
| --- | --- | --- |
| 1.4 查询、索引、终态续读 | store 的 inbox/route/participant/lifecycle EXPLAIN；link 终态重放；session-tools-recovery 双 Hub 崩溃后原游标续读 | 当前通信查询契约通过。不是未来工作流事件查询验收。 |
| 1.5 协商与 v1 DTO | link 双方向真实 WS Hello/Capabilities；wire.rs 明确 v1 字段白名单/拒绝 v2-only 帧；operation/selection/grant 等缺能力拒绝测试 | 通信层协商与裁剪通过。自动流程产品 UI 的提示仍在 P3/P4。 |
| 1.8 持久创建 | 本地/跨 Hub 真实创建 HTTP + 官方存储四进程恢复 | 已通过，详见创建恢复取证。 |
| 1.3 取消、attempt 与 WorkRun | operation 过期/旧 epoch 报告拒绝；独立取消循环；queued_removed 与 cancel_unconfirmed；真实 native 协议进程在 home 暂停/崩溃后停止并禁止重播 | operation 层有证据；完整条目仍未勾选，WorkRun 终态保护依赖 P3 3.8/3.9。 |
| 实际 SSH 传输 | scripts/test-ssh.py 创建临时密钥/sshd，实际双向消息和 accepted 收据 | 本轮执行通过；不替代双完整 Host 经 SSH 创建/消费/崩溃的组合验收。 |

本次只核实上述范围，未将其余未勾选项或整个 P1 自动视为通过。精确累计模型上下文控制、完整执行器停止证据、未来 WorkRun 证据门禁仍需按各自阶段取证。

- P1 1.12 取证：session diagnostics、消息/投递/取消/operation 查询提供持久状态和关联 ID；新增 owner-only communication-health 查询实际已认证链路的 connected/stale/not_connected、协议和收帧时间，与 runtime_liveness 明确分开。Rust 多连接/过期清理测试及实际双 Hub 进程死亡/重连测试通过，查询不派发任务。只读观察不能诊断所有断连原因，也不证明 Worker/额度健康；这些限制明确返回。

P2 2.6 增量：schema v15 的 home-Hub CapabilityProfile API 已保存不可变版本、资源身份、user/documented/measured 来源、证据引用、置信度、时效和用户钉住项；CAS 冲突和显式 pin 替换保护，session 令牌不可写。真实 Hub HTTP + SIGKILL 重启测试通过。档案仅记录软评价，来源引用并非已核实证据；尚未接入 Builder、排序及待审核调优建议，因此不勾选完整 2.6。

P2 2.11 增量：owner-only resources/rank 已读取 home-Hub 指定能力版本，并使用既有账户绑定/额度 evaluator 排除失效绑定和已知耗尽，未知额度按 require_fresh/team_budget 返回。质量门槛先于价格/时延加权及 preferred 偏好；缺失成本显式 null，保守处理冲突评价。真实 HTTP 测试覆盖这些过滤及 session 越权拒绝。此为只读推荐，所有结果仍 eligible_for_dispatch=false；团队/执行器/权限/独立性/原子资源预留及 Builder 接入未齐备，完整 2.11 不勾选。

历史记录（早期状态已被后续实现与验证取代）：P2 2.9 增量加入固定 GET connector、scope/decimal/TTL和受控transport。当前状态以任务行及`provider-balances.test.js`四项测试为准；未读取凭证或访问真实供应商账户。

P2 2.9/2.12 增量：货币额度 schema v16 和 owner-only monetary-quota API 已分源保存最新采集状态/上次成功样本、账户 epoch/revision 校验和原子审计。Host collector 先固定绑定，丢发布响应时重试原样本，不重新查询供应商；coverage 独立显示 provider_monetary。当前只读事实不等于执行准入；自动激活、scope-aware admission、远端 relay 和真实账户验收仍待完成。

P2 2.9/2.11 增量：resource policy 可附带明确 monetary source/currency/free_models 范围，与百分比窗口在同一事务评估；已知货币耗尽、认证/付款/限流失败不能被团队预算覆盖。schema v17 独立保留限制证据并从 v16 审计重放，防止 partial/unknown 快照清除耗尽。实际操作租约与推荐共用 evaluator；旧 policy 未配置 monetary 时保持原行为。自动启用、Builder 完整 source coverage 和远端 monetary relay 仍未完成。

P2 2.9 远端增量：新增 operation_monetary_quota_v1 独立特性协商，owner-only relay 的 monetary_context/monetary_quota 只允许当前 attempt、执行 Host/Worker、冻结资源/账户版本及已配置 source。远端 collector 在查询前固定 home 上下文，使用同一幂等发布恢复逻辑；本地不复制权威账本。自动采集激活和未绑定 assignment 的远端空闲采集仍待实现。

P2 2.9 采集生命周期增量：运行时提供 Host-only kodeMonetaryCollectors 注册服务，受信插件显式提供 source/transport 后可空闲轮询，按 home/profile/source 去重、隔离慢来源，卸载/关闭取消请求，并在 coverage 返回脱敏状态。未发现 dsh LLM 通用 authenticated HTTP 公开入口；不读取配置凭证、不自动改接 Platform wallet。实际供应商插件注册和真实账户验收仍待完成。

P2 2.5 入口增量：OfficialExecution 已通过进程内、不可序列化的单次 stream/tool permit 接入 dsh 公共执行管线；托管官方 Agent 直接调用普通入口会被拒绝，工具参数/身份改变或嵌套复用不能继承授权，派发前再次校验租约。已用真实 dsh LLM waterfall 和受控适配器验证入口拒绝；工具侧为定向 pipeline fixture。完整官方 loop 及具体受信工具策略仍未齐备，2.5 保持未勾选。

P2 2.5 实际工具验证：补充真实 dsh ToolRuntime 的入口/参数预处理/嵌套调用测试，并组合真实 Hub、grant、租约、文件读取 fixture、官方工具 journal。发现并修复按工具名信任的缺口：策略必须绑定实际注册 implementation，打开和每次执行时核对，无法查询实现身份则拒绝权限声明。同名实现替换和 home 撤权均在工具副作用前阻断；fixture 读取工具不代表生产 Coordinator 工具已交付。

- 执行器增量：真实 ToolRuntime 的 `isError` 返回不能视为正常工具完成；已按 uncertain 留档并上报 home Hub，未对账时禁止继续执行或报告完成。真实 Hub + ToolRuntime 测试覆盖先写文件再抛错且不重复执行；不代表完整官方 loop 验收。

- 官方执行增量：受控 prepareCall 保留上游固定适配器注册、配置和一次性句柄；真实 LlmRuntime + Hub 验证替换注册、拒绝重发、取消、结束后拒绝发送及调用留档。完整 AgentLoop/scheduler 接线仍未验收，2.5 保持未完成。

- 官方 loop 增量：loopServices 隔离适配已用真实 AgentLoop + LlmRuntime + ToolRuntime + Hub 验证 model/tool/model 整轮及 post-execute 失败中止，带真实 TeamGrant/工作区/实现身份校验。官方工具先串行执行；内部 scheduler 契约须随上游升级回归。创建助手/长期 coordinator 启动入口及生产工具仍待接入，不勾选整体 2.5。

- 官方生命周期增量：kodeAgents.officialLoops 提供惰性受控创建/释放，隔离工厂但共享 live registry，保持普通 session factory。真实 loop 验证缺授权策略和创建取消的 live 资源回收、重复身份拒绝、作用域工具策略释放。持久恢复/产品创建助手仍待接入。

- 官方恢复增量：resume 复用真实持久 Session，create/resume 在 registry announce 前建立租约，防止创建监听器排入的输入提前执行。真实 JSONL/zstd 验证 orderly dispose/reload、新 operation 授权、历史工具结果保留且不重放。旧 active lease 不自动复用；官方进程 SIGKILL 恢复仍待验收。

- 官方故障注入增量：真实子进程在 grant-bound 工具写入并 flush Session 后 SIGKILL；新进程恢复 started→uncertain 并取得 home 回执。旧 active lease 恢复被拒绝，无模型/工具重跑且副作用只一次。已验证该强杀切点的安全拒绝，不等于不确定结果自动续跑或全部恢复验收。

- 资源工具增量：官方受控 Agent 可挂载局部 coverage/rank 只读工具，固定 profile/candidate/version/质量门槛/权重；模型仅传分页或 task_tag。真实双 Agent 作用域测试验证互不泄漏、同名策略并存、释放互不影响、未知额度/团队预算提示及排序仍非派发准入。远端全资源覆盖、实际 Builder 配置入口仍未完成。

- 官方工具面增量：受控创建/恢复在发布前安装固定 global-tool allow mask 和 native 展示，晚注册普通工具也不进入模型 schema。真实双 AgentLoop 验证 coverage→rank 连续调用、工具结果进入下一步输入及 home 留档；普通工具在非受控调用中仍可用。创建助手访谈和 TeamSpec 配置仍待实现。

- 官方模型约束增量：按 home selection_policy 校验 profile revision/model/effort，领取前拒绝不匹配或 inference 级证明要求；仅允许 prepared 调用，配置证据取得 home 回执后才发模型请求。实际 LlmRuntime + Hub 覆盖 effort 改写/回执丢失，实际资源工具 AgentLoop 也带 selection policy 通过；不声称供应商推理身份已验证。

- 团队对象增量：schema v18 的 owner-only 草案 API 已实现稳定 team/Superagent/conversation 身份、不可变配置 revision、CAS/请求幂等、历史/分页/审计查询。保存不激活、不创建运行 session、不分配预算。WorkflowPack 绑定验证、激活、角色限定 Builder 草案写入及 IM 对话仍待实现；P3 整体验收未完成。

- 工作流结构预检增量：owner-only workflows/validate 支持可配置 DAG、独立 Assignment 祖先引用、显式有界返工、完成终点覆盖；真实隔离 Hub 权限与拒绝路径测试通过。仅结构校验，不保存或激活。不可变版本/哈希、证据 schema、项目及交付绑定、运行状态机仍待实现，3.7 保持未完成。

- 工作流版本存储增量：schema v19 添加不可变 graph 版本与原子审计；owner-only 保存/精确读取/事件分页 API、域分离 SHA-256、无序集合规范化和同版本幂等已实现。真实 Hub 并发冲突、SIGKILL 恢复与独立哈希计算通过。完整 WorkflowPack 证据 schema、团队绑定/激活和运行状态机仍未完成。

- 团队流程绑定预检增量：精确 team revision 的 owner-only 只读接口核对流程版本/哈希、阶段角色与配置目标，结构化返回缺项及候选；独立评审保留运行时 Assignment/context 要求。真实 Hub 拒绝路径与历史草案隔离通过。候选不是资源准入，尚未实现团队激活。

- 结构化产物证据增量：本地 Host-only artifact-evidence 接口将快照/评审/验证观测写入已有 operation 审计，绑定已准入 attempt/epoch；精确快照引用、独立 operation/session 自评拒绝、阻塞 findings/退出码语义及幂等恢复已验证。尚未接真实产物采集、远端 relay 或 WorkRun 完成门禁，3.9 保持未完成。

- 真实产物采集增量：artifact-snapshot.js 在显式授权的 Git 根目录计算 raw manifest 与 base-tree delta 哈希，覆盖已跟踪/未忽略新文件/删除/执行位/链接文本；检测普通并发变化并限制规模。真实临时仓库采集→Home 证据→重启重放已通过；尚未挂载生产角色工具、持久化 outbox 或 WorkRun 门禁。

- 产物证据 outbox 增量：AgentProfiles 保存固定观测后投递，恢复只重发证据，不重新采集；回执核对 sequence/内容/producer/snapshot hash。OfficialExecution 恢复/轮询/关闭 outbox，当前 operation 未对账时阻止 prepared call 和 finish。真实丢回执/重启与完成阻断通过；远端 relay、归档和生产模型工具仍待接入。

- 官方产物工具增量：mountOfficialArtifactTool 注册 Agent-scoped kode_artifact_capture，宿主固定工作区/repository/operation，仅允许 evidence_id；要求精确 canonical workspace grant，接入真实采集/outbox。实际官方生命周期+ToolRuntime+Git+Hub 测试覆盖范围拒绝、重复 ID、文件变更、审计和撤权。自动角色配置/锁/WorkRun 验收仍待实现。

- 远端产物证据增量：独立 operation_artifact_evidence_v1 协商、accounting relay action 和 outbox home 路由已接入；只允许受信 Host 提交，home 校验 assigned Worker/operation/attempt 并留档。双 Hub 越权/伪造/丢回执/重启恢复通过；官方采集工具的远端 scope 接入仍待完成。

- 远端官方采集工具增量：固定 managed operation 的 home grant_context 回查与 artifact outbox 回传已接入，执行 Host 仅读取固定本地仓库。实际双 Hub+OfficialLoopHost+ToolRuntime+Git 测试验证快照/审计只在 home、Worker 无影子 operation、撤权阻断；自动派单与 WorkRun 完成仍待实现。

- 工作流证据规则增量：可声明 artifact/review/verification/report，完整覆盖唯一输出生产者；祖先产物引用、独立评审、命令/环境绑定及场景列表预检已实现。新规则使用 evidence.v2 哈希域，旧 graph.v1 字节不变；团队诊断暴露规则。项目/命令/schema 解析及运行时 evidence gate 尚待接入。

- 工作区锁增量：复用原生 flock 实现 canonical-root 的 Host-local 互斥，无 TTL 抢占，进程死亡自动释放，取消只在操作结束后释放。官方采集已持锁；跨进程/别名/不同工作区/SIGKILL 和实际本地远端采集验证通过。其他写入者、跨 profile 共享锁目录和 Hub 原子预留仍需接入，不等于完整资源锁验收。

- 官方写入互斥增量：grant-required 工具的 workspace_write 策略自动使用与采集同一工作区锁；只读采集显式 workspaceLock。授权后、journal begin 前申请锁，冲突不执行、不生成 uncertain 记录；完整 pipeline 后 finally 释放。本地/双 Hub 实际写入和采集测试通过。native/非受控写入与 Hub 原子预留仍未覆盖。

- 已存证据匹配增量：owner-only check-evidence 从 Hub 审计读取观测，核对精确流程/阶段、当前 assignment attempt/epoch、仓库、选定产物序列/hash、独立评审、命令版本、环境和必需场景。调用方上下文仅预检，不是冻结 WorkRun，completion_authorized 始终 false；可信执行/报告 schema/依赖/交付门禁仍待实现。

- 项目/交付配置增量：owner-only 不可变版本、哈希、审计与 v20 迁移；项目支持多个命名仓库、独立 tracker connection、环境和受控命令引用，交付终点支持 local/change_request/merged/deployed/custom。流程仓库/命令/环境/场景一致性校验已接入；真实 Hub 测试覆盖拒绝、重试、版本固定与重启。适配器执行、schema、授权与 WorkRun 冻结/激活仍待接入，配置保存不代表可执行。

- 团队交付绑定增量：TeamSpec 可配置命名的 workflow/project/delivery_policy 精确版本引用，必须使用团队允许的 workflow。预检解析不可变记录、核对策略内引用和仓库完整 workspace 范围，分别报告流程角色检查与项目交付检查；旧请求空字段兼容。尚未创建 WorkRun 或激活执行，实际资源/授权/适配器检查仍需接入。

- WorkRun 受理增量：精确团队版本与命名交付绑定、输入校验、不可变上下文快照/hash、事务内幂等/名额/审计，初态 waiting_user(team_activation_required)。支持查询、游标审计和仅 never_dispatched 的 CAS 幂等取消；终态不复活，后续请求链接同团队终态 prior_run_id。该入口尚不派发 Worker；激活、阶段执行/返工和完成门禁仍待实现。

- 团队执行策略增量：预算策略固定预算来源/单位/Assignment 费用上限，调度策略按 target 配置资源准入与能力版本/偏好/评分权重。历史版本不可变、CAS 与重试恢复，团队预检核对归属及完整 target 身份。策略保存不预留、不扣费、不证明实际能力可用；激活需固定审阅版本，派发仍需实时资源和费用门禁。

- 团队激活授权增量：owner-only activate/deactivate，固定用户明确审阅的团队/策略/授权版本，提交事务重新核对当前草案、policy hash、grant 权限/工作区/预算范围；历史回执和审计保留。对应未派发任务绑定独立授权快照，进入 waiting_resource，停用后等待用户；同快照重激活可恢复，换快照不静默迁移。尚不代表执行器就绪或真实派发，运行中任务停用/lease 回收仍需接入。

- 原子派单准备增量：operation 创建、预算预留、grant/resource/budget 绑定与当前准入检查提取为共享事务内部函数；新增 owner-only operation-bundles 一次提交与幂等回执，拒绝接管已有非 bundle operation。失败整笔回滚，重复/重启不重复占款；仍未创建会话或派发 WorkRun，阶段/锁/assignment/outbox 待同事务接入。

- 未领取 bundle 清理增量：owner-only abandon 核对原始 operation/revision/attempt/epoch 与未发生任何对账的预留，一笔事务停止 operation、推进 fencing epoch、释放全部预算预留并保存审计/幂等回执；领取与释放竞争互斥。已领取或已观测用量必须走正常停止与对账，不能按零消耗清理。

- 阶段执行范围增量：Workflow Stage 可声明命名仓库、capabilities/tools/network，输出与来源仓库一致，评审/验证源工作区只读；execution.v3 固定新字段，旧 v1/v2 哈希兼容。项目绑定解析仓库，团队激活验证 scope 不超 grant。实际 Assignment 授权收窄和工具能力/派发接线仍待实现，未声明 scope 不能解释为继承全部权限。

- 冻结阶段候选增量：独立 executor_profile_revision 指纹与软能力评价版本分离；WorkRun stage plan 从固定上下文/授权导出角色候选、模型/effort、资源、预算上限与收窄 grant。未满足依赖/撤权/已分配/缺 scope/工作区不匹配时不生成相应候选；只读不占款。真实 Host 能力核对、质量过滤及 Assignment/outbox 同事务落地仍待实现。

- 官方配置预检增量：领取租约前检查当前 profile 指纹、allowedModels 和实际 LlmRuntime.resolveCallConfig；异步查询后及受控执行前重新检查指纹。实际 Hub + LlmRuntime 用例覆盖缺失 provider、不支持 effort、模型限制及查询中/领取后配置变更；配置元数据不作为推理身份或供应商可达性的证明。

- 阶段计划事务增量：任务状态与当前授权在同一 SQLite 事务读取，候选推导提取为后续派发事务可复用函数；候选补齐冻结的质量/置信度门槛、评分权重及团队并发限制，响应包含 run_state。实际 Hub 验证取消后无候选；尚未创建 Assignment/outbox。

- 官方 Worker 创建回执增量：受控 OfficialLoopHost 增加持久化 command ledger，固定 session/operation/epoch/profile/model/effort/cwd/tools；并发同命令合并，冲突拒绝，历史回执重放不重新创建。未决创建明确 uncertain、不盲重试；发布前后复核绑定。实际 AgentLoop + Hub 验证单次创建、无推理、释放后重放及 setup 中 epoch 变化；尚未接 WorkRun 派发 outbox 和恢复协调。

- 官方创建崩溃增量：每 session 唯一创建命令，禁止换 command ID 绕过 uncertain/created 历史。实际子进程 + AgentLoop + zstd persistence + Hub 在 durable intent 后、实际创建后但回执写入前、created 回执后三个窗口 SIGKILL，重启重放无 Agent/模型/工具/旧租约变更；前者返回 uncertain，后者返回历史 created。自动恢复协调仍待实现。

- 官方创建对账增量：创建成功写官方 ignorable plugin record 并 flush；只读 reconcile 按 session/cwd/非 fork 身份及唯一 command fingerprint 事件确认丢失回执。实际 SIGKILL 用例证明 effect-before-receipt 可恢复历史 created，缺证据仍 uncertain；不恢复执行器或租约。

- 阶段质量推荐增量：execution.task_tag 显式关联能力评估类别（v4 hash，旧 v1/v2/v3 保持兼容）；在阶段计划同事务内复用资源评分，按冻结能力版本、质量/置信度门槛和当前额度给出 recommendation。缺标签/缺证据/资源拒绝不推荐，不能以角色名猜测任务能力；仍需 Assignment 原子准入与派发。

- Assignment 准备增量（schema v22）：owner 阶段接口同事务重算冻结候选/质量/资源准入、检查团队名额、准备预算+grant+selection operation、写 Assignment/blocked outbox/阶段 attempt/审计/幂等回执。关联 operation 不能直接 claim/renew；仅未领取且无记账活动可通过 Assignment abandon 原子释放。实际 Hub 覆盖重复、名额竞争、领取绕过拒绝、撤销/重试/重启；执行器准入、账户/工作区资源锁和 outbox effect pump 尚未完成。

- Assignment 资源预留增量（schema v23）：显式配置 home Hub 账户并发容量；同事务重查冻结绑定/激活授权/质量/额度/grant/预算，预留账户名额与声明路径工作区互斥。缺配置、容量耗尽或路径重叠拒绝；失败不留占用，未领取撤销与预算同事务释放，重启保留且历史回执不重占。真实 Host 路径/内核锁、执行器准入及派发仍待接通，资源预留不解除 blocked。

- 本地 Assignment Host 准入增量：真实官方配置/工具/规范路径检查与整段执行内核锁后申请 owner 准入，事务写 ready/审计/回执；claim/renew/availability 重查当前授权与资源。首阶段本地路径已有真实 Hub+AgentLoop+内核锁测试，远端、后续阶段证据与自动 outbox 派发尚未完成。

- Assignment 创建派发增量：owner 分页 outbox 与 creation 回执接口；dsh assignmentDispatches 按现有命令建立不可覆盖 binding、预留资源、调用官方创建并回传历史回执。丢失回执不重复建 Agent，uncertain 使用持久化会话证据对账。尚未自动发送 mandate、启动后台调度或推进阶段完成。

- 首阶段 mandate 投递增量：owner 同事务从冻结上下文构造完整指令并写现有消息 inbox、Assignment hash/link/回执/审计；start 只在原受控 handle 存活时入队，Host 验证绑定消息与内容哈希后传完整输入，复用持久化接收/消费证据。真实 Host+AgentLoop+本地适配器验证一次消费与预算扣减；不等于阶段通过，后续产物独立性、大输入分页和自动调度仍待实现。

- Assignment 模型入口增量：实际 user input projection 必须匹配 Hub 的唯一 mandate ID 与完整内容；在 selection/call 记账准入之前 flush 会话。实际 AgentLoop 验证无 mandate、篡改、额外输入和 direct followup 不产生额外模型调用/扣减；授权补充输入、上下文替换及 takeover 仍待显式流程支持。

- 冻结阶段证据选择增量：owner 接口只接收精确 Assignment/输出序号，按 WorkRun 冻结项目/流程和真实 producer 推导绑定，同事务检查已消费 mandate、当前授权/资源/依赖及证据匹配；选定后不可替换并保留幂等历史回执。真实临时 Git 产物与错误仓库绑定测试已接入；选定不等于阶段 passed，停止、结算、独立上下文及交付 finalization 仍待实现。

- 阶段结果接收增量：产物选择不再依赖新执行的额度/资源可用性，仍校验冻结授权、当前 grant、operation attempt/epoch 与资源占用。实际 Host 用例覆盖先报告后停用账户仍可选取产物、撤销授权后拒绝新选择、历史回执重放；运行中额度耗尽后的停止/结算与阶段推进仍未完成。

- 受控报告增量：未过期且未中止的本地租约可在执行资源/预算不可用时报告；Hub 同事务校验 Assignment 当前团队授权和持有资源，修复原始 report 绕过团队撤销的缺口。真实 Host 覆盖停用账户后 finish；已中止租约的停止收据恢复、结算与自动推进仍待实现。

- 本地停止收据增量：AssignmentDispatchHost.stop 等待官方 Agent teardown、受管动作与工作区锁释放，持久化 drained 后提交 owner-only Hub 收据；响应丢失重试不重复 dispose。Hub 原子记录审计并 fence 中断 attempt，已 reported 保持证据身份。实际 Host 验证在途工具不提前确认/释放锁及重启回执；额度结算、外部进程确认、远端停止与阶段推进未完成。

- 团队预算结算增量：冻结预算策略显式选择 internal_price 后，owner Assignment accounting 可在真实 drained 收据和全部完整调用用量下按不可变内部单价结清、释放剩余预算预留；供应商费用仍 unconfirmed。默认策略/未确认调用不自动结清，generic settlement 不接受该 basis。实际 Host 验证并发/丢失历史回执/重启不重复扣减；阶段验收和账户/工作区资源释放仍待接通。

- 产物内容留档增量：实际 capture 在写观察回执前原子保存私有内容档案，校验 manifest/字节/快照哈希；工作区消失后可读原内容，同 capture 重试不重扫。实际 Git/Host 覆盖二进制、执行位、删除、链接文本、并发及损坏拒绝。当前仅 Host 本地留档，Hub 内容传输和下游快照恢复尚未完成，不能声称远端已获取产物。

- Hub 产物传输增量（schema v24）：owner-only 分块上传与下载、整包/manifest/内容对原证据快照校验、完整确认及幂等审计已接通。实际 Hub 覆盖丢完成回执、部分/篡改拒绝、删除本地源与档案后重启下载；原生 Host capture 分别确认观察与内容。普通消息仍 128 KiB，档案分块路由单独有界放宽。下游恢复、远端 relay 和阶段验收尚未完成。

- 下游源快照恢复增量：owner Host 可从已完成 Hub 档案恢复到全新私有目录，逐字节/执行位/目录/链接复核后记录 ready，execution_authorized 始终 false；已有改动/未完成目录拒绝重试覆盖。实际 Hub/原生 Host 验证删除源后恢复、越界链接拒绝、重开校验及篡改拒绝。当前是只读 raw source，不是授权的下游 Assignment 或独立评审完成证据。

- 最终产物观察增量：受管 finish 在整段工作区锁内重采集并核对所选 artifact outputs，改动则不 report、不释放锁；成功 report 后持久化 finalArtifact，stop-receipt 由 Hub 校验对应阶段选择/原 attempt/epoch/完整档案。实际 Host 新增第六模式覆盖选后改动、伪造拒绝与重启回执。尚未据此标记阶段通过或释放资源。

- 阶段完成与资源释放增量：owner complete 接口按冻结授权、所选证据、reported/drained/final-artifact 与已结算账目事务判定本地产物阶段 passed，同时释放该 Assignment 的资源/团队名额；原回执重放不触碰后续占用。独立评审、验证和外部执行尚需各自证据，整条 WorkRun 不会据此完成；后续准备可用，自动执行尚未接通。

- 下游输入清单增量：准备 Assignment 时，同事务遍历前置阶段依赖，校验已通过的 producer/attempt/冻结证据及完整档案，保存外部输入、证据序号、快照/档案哈希与内容大小；重试保留原清单。当前仍 execution_authorized=false，派生目录授权、独立上下文和实际下游执行尚未接通。

- Assignment 绑定的 Host 恢复增量：仅接收 Assignment/source stage/output，从 Hub 冻结清单解析证据与档案身份；限定当前 Host，恢复前校验元数据、恢复后重读 Assignment，重试复核原目录内容。真实 Hub/Host 覆盖恢复及重试、未知输出/任意路径/外 Host/已放弃拒绝，并注入档案身份不匹配和并发修订。仍不赋予派生目录执行权限。

- Hub 快照恢复收据增量：owner workspace-receipt 按当前授权/本地 Worker/未启动任务/冻结输入/完整档案校验，拒绝与原项目重叠的目录；同事务保存不可变收据、递增 Assignment revision 和审计。Host bindAssignmentInput 接通恢复与上报，历史重试不重做状态变更。当前仅物化证据，尚未修改操作 grant 或开放派生目录执行。

- 派生只读范围增量：owner workspace-scope 根据物化收据及原团队授权生成单一离线只读快照范围；保留原 grant，事务更新 Assignment/outbox cwd，资源预留使用快照目录。Host guard 验证范围未扩大，并按绑定任务重新校验快照内容，拒绝原目录及篡改。scope_authorized 与执行准入分离，独立上下文及下游 mandate/执行 gate 尚未解除。

- 下游独立执行增量：OfficialLoopHost 证明实际 fresh create（无 seed/parent/inherited events），Host 在持久化及准入前后复核空事件上下文；Hub 将其与冻结输入/快照/独立 producer 身份绑定后允许下游准入。mandate 传前置证据与有效快照目录，原项目仅作来源。真实双 Worker 测试覆盖第二次模型适配器调用、快照读工具、报告/停止/结算；仍不是评审 verdict、验证命令或阶段完成。

- 评审阶段验收增量：derived finish 在所持锁内复核输入快照及当前选择，report 后保存 finalInput，stop 由 Hub 校验其 scope/新上下文/完整档案/选择；complete 支持只读离线 Review outputs，要求通过且无阻断问题并引用同一最终输入，原子释放资源。失败评审不通过；返工、验证命令和整体交付仍未完成。

- 本地验证 runner 基础增量：Host 注册不可变命令/可执行文件哈希/固定 argv/显式环境/场景与限额，执行前写持久化意图并要求 trusted authorize；真实子进程记录退出码和有界日志，重试/重开只读历史结果，未完成意图拒绝自动重跑。取消/超时/输出超限不通过。不继承 Host 环境，不经 shell；尚未接 Assignment 命令授权、Hub 日志和验证阶段完成。

- Assignment 验证命令执行增量：受控 run.verify 只接受 request_id/output，按冻结项目/工作流/输入快照解析命令及环境，校验 runner hash/场景/tool/capability/network，持锁并通过官方工具意图日志执行真实命令、复核当前授权和源快照，再生成 verification observation。九模式原生测试覆盖实际固定命令、退出码与日志、任意参数/输出拒绝和重复调用拒绝。日志仍 local_only，验证阶段 complete 继续拒绝，等待 Hub 留档。

- 验证记录 Hub 留档及验收增量：owner verification-records 校验原验证 observation、冻结命令/环境/场景、来源快照、日志字节/hash 和实际退出/进程组状态；本地不可变文件+小型 outbox 重传，finish 等待 home ack。验证 complete 再核对对应工具 returned、最终输入/停止/结算后释放资源。真实测试覆盖 >128 KiB 日志、离线/丢回执、篡改拒绝、删除本地记录后 Hub 重启取回；整体 WorkRun 仍待交付终态。

- 单 WorkRun 三阶段验收增量：十模式原生测试新增产物→独立评审→独立验证，三个不同 Worker 接收传递的产物/评审证据，复用单执行名额，真实验证命令执行并归档；总团队预算扣减 6、预留清零，Hub 重启后证据/终态收据仍可查询。使用 fixture 模型和确定性评审，不代表真实研发质量验收；整体仍等待可配置交付终态，自动编排和返工未完成。

- 冻结策略交付收尾增量：owner delivery 接口复核阶段/依赖、当前授权、精确证据/归档、结算和资源释放，以事务持久化本地完成收据和唯一审计。required_outputs 可指定下游验证，仍要求目标仓库的通过产物已归档。十一模式原生测试覆盖三阶段后本地完成及重启/撤权重放、提前/越权/参数覆盖拒绝，以及外部变更请求终点无适配器证据时不能完成。尚无自动调度/返工、外部交付适配器或 IM 结果通知。

- Home 策略派单增量：schedule 接口无需调用者指定阶段/Worker，按冻结依赖、当前能力/额度推荐及偏好/评分选择目标，在共享事务中创建 Assignment、预留预算和写派单记录。真实三阶段场景覆盖两目标偏好选择、依赖未满足拒绝、越权/参数覆盖拒绝、丢响应/并发重试与重启留档；后续执行仍经过现有 Host 门禁。尚未接通后台连续推进、自动结果收集或返工，不将单次策略派单称为全自动编排。

- Host 自动准备下游目录增量：创建 Worker 前根据冻结输入与 artifact_output 恢复快照、校验字节、上报 materialization receipt、取得派生 scope，再使用更新后的 cwd 预留名额和创建。已提交 scope 丢响应时复用原请求；快照被改时拒绝启动且不占名额。真实三阶段测试移除了第三 Worker 的手动目录/授权/资源调用，验证恢复后实际命令与交付路径；后台连续推进、写入/多来源目录、自动结果收集和返工尚未完成。

- Host WorkRun 推进控制器增量：advance/watch 连接策略派单、Worker 启动、等待消费/空闲/证据、报告/停止/结算/阶段完成与交付；依据 Hub 持久状态恢复，缺执行所有权进入 recovery_required。真实第三阶段覆盖已选证据丢响应后重建控制器继续收尾，不重新执行模型或验证命令。生命周期单测验证并发合并、关闭前阻止启动和终态清理。仍需通用可信输出工具、团队生命周期自动挂载/持久订阅、远端恢复及返工；当前不宣称全产品自动闭环。

- 持久具名输出增量：受控 run.publishOutput 将冻结输出名称绑定到当前 Worker 已被 Hub 确认及归档的证据，禁止调用方提供 sequence/完成标志或替换已发布输出；控制器默认从持久 ledger 收集全部输出，再交 Hub 验收。真实验证场景覆盖发布/重复/非法参数和重新打开 profiles 后读取；同阶段新尝试隔离与缺失归档另有单测。尚非通用模型工具，未接团队自动挂载或跨 Host 输出中继。

- 可信 Agent 工具增量：受控 Host 按冻结允许列表安装 kode_verify_output/kode_publish_output，沿用精确实现、授权、工具日志及 workspace lock；内部调用必须具备完成准入且尚未结束的精确工具调用上下文。真实 ToolRuntime 执行固定验证命令并发布证据，控制器继续验收/交付；单测拒绝准入前、改参数和调用结束后异步复用。尚未验收模型自主选择工具，通用产物/评审工具及团队自动挂载、返工、IM 未完成。

- AgentLoop 工具链与通用证据工具增量：十二模式原生验收让脚本模型实际请求验证、读取返回证据 ID、发布输出并结束，所有调用计入团队预算；新增冻结仓库捕获与源快照绑定评审工具，拒绝仓库参数覆盖和通过但含阻塞问题。修复实际发现的 scoped 工具显示问题，只安装阶段明确允许的工具，并验收各阶段模型可见集合。仍是 fixture 模型质量范围，尚未形成实际团队生命周期全自动开发与返工/IM 闭环。

- Host 生命周期接入增量：owner active 列表只返回可推进 Run 的紧凑元数据；WorkRunService 分页发现、有界监视并持久记录恢复阻塞，重启不重试相同修订的不确定执行，显式 retry 或 Hub 修订变化才重新考虑。默认适配器只接受已安装 Assignment 工具及匹配冻结哈希的已注册验证器。真实第三阶段使用服务发现并接续已选证据丢响应场景；仍待完整三阶段模型自主开发、返工、远端执行所有权恢复与 Builder/IM。

- 真实源码读取增量：新增仅接受相对路径的 kode_list_source/kode_read_source，绑定当前 Assignment、attempt、操作和实际持有的 cwd；限制文件大小/类型，拒绝路径穿越、符号链接、硬链接及 Git 元数据，并复核身份/修改时间/授权。原生 AgentLoop 场景让评审 Worker 真正列目录并读取冻结快照，把返回内容交给模型；仍使用 fixture 模型，不作为真实评审质量验收。写入工具、完整模型自主开发与返工仍待实现。

- 源码写入增量：kode_write_source 仅授予冻结阶段声明 workspace_write 的原始仓库作用域，使用 expected_sha256 防止覆盖变化内容，新文件使用排他创建，原子替换并同步落盘；授权丢失后的实际字节不擅自回滚，不用 already_present 清除不确定执行。模型经实际 AgentLoop 创建文件，真实工具修改后捕获归档，下游恢复核对修改内容；费用按新增调用结算。仍需目录/删除等完整编辑能力、派生写入、返工及完整需求自主交付验收。

- 失败证据与受限返工增量：配置 on_reject 的阶段可选择来源、快照、独立性及命令绑定均正确的 failed 证据；不确定结果仍拒绝。阶段结束复用停止/归档/工具/结算门禁，按冻结目标重置目标与后继阶段，历史 attempt 与证据留档，新派单递增 attempt 并携带失败输出。达到上限进入 waiting_user，不自动扩权；活跃受影响分支需先完成停止。完整返工后的再次执行与最终交付、人工处置和并行分支自动排空仍需验收。

- 返工后实际交付增量：十三模式原生场景继续执行 attempt 2，Host 服务驱动模型工具读取/修改/捕获/发布、独立读取新快照评审、真实命令验证和最终交付；旧失败证据保留，新证据与旧快照区分，重启交付收据保持一致。修复最后一次模型调用恰好耗尽预留额度时错误按新工作准入检查返回结果的问题，后续新调用仍受额度门禁。仍是 fixture 推理和显式测试计价/验证器配置，默认产品计价接入、真实模型质量及 UI 尚未验收。

- 冻结策略计价增量：调度目标可配置 internal_price_id，预检检查已存在的不可变价格、模型、预算单位与 internal_price 结算方式；派单事务同时绑定价格和预留，沿用唯一价格审计及不可替换规则。返工全链路已移除手工绑价，自动派单/返工派单均使用冻结策略。未配置字段保持旧接口和哈希语义，不伪造免费价格或供应商余额。

- 默认 Host 准备入口验收增量：抽取生产共用准备逻辑，新增从已激活请求开始的独立原生测试，无手工创建 Worker/选证据/补绑价格，无 fixture 工具或 per-Worker setup；内置工具完成修改、独立评审、真实命令验证和本地交付。缺验证器时在创建验证 Worker 前持久阻塞，注册冻结匹配定义并显式 retry 后继续。仍是模拟推理和显式 API 配置，Builder/用户恢复入口/真实模型质量尚未验收。

- 真实验证失败/次数上限增量：默认 Host 场景增加真实命令 exit 3 后返工成功，以及连续两次失败达到 max_reworks=1 的等待用户分支；核对失败命令归档、六个独立 Worker、两轮计价/资源释放、无误交付及重启后的阻塞。普通 retry 不再清除 waiting_user/终态的持久标记，必须先由 Hub 处理状态变更；人工处理入口仍待实现。

- 已结算任务人工处置增量：owner 可通过 cancel_settled 携带原因和修订结束 waiting_user 任务；Hub 核对全部历史 Assignment 的真实停止、最终结算和资源释放，保留阶段/返工/失败证据。真实默认工作流连续失败后覆盖越权、过期修订、重复并发、停用团队、SIGKILL 恢复和关联新请求；未模拟停止活跃任务。产品恢复入口、活跃并行分支停止及远端验收仍待完成。

- 远端已消费输入取消取证：remote-collaboration-host-crash 新增 running 场景，实际 native driver 消费输入后通过跨 Hub session 工具取消，受控 stream 接收 abort；四进程重启后同一输入仍只消费一次、原创建身份保持、取消保持 cancel_unconfirmed，不错误升级为 queued_removed 或已停止。该场景使用官方 zstd 存储和真实 Host/Hub，stream 为不付费测试适配器，SSH 由 loopback HTTP 替代；不构成实际执行器停止确认或真实模型验收。

- 原生停止证据增量：清理进程后有界探测原进程组，只有 ESRCH 记为 process_group_empty；主进程退出但进程组仍存在或缺少证据时保留持久准入限制。实际忽略 TERM 的进程验证 KILL 后退出与组清空，重开 profile 验证缺失/否定证据不会解除限制。脱离进程组的后代仍未知，session 取消尚未增加停止确认终态。

- 原生取消回执幂等增量：运行中/共享输入的首次取消处置按 inputId 写入官方 session 插件事件并 flush 后回报；结束后或 Host 重建后重试保持同一原因，不能误停后续/共享 turn。真实远端四进程重启后直接向恢复的 driver 重试，仍返回原 stop_requested 且无执行；磁盘 flush 失败不确认，重试复用同一事件。此回执仍非进程终止证明。

- 远端真实进程停止取证：四进程协作测试新增 native 模式，使用生产 AgentRuntimeAdapter、Codex 协议测试子进程和官方 zstd 会话存储；等待实际 turn 就绪后经 session 工具取消，检查绑定原输入的主进程退出/进程组清空记录，第二轮 Host/Hub SIGKILL 后记录完整保留且无重复调用。此处是实际协议进程执行，模型行为为 fixture、SSH 为 loopback；逃逸后代仍未知，取消状态保持 cancel_unconfirmed。

- 远端 Assignment 上下文增量：新增独立协商 operation_assignment_context_v1，通过已有 owner accounting relay 读取 home 唯一记录，绑定实际执行 peer/Worker/操作/当前 attempt，超限明确拒绝；无本地复制或创建/派发副作用。旧节点能力缺失不发送新动作，实际双 Hub 覆盖跨操作/身份/attempt 越权及 home 重启读取。远端创建、准入、停止和完整工作流仍未接通。

- 远端创建回执增量：独立协商 operation_assignment_creation_v1，复用 home 幂等事务并在回放前核对真实执行 Host；审计记录执行节点。双 Hub 验证 uncertain 并发重复、内容冲突、伪造命令、session 越权、本地入口冒充远端拒绝、home 重启和单次审计；无准入的 created 拒绝。尚未构成远端实际 Worker 创建成功验收，准入与生命周期仍待接通。

- 远端 Host 准入增量：独立协商 operation_assignment_admission_v1，复用本地冻结配置、实时授权、预算、资源持有与派生上下文门禁；事务回放前核对执行 Host/Worker，审计区分远端。双 Hub 验证缺资源拒绝、模型作用域配置不符/越权拒绝、home 预留后准入、远端认领后 created 回执成功及重启幂等。当前为 owner API 协议验收，尚无实际远端官方 Worker 创建/物理锁验收。

- dsh home 路由增量：统一 Assignment context/admission/creation 的本地与远端路径，远端故障不回退本地，返回上下文核对实际执行 Host/Worker/操作/attempt；官方执行器准入及 mandate/model 输入校验已接入。双 Hub 协议测试经生产 helper 读取/准入/回执；锁生命周期测试使用受控锁实现，不宣称远端物理锁或完整 Worker 创建验收。

- 远端派发 primitive 增量：新远端派单冻结 operation.home_node，官方创建指纹及 binding 校验包含 home；dispatcher 接受明确 homeScope，经 home 读取并回传创建回执，要求 home 资源已持有，跨 home 并发/账本冲突拒绝。真实 profile 持久化测试覆盖不确定创建不重建；Worker factory 为受控测试实现，不宣称实际远端官方 loop 创建验收。远端 start/派生目录仍明确阻塞，避免半接通后误走本地接口。

- 实际远端官方创建验收：独立 native Node fixture 使用两个真实 Hub、生产 AssignmentDispatchHost/OfficialLoopHost/OfficialExecution、官方 AgentLoop/zstd 存储和 kernel flock；home 派单/预留后远端真实创建，锁竞争拒绝，回执落库后丢响应和 home SIGKILL 后仍复用同一 Worker。模型调用为零，真实落盘创建 marker 和 home binding 保留；Host 关闭只释放物理锁，不伪造 home 停止回执或释放账本资源。仍非实际 SSH 部署或远端任务执行验收。

- home 远端 mandate 增量：owner 接口从已配对 peer 目录核对 Worker，沿用实时授权/租约/资源门禁，事务写入原有 outbox。实际双 Hub + 官方 Loop 测试扩展到任务消费、内部定价记账、提交后丢响应及重启重放；模型受控，无付费推理。远端 start、产物/停止结算及自动流程推进仍待接通。

- 远端停止增量：独立协商 operation_assignment_stop_v1；home 事务在历史回放前验证执行 Host，保留冻结命令/已认领 attempt/最终产物与输入校验。dispatcher 以明确 homeScope 排空实际执行并持久化关闭后回传；双 Hub 官方 Loop 验证错误作用域/本地冒充/session 越权拒绝、已提交丢响应及重启重放单次审计。停止不等于完成，预算资源仍持有，产物与结算闭环继续推进。

- 远端 WorkRun 上下文与消费门禁增量：新增独立协商 operation_assignment_run_context_v1，按已授权 Assignment 推导只读 Run，拒绝跨 Worker/attempt/hash 和超限。生产源文件/产物/验证/最终快照读取使用 home 路由；产物接收和阶段选择按执行 Host 查询本地消费或已认证的远端消费镜像。实际远端读取源码并生成本地归档，元数据回到 home；归档字节传输尚未实现，后续推理由完整性门禁明确阻止，不宣称产物交付完成。

- 远端归档字节增量：新增独立协商 operation_artifact_archive_v1，32 KiB 网络分段汇入兼容的 256 KiB 存储块；绑定实际执行 peer/Worker、操作/当前 attempt/产物 producer，重复字节重放、乱序与冲突拒绝。原有全量 hash/manifest 校验后才 complete。真实双 Hub 多块归档故障测试覆盖提交丢响应、未完成不可读、越权/混淆拒绝、重启和单次完成审计；官方 Loop 已由 pending_home 推进到实际 home_archived 并继续推理。仍未完成远端派生工作区、验证日志与自动流程推进。

- 远端单阶段结算增量：home 控制器在获得已认证的远端停止回执后，复用本地的冻结计价与阶段完成门禁；未排空仍 waiting_remote_host，不创建本地替代 Worker。实际官方 Loop 测试加入模型发布产物、home 选择真实归档证据、发布后修改源文件拒绝最终报告、恢复后最终快照/报告/停止及 home 结算。仅通过该阶段，配置的后续阶段仍要求执行；选择/报告前的跨 Host 自动编排尚需集成。

- 远端产物声明与 home 自动选择增量：独立协商 operation_assignment_outputs_v1；声明精确冻结命令与完整产物集合，home 验证身份、授权、消费、证据与归档后只记声明，不选择或完成。声明丢响应可幂等重放且不能替换；home watch 通过原有 owner 证据入口自动选择后等待远端报告。等待远端不再被服务持久化为人工恢复阻塞，旧 waiting_remote_host 记录可在同 revision 恢复监听，真实故障恢复限制保持。远端声明泵/报告生命周期服务仍待集成。

- 远端生命周期服务增量：默认 managed Host 启动有界轮询服务，仅扫描已有远端 Assignment binding；按真实所有权/已消费输入/idle/home 选择推进声明、最终检查、报告和停止。报告前落盘 reporting，报告不确定且未持久化 operationClosed 时重启也不自动重报；本地 drained 未获 home 确认仍重试，确认后 acknowledged 才退出扫描。新建/恢复 Worker、发现派单和 mandate 发起仍未由此服务承担。

- 远端待创建派单目录增量：新增独立协商 assignment_catalog_v1，只读复用认证 Host 目录通道；home 按实际 peer 返回该执行节点已持有资源的待创建派单身份与冻结 operation，最多 64 条/64 KiB，调用者不能指定其他执行 Host。owner-only API 与 dsh discoverRemote 校验 home/Host/排序游标/操作身份；真实双 Hub 测试从目录发现任务后实际创建并验证已创建项退出目录。自动扫描创建及 home 资源/mandate 编排仍待接通。

- Home remote initiation: trusted WorkRun controller now reserves resources and submits mandates after authenticated creation and exact Worker directory propagation; uncertain creation/released holds require recovery. Automatic remote creation scanner remains pending. Validate via actual two-Hub official-loop fixture and lost-response replay.

- Execution Host automatic discovery is wired into managed runtime startup/shutdown: paired-home round robin, bounded batches, home context/preparation, existing creation ledger. Default preparation now reads the authoritative remote WorkRun. Actual two-Hub fixture invokes creation through the discovery timer. Remote derived workspace materialization and complete multi-stage remote workflow acceptance remain pending.

- Remote verification record transport: bounded negotiated segments, immutable home staging and final validation, wired into durable dsh archive replay. Added staging/conflict/scope and capability tests plus client segmentation checks. Full real remote command/derived-workspace acceptance remains pending.

- Consumer-scoped remote artifact metadata/segment download and read-only materializer support added. Exact frozen input identity and authenticated consumer are required; no arbitrary archive lookup. Remote workspace receipt/scope authorization and dispatcher integration remain pending.
- Follow-up ordering requirement: remote derived Assignment discovery must permit workspace preparation before execution resource holds. Home must wait for derived workspace scope before reserving; execution must never create until scope and holds are both authoritative. Current held-only catalog and early home reservation need coordinated adjustment when wiring remote workspace receipt/scope.

- Remote derived workspace receipt relay and owner-side scope authorization wired, with executor validation before replay. Derived preparation is discoverable without execution holds; home authorizes scope before reserving, dispatcher waits before creation. Actual dual-Hub downstream creation/lost workspace acknowledgement tests added. Full remote review/verification mandate/tools/closure still requires acceptance.

- Extend real remote official-loop acceptance to three distinct Workers: artifact production, independent review, trusted command verification with a >200 KiB log, home-selected completion and restart persistence. Controlled model replies only. Added immutable local archive caching with authoritative metadata and byte/tree revalidation to avoid repeated transfer during guards. Acceptance result pending final test run.

远端三阶段组合取证（increment 218）：真实双 Hub、官方 loop/存储、三个独立 Worker 已通过产物→独立评审→实际命令验证→home 交付；超过 200 KiB 验证日志完整归档，24 团队内部 credits 结算、预留归零，Hub SIGKILL 重启后交付收据与日志一致。完整集成 538 项：527 passed / 11 skipped / 0 failed（/tmp/superagent-remote-pipeline-preflight-final.log）。模型回复由受控 fixture 提供，首阶段捕获现有源码，不等同于真实供应商实现需求、SSH 或 UI 验收。运行中 WorkRun 取消、Builder、IM 和剩余 AC 仍未完成。

运行中取消增量（219）：新增 owner-only request_cancel，同事务持久化取消意图、撤销活跃/不确定 operation 租约并递增 epoch；全部分支身份校验失败则全回滚。保留预算/资源预留，返回 cancelling 与 stop_confirmed=false；普通 Host 推进不再进入派发/交付。真实 Hub 定向测试覆盖幂等、越权、重启和取消后拒绝派发；Rust 多分支回滚测试通过。执行器停止回路、取消后结算/资源释放和 cancelling 的恢复发现仍待接线，不勾选完整取消验收。

取消结算增量（220–221）：本地/远端停止路由提前于 idle/consumed；取消中 Run 可恢复发现；新增 finalize_cancel 原子校验各分支停止证据与最终账本，未获准入且无执行/计费活动的任务可按零消耗结算。未知停止或费用阻止最终取消，不释放部分分支。真实 Hub 验证未准入释放与重启；真实本地工作流在验证返工上限后验证六个已停止/结算 Assignment 的取消收据与历史费用保留。运行中模型/工具取消的真实本地/远端故障组合仍待补齐，完整回归 81194 仍在进行，不勾选完整取消验收。

忙碌取消取证（222）：真实本地官方 loop 的模型 stream 中取消，以及真实验证子进程运行中取消，均覆盖取消/停止回执丢失、Hub SIGKILL 后幂等恢复且不重新执行。模型中断导致费用不确定时保留预留并拒绝最终取消；已知模型费用且子进程确认退出时保留已发生费用、释放预留并保存取消收据。验证进程退出不确定时新增执行器停止保护。六模式本地 fixture 全通过；完整回归 64798 进行中。远端忙碌取消及执行 Host 崩溃组合仍待验证，不等同完整取消验收。

远端忙碌取消增量（223）：真实双 Hub/官方执行器的忙碌模型取消目标已通过，覆盖取消与停止回执丢失、执行端持久记录重开、服务重建确认及双 Hub SIGKILL 恢复；未知费用仍保留预留且不得最终取消。远端实际验证子进程取消目标 69910 运行中，尚无通过结论。执行 Host 进程崩溃与完整验收仍待补齐。

执行 Host 崩溃增量（224）：真实官方 Host 在 stopping/drained 持久边界 SIGKILL 后，由新 Node 进程重建取消控制服务；前者保持未确认停止，后者只补传一次停止收据，均不重建 Worker、不释放未知费用预留。定向 14 项通过。远端验证子进程取消目标 69910 已通过（420 s），完整回归 64248 含新增远端场景与 Host 崩溃测试，尚在运行。远端执行 Host 进程崩溃与产品级待对账/未确认停止处理仍待补齐。

远端执行 Host 崩溃取证（225）：父测试进程在真实远端官方 Host 的 stopping/drained 持久边界 SIGKILL，保留双 Hub，由新的 Node 进程恢复生产远端取消服务。无停止证明保持未确认；已停止证明仅补传一次，下一次恢复已确认、不重建 Worker。四个本地/远端场景通过（/tmp/superagent-remote-host-cancel-crash.log），并验证 home 预留及审计不重复。属于控制平面恢复验收，不代表 GUI 全启动、SSH/供应商或任意失控子进程已验收。

Builder 取证起步（226）：新增已认证 owner 的 Host-local 工作区取证入口，限定已登记工作区及显式选择的根目录项目文件，返回路径/hash/时间及不可信项目内容，不执行命令或创建 Worker。实际文件与权限/目录回归 11 项通过；嵌套 CI/skills、可恢复问答草案、Builder 工具授权和激活仍待实现，4.1 不标完成。

Builder 草案恢复增量（227）：home Hub 新增 owner-only 创建问答快照，版本冲突检测、请求幂等、终态撤销及可分页找回，保存不创建团队/Worker。真实 HTTP 与 Hub SIGKILL 恢复 2 项通过；数据库 v25 升级保留文档/快照备份测试通过。自动访谈、facts 关联、Builder 专属授权/创建预算和最终激活衔接仍待实现，4.1/4.4 不标完成。

Builder 事实绑定增量（228）：取证准备入口核对草案版本及本地已选工作区，再生成精确保存命令；Hub 校验内容/hash/字节数及引用，历史命令收据可恢复，事实始终是不可信项目资料。实际文件+HTTP 等 10 项通过，覆盖 BOM、大于 128 KiB 快照、重启、文件变化后原请求重试和部分刷新；自动访谈/远端取证/授权预算/激活尚未完成。完整回归 55013 进行中。

Builder 分轮问答增量（229）：参考 workflow-builder 访谈方法，新增持久化可配置问题模板，每轮最多三个未答问题，复用答案、显式条件分支、变更后失效旧建议，默认覆盖研发决策且不固定交付终点/模型/平台。实际 HTTP/恢复与相关测试 10 项通过；语义理解、资源推荐、配置生成、正常/异常演示、Builder 预算授权和激活仍待补齐。

Builder 配置预检增量（230）：草案候选配置复用已有团队的流程角色、项目/交付引用及预算/调度策略校验，不为校验创建团队；明确缺项与尚未验证的资源可用性。真实 HTTP 和相关回归 6 项通过，草案版本冲突/撤销/越权拒绝。完整资源预检、生成配置和激活衔接仍待完成。

Builder 资源诊断增量（231）：候选预检逐一覆盖已配置目标，复用 home 的账号/额度判定，未知和团队预算回退不伪装成真实余额；团队预算另列标签、可用额与周期/范围。双目标、额度耗尽、账号禁用/重启、预算不足及无预留副作用的实际 HTTP 等 4 项通过。执行器硬能力、角色适配和真实准入仍未完成。

Builder 受控执行入口增量（232）：新增固定草案/候选团队的两个只读官方工具，要求预算和 grant 操作，经现有 lease/模型用量/工具审计执行。真实官方 loop + Hub 配合受控模型完成三次调用与 6 内部 credits 记账，范围越权和未配置预算拒绝；连同已有资源工具隔离测试 2 项通过。自动创建入口、完整访谈及配置写入/激活未完成。

Builder 官方取证/问答增量（233）：受控 Agent 新增项目取证与下一轮问题准备，工作区须同时满足草案选择和操作 grant，模型不能伪造用户答案。真实 loop 五次受控调用、四条工具审计、10 内部 credits 计费，连同取证/恢复等 7 项通过。输出仍是待保存命令；模型写入权限及自动创建/激活未完成。完整回归 46439 进行中。

Builder 草案写入授权增量（234）：owner 将操作 attempt 绑定固定草案，新增专用 builder_draft_write 权限。Hub 在草案事务内复查 lease/预算/grant，记录真实 Builder actor，只允许问题和配置建议变更，不能改用户答案/范围/观察或撤销。真实 HTTP/重启及相关测试 4 项通过；官方保存工具接线、自动创建和激活仍待完成。

Builder 官方保存工具增量（235）：专用写权限下仅保存问题和团队建议，Host 固定草案/操作身份；提交响应丢失通过精确收据读取恢复，不重复写入。真实官方 loop 六次受控调用、五条工具审计、12 内部 credits、单次草案版本增量通过，连同权限/隔离回归 3 项通过。自动创建、Host 观察持久化、用户回答及激活衔接仍待完成。

Builder 用户回答增量（236）：新增 owner-only 回答命令及 dsh 转发入口，答案、分支失效、旧建议清除与收据原子提交，模型工具不能调用。真实 HTTP/并发/响应丢失/Hub 重启和相关回归 9 项通过；无 IM 界面，自动创建和激活仍待完成。

Builder 持久化创建增量（238）：现有官方创建命令增加固定草案/候选团队范围并纳入原幂等指纹，由生产入口自动挂载完整受限 Builder 工具。真实官方循环及普通创建 SIGKILL/收据恢复等 7 项通过；Builder 资源、会话、操作、预算及授权的自动准备仍待接通，不代表完整创建助手交付。

Builder Host 准备增量（240）：生产 prepareBuilder 从已授权的 prepared operation 检查预算/价格、grant、工作区、配置模型及资源绑定，保存 Hub 草案范围并创建匹配的本地执行绑定，返回原持久化创建命令。提交丢响应重试与真实官方循环等 8 项通过。它仍依赖预先配置的 session/operation/预算/grant，完整自动创建和访谈激活尚未完成。

指令资源与只读会话收尾（722／731）：本地原生历史只读、提前 Host/Gateway 拒绝、普通会话草稿回归，以及 WorkflowPack 可选 Skill/Plugin 指令资源的不可变登记／预检／阶段注入／模型 provenance 已有专项证据。创建助手使用 v7 提示词，激活前展示来源和权限。完整 P0–P6 勾选仍等待当前全量回归与逐项验收，详见 acceptance-audit.md。
