# Design — Superagents IM v2

> 2026-11-01 起草。当前实现与验收范围见 validation.md，历史设计中的拟议结构以实际接口为准。
> 需求和验收以 [proposal.md](proposal.md) 为准；上游证据见 [upstream-assessment.md](upstream-assessment.md)。本轮只修改本 change 的文档。

## 1. 产品对象与架构

### 1.1 三种对象必须分开

| 对象 | 含义 | 生命周期 | 用户可见 |
|---|---|---|---|
| Superagent | 长期负责某范围的联系人 | 用户创建到归档 | IM 联系人、聊天、团队设置 |
| WorkerSpec | 逻辑角色、职责与允许资源池 | TeamSpec 一个版本 | 创建/设置的可选高级详情 |
| RuntimeSession / Assignment | 某次工作实际采用的执行器与会话 | 可重建、轮换、重试 | 工作过程、session 排障 |

团队搭建助手是内置 `kind=builder` 的 Superagent。用户自建的为 `kind=coordinator`。所谓 Router 是 coordinator 的内部职责，不是另一个必须让人理解的产品对象。

同一个 Superagent 可以并行管理多个 WorkRun。联系人 ID 不取 session_id；上下文压缩、模型更换、会话失效不能使联系人或历史消失。Worker 默认按阶段懒创建，并不把“已配置 5 个角色”解释成必须启动 5 个付费会话。

用户可以指定已有 Worker 资源作为团队成员，也可以让 Builder 建逻辑角色并推荐候选。稳定 WorkerSpec 可长期保留职责与经审核的经验，实际上下文按任务/阶段隔离；跨任务复用会话必须检查工作区、角色、流程版本及上下文污染，不能为了常驻身份混合不同项目内容。

```text
用户
  └─ dsh IM：Superagent 联系人 / 长期私聊 / 工作过程
       └─ Kode Host：身份校验、IM API、Builder、Coordinator 运行、执行器适配
            └─ home_hub（Rust）：团队/流程/任务权威、授权、额度准入、事件、outbox
                 ├─ 本机 Worker adapter → 官方 dsh 原生 / Kode CLI 执行器
                 └─ link 协作协议 → 远端 execution Hub → Worker adapter
                                        └─ report/read/cancel ack 回 home_hub

session 模式 = 对上述 RuntimeSession 的排障投影，不是第二套调度系统。
```

一期一个用户、多个 Superagents，可用多个执行 Host。每个团队指定一个 `home_hub`，IM 私聊及其运行由该 Hub 独占写入；一期不做 authority failover 或跨 Hub 迁移。home_hub 离线时展示离线并排队，不改由远端擅自接管。

### 1.2 可核实的现有落点

- `host.js:110–170` 注册 session 工具，`:192–213` claim/followup/settle；不是长期 IM 身份。
- `session-create.js:26` fingerprint 不含模型/effort；`:81–90` 已有官方执行器 promote 兜底。此次接手测试 6/6 通过，不重复修旧 bug。
- `messaging/mod.rs:290–312` claim 全表读且一次一条；`link.rs:38–59` 扫消息并生成消息帧和终态收据。
- `model.rs` 的 Message、SessionInfo、Frame 都严格反序列化；新字段不能不经协商发送给 v1。
- `api.rs:127–131` 工作区文档白名单尚无 roles/teams；`store.rs:63–69` WAL+FULL，无迁移版本。
- `native-agent-factory.js` 的 Kode driver 与官方 dsh factory 是不同运行路径；Builder/Coordinator 使用受控官方原生 loop，不盲目 promote 成 CLI driver。
- `agent-client.js:1613` 已包装 sidebar.workspaces；现有 sidebar shell 拥有“新建会话”。IM 不能只替换列表而保留错误的创建按钮。
- 本地 `dsh-client-ui-layout` 暴露 selectPanel，官方 sidebar 有 sidebar/workspaces/settings 等槽位。具体模式入口集成在 P5 验证，不能再加互相嵌套的 monkey patch。

## 2. TeamSpec、创建与配置版本

### 2.1 拟议结构

```ts
type PrincipalRef = { kind: 'human' | 'superagent' | 'worker' | 'system'; id: string };
type WorkspaceRef = { host_id: string; workspace_id: string; root_ref: string };
type ExecutionTarget = {
  id: string; host_id: string; executor_profile_id: string;
  provider_id: string; model_id: string; effort?: string;
  account_binding_id: string; capability_profile_revision: string;
};
type WorkerSpec = {
  id: string; role: string; responsibilities: string[];
  allowed_target_ids: string[]; required_capabilities: string[];
  workspace_refs: WorkspaceRef[]; max_parallel: number;
};
type TeamSpec = {
  id: string; revision: string; home_hub: string; owner_id: string;
  name: string; purpose: string; kind: 'builder' | 'coordinator';
  workspace_refs: WorkspaceRef[]; workers: WorkerSpec[];
  coordinator_targets: string[]; workflow_pack_refs: { id: string; version: string; hash: string }[];
  grant_id: string; budget_policy_id: string; scheduling_policy_id: string;
  limits: { max_active_assignments: number; max_active_runs: number };
  proactive_mode: 'off' | 'observe' | 'auto';
};
```

示例字段不是现有 JSON schema。实际运行另存 `team_revision`、`workflow_hash`、prompt/skill artifact hashes。更新 TeamSpec 创建新 revision；运行中工作继续绑定旧快照，权限撤销即时生效，主动迁移流程必须记录原因和被失效的证据。

### 2.2 Builder 对话流程

1. 用户说明“我要一个负责哪个项目/哪类工作的 Superagent”，或选择已有工作区。
2. Builder 在被选工作区只读检查 README、AGENTS、测试/构建/CI、现有技能与依赖，生成 facts（路径、hash、发现时间）与缺项。
3. 分轮提问，每轮 1–3 个关键问题：完成标准、是否保留人工验收、允许哪些资源、预算/专家升级、commit/push/deploy/外部通信等边界。已答和可核实事实不重问。
4. 推荐职责角色而非要求用户熟悉模型名；高级入口允许指定 Worker/模型/effort。模型清单与可执行环境来自受信目录。
5. 生成 TeamSpec 草案与 WorkflowPack 草案；只读预检能力、验证入口、余额 coverage。缺项明示，不以 LLM 推测冒充已经可用。
6. 展示一个正常案例和一个失败/返工案例，以及具体授权；用户激活后冻结 revision，创建联系人与 DM。
7. 草案支持保存、恢复、编辑、撤销；激活是幂等事务。Builder 不能在采访时安装插件、执行生成的 shell 命令或启动 Worker。

Builder 的产物是一份宿主可验证的声明式配置，不让 LLM 任意生成可执行 JS 当调度核心。扩展 skill/plugin 必须记录来源、版本、可用宿主、要求的工具及权限；缺依赖进入待补齐，不能把整个 palm-device 包复制为通用默认。

## 3. 流程：prompt、plugin、状态机各负责什么

| 层 | 责任 | 不能负责 |
|---|---|---|
| 系统/角色指令 | 理解任务、委派原则、如何反馈、怎样调用技能 | 不能作为授权或阶段完成的唯一依据 |
| WorkflowPack（plugin/skill 资源） | 场景流程、领域方法、命令、角色输入输出、例外规则 | 不能改后端已授权的能力范围 |
| Hub 执行状态机 | 阶段依赖、证据校验、名额/预算、重试与取消、版本冻结 | 不能凭有限结构证据证明所有业务逻辑正确 |

### 3.1 WorkflowPack v1

```yaml
id: software-delivery
version: 1
triggers: [feature, bugfix]
stages:
  - id: plan
    role: planner
    requires: [request]
    produces: [acceptance_spec, change_scope]
  - id: implement
    role: implementer
    requires: [plan]
    produces: [artifact_snapshot, implementation_report]
  - id: review
    role: reviewer
    requires: [implement]
    independent_assignment: true
    produces: [review_verdict]
  - id: verify
    role: verifier
    requires: [review]
    produces: [verification_report]
  - id: deliver
    role: coordinator
    requires: [review, verify]
    produces: [delivery_summary]
on_reject: implement
```

以上是示意；阶段的结构化约束还包含：输入/输出 schema、验收场景、资源锁、workspace scope、timeout、retry/max_rework、升级门槛、允许自动推进的操作、人工条件、取消方式。验证命令绑定 workspace revision，不允许自动执行来自外部消息的任意字符串。

一期支持有向无环阶段依赖和受限显式返工边；不提供任意脚本工作流。`feature` 与 `bugfix` 两种入口；bugfix 必须先有复现/根因证据或显式“无法复现”的人工处置，再进入实现。简单任务可使用用户已启用的轻量模板，不能为省钱擅自跳过该模板的评审/验证。

### 3.1.1 默认模板、项目绑定与交付终点

“实现→独立评审→验证”是研发任务的默认质量流程建议，不是 Hub 硬编码的全部业务流程。声明式 WorkflowPack 定义阶段依赖、所需证据与完成条件；Hub 通用校验这些条件，不以固定阶段名称判完成。轻量模板或例外可在团队配置中明确启用，执行中不能因预算不足自行删掉验收步骤。

配置分为三部分：

- WorkflowPack：需求分析、实现、评审、验证及可选提测/发布等阶段、输入输出与返工规则。
- ProjectBindings：代码仓库/托管服务、需求缺陷管理、CI、制品与部署目标；支持一个工作流引用多个明确命名的仓库，项目管理不假定与代码仓库是同一系统，也允许纯本地、无远端工单。
- DeliveryPolicy：用户期待的完成终点及完成证据，例如本地产物已验证、PR/MR 已创建且 CI 通过、等待人工合并、已合并或已部署。各终点绑定明确目标分支/环境及权限，不只保存自由文本。

适配器按能力注册（如读取需求、创建变更请求、查询 CI、回写工单）；GitHub、GitLab/工蜂、TAPD/Jira 等只是可选绑定示例，不表示本期全部实现。核心契约使用外部对象引用和能力，平台专有字段留在适配器。配置只引用受控连接 ID，不携带凭证。

创建助手从选定工作区发现可核实配置，询问“工作从哪里来、代码在哪里、做到哪一步算完成、哪些动作可自动执行”，生成草案和预检。首期先交付纯本地能力及明确选择的适配器，缺失适配器要显示待接入，不能假装通过。

WorkRun 冻结流程、项目绑定和 DeliveryPolicy 的版本。单次请求可选择已有模板或明确覆盖终点，但须预检、记录新快照且不扩大授权；运行中改终点是显式修订。若目标是部署，代码验证通过只是中间进度；若目标是创建 MR，MR 创建且要求的检查满足即可完成该工作，无需等未来合并。人工门禁未满足时保持 waiting_user，不能标完成。

推荐模板的独立评审证据仍要求独立 Assignment；自定义模板若不要求评审，结果必须准确说明未执行，不能显示“已评审”。硬约束是授权、版本与证据一致、可追溯以及不能虚报通过。

### 3.2 不重复人工编排

用户一次激活团队授权后，“实现这个需求”就是该流程的启动入口，不需要说出阶段名称。`proactive_mode=observe` 仅控制无明确请求的主动工作，不应像 v1 一样把明确请求也一律改成“只演示派单”。超出原授权、影响需求结论的歧义、预算升级和必须人工操作的验收才找用户。

内置 dsh workflow 工具目前描述要求用户显式请求 workflow，且以模型编写 JS 为入口；不能直接依赖它让自然需求自动走强制流程。应由 Kode 的已激活 WorkflowPack 和专用工具启动，并按所处角色收窄其他委派入口。

### 3.3 证据与返工

- `artifact_snapshot` = repo identity + base revision + tree/patch hash + 可选 commit + 产物哈希。未获 commit 授权时也能验证，不要求先提交。
- Review 绑定精确 artifact_snapshot，使用独立 Assignment/上下文；模型可以相同，但不能由实现者自己的会话给自己过审。
- Verify 绑定同一 snapshot、环境、命令/场景、exit code、日志/截图等。通过的旧版本不能证明后续修改已通过。
- 评审/验证不通过：结构化 findings 回派实现者，生成新 attempt，旧证据保留但标 superseded。
- 完成条件是必需 evidence 全部有效、独立性满足、无阻塞 findings、必要人工确认齐备；`report(ready)` 只结束一次 Assignment，不能直接完成 WorkRun。
- 便宜模型可以执行既定验证步骤和整理报告；设计复杂测试、判断疑难结果仍按能力和风险升级。命令通过不等于业务验收全部通过。
- “人工暂不验证”只能形成明确 waiver（操作者、范围、原因），不能把 waived 伪装为 passed；流程是否允许带 waiver 交付由团队策略规定。

## 4. 能力目录与模型选择

### 4.1 能力信息分层

硬能力来自真实 discovery/adapter：工具、结构化输出、图像、上下文上限、effort 列表、文件/终端能力、权限、运行/停止/恢复能力、额度采集能力。

软评价来自可编辑 CapabilityProfile：任务标签适配、价格档、时延偏好、强弱项、证据、来源（user / documented / measured）、置信度、更新日。用户举例只作为 user 来源草案，不能自动变成“客观排行榜”。价格随 provider/account 不同，缺价格时标缺失，不能默认最便宜。

Builder 推荐步骤：发现真实可用资源→读取用户偏好/可维护知识库→指出证据不足→给默认团队建议。实际任务结果可产生待审核的调优建议；不能静默改用户钉住项或因单次成功自动扩大权限。专门测评会消耗费用，只有用户授权或已有测评预算才运行。

### 4.2 调度契约

1. 硬过滤：团队允许、权限/工作区、角色能力、工具/技能、模型/effort、验证独立性、资源锁、额度准入和账户并发。
2. 质量下限：不够完成该阶段的候选排除，不能让低价抵消硬质量要求。
3. 软排序：角色适配、预估成本、延迟、额度余量与新鲜度、账户负载；权重可编辑，返回候选及理由。
4. 钉住偏好仅在可用候选中优先；无可用候选由 Superagent 解释原因并请求必要决定。
5. Hub 原子预留账户预算、团队名额和资源锁，再派发；模型选择决策写入 audit。
6. 连续失败或困难程度变化按配置升级，携带最小证据和产物，不搬运全部会话。升级超出授权预算时暂停对应阶段。

`ResolveSelection` 仍统一手动与程序入口：显式不支持拒绝、继承不支持说明降级、allowedModels 先校验。fingerprint 覆盖 model/effort/role/workspace/assignment/配置 revision。校验必须在会话创建前完成。

Rust effort 适配采用 None / Flag / ConfigOverride / ModelSuffix / AcpOption / TurnRpc 的数据配置；不增加 positional。模型/effort 生效回读返回 pending / confirmed / mismatch / unverifiable。严格阶段可要求 confirmed 后执行；发现 mismatch 不静默继续。

托管会话选模型必须是会话级操作，不修改全局 dsh 默认模型或其他团队设置；上游 role-models.ts 对首次请求播种的设计可参考，不能机械复用可能改变全局默认的选择入口。

## 5. 额度：覆盖目标、事实边界与资源准入

### 5.1 三类账不能混在一起

| 类型 | 例子 | 能说明什么 |
|---|---|---|
| provider quota/balance | 官方余额、订阅窗口、账户 credits、key/组织限额 | 该来源报告的真实限制，具有采集延迟 |
| platform budget | 团队每次/每日允许花费，专家调用预算 | 用户在本系统授权花多少，不是供应商余额 |
| observed usage | token/cost/credit 消耗 | 已观测到多少，不能单独推算真实余额 |

全部 ExecutionTargets 都进入 coverage 清单，包括 Builder/Coordinator 和可嵌套的 Worker。共享账户不复制余额。资源可以登记为 pending，但要明确是“已登记”还是“可自动执行”。

**D1 已确认**：允许用户录入预算，系统扣减并明确标为“团队预算”。供应商不提供真实余额时，可在已配置预算、计量与授权范围内执行；coverage 仍记录真实余额不可用。团队预算不代表供应商存款，也不能覆盖已知耗尽、认证失败或服务限流。

网络故障和服务方不提供数据使“永远没有未知状态”无法保证。内部必须保留 unavailable/stale/null 才能正确处理故障；产品不能把它们显示为 0 或满额。准入依据来源状态及已配置的团队预算策略；缺失计量且无可执行的保守计费上限时暂停派单，不让 Router 猜余额或假定免费。

### 5.2 采集矩阵与当前证据

| 资源族 | 可用路径 / 核实状态 | 缺口 |
|---|---|---|
| dsh 原生 DeepSeek API | 官方 `/user/balance` 已查阅 | 需 Host connector、账户绑定与实际接入测试 |
| OpenRouter | 官方 `/api/v1/key` 的 key/预算信息已查阅 | key limit 与账户余额不是同一量；必须保留 scope，核对所有适用限制 |
| Codex 服务账号 | 官方 `account/rateLimits/read` / updated，含多 limit_id | 本地 adapter 尚未消费；登录方式与 CLI 版本需协商，字段可缺失 |
| tcodex 等封装 | v1 交接记录 rate_limits 为 null；本轮未读私有会话重新验证 | 需要该服务自己的受支持额度来源，不能继承 Codex 可用性的结论 |
| Claude/tclaude | v1 记录版本差异；可研究已有官方输出/用户启用 statusline | 本轮未验证全量账户覆盖，不能承诺现有版本全部支持 |
| codebuddy / 通用 ACP | 现有交接主要为消耗/cost | 消耗不等于余额，需供应商或组织账务 connector |
| Cursor、Kimi、其他模型 | 取决于实际购买渠道和执行器，模型名不能决定计费来源 | 创建时发现并做 coverage；本轮未查用户账户/凭证 |

官方来源见 upstream-assessment.md；不读取其他 CLI 凭证、不访问未核实私有端点、不调用充值/额度重置/外发邮件接口。Host 可用其已有受控凭证调用允许的官方查询接口，不把 key 交给 Agent。

### 5.3 数据、账号身份与时效

```ts
type QuotaSample = {
  account_binding_id: string; account_epoch: number;
  limit_id: string; window_id: string; model_scope?: string;
  kind: 'balance' | 'usage_window' | 'key_cap' | 'organization_budget';
  unit: 'percent' | 'tokens' | 'requests' | 'usd' | 'cny' | 'credits';
  remaining: number | null; limit: number | null; used_percent: number | null;
  resets_at_ms: number | null; observed_at_ms: number; received_at_ms: number;
  source: string; source_version: string; quality: 'reported' | 'derived';
  reached: boolean; valid_until_ms: number; completeness: 'complete' | 'partial';
};
```

- 一致用 unix ms，CLI 的秒在 adapter 转换，防止现有 messaging.now(ms) 与 quota 秒混用。
- `account_binding_id` 是受信资源注册生成的不透明 ID，不哈希凭证，也不再把 home+limit_id 当账号身份。多个 limit/window 属于同账号；同目录换账号必须换 epoch。
- 无可获得的非敏感账户 ID 时由用户确认资源是否共享账号；未确认时不假装已去重/已精确总计。跨 Host 共用账号需指定统一 budget authority；一期建议 home_hub 负责，不支持多个 authority 同时分配同一预算。
- 收到旧样本不覆盖新样本；验证数值、时间漂移、来源作用域。普通 session 不允许提交官方 quota，只能上报自身 observed usage。
- sample 超过 source TTL 标 stale；最多使用策略允许的短时有效快照。重置时间过去后将相关窗口视为等待刷新，不自动恢复满额，不清除其他未重置窗口。
- 多限制取最严格适用限制，不把互不相干的币种和百分比相加；明确无限额度仅由来源声明，null 不能解释为无限。

### 5.4 团队预算账本（D1 已确认）

- BudgetPolicy 保存 team_id、币种/计费单位、金额、周期/时区、revision、授权者；金额和周期由用户配置，不自动加钱或续期。Builder 尚未归属新团队时使用单独配置的创建预算。
- 展示“团队预算：已扣减 / 已预留 / 可用”，供应商余额另列来源与更新时间。可用 = 本期授权额 + 有记录的调整 - 已扣减 - 未结预留；不同币种不直接相加。
- 启动前原子预留，包含 Coordinator、Worker、专家和允许的子执行。每条计费事件有唯一 ID；重复回报不能重复扣减，真正重试产生的费用仍扣减。
- 优先使用可核验费用；只有 token 等用量时按有版本的价格估算并标“估算”，账单到达后追加差额对账。无供应商计费映射的订阅资源可配置独立内部计价，但必须标明这是团队核算价格，不能伪称真实支出。
- 失败任务也结算已经产生的费用；不确定是否仍运行/计费时保留预留、标“待对账”，不能超时就退款。预算变更、冲正、人工调整均留档，旧账不覆盖。
- 无计量来源时需可强制的单次消费上限及明确保守计费规则，否则暂停该资源。余额不足停止新派发；可控调用边界检查预算，进行中请求可能有延迟费用，不承诺外部账单零超支。
- 多团队预算独立，共用账户的真实限制统一检查；若另设总预算，则原子预留总预算与团队预算，不能把同一账户余额复制给各团队。

### 5.5 预留与通知

Hub 同事务检查账户可用额度、团队预算、全局/团队并发并写 reservation，dispatch attempt 持有 lease。成功按实耗对账，失败/不确定状态保留或标 disputed，不能盲目释放后重复派发。预留只控制 Kode 自身并发，账号在其他工具的消费仍可能导致漂移；调用前刷新、保守余量、429/402 分类响应共同处理。

额度不足时尝试已授权替代资源、等待明确重置/刷新或通知用户。不能自动降质、换账号、充值。通知阈值与冷却按团队配置，避免每个 Worker 各发一条。

给 Superagent 保留独立的小额沟通预算，并配置受授权备用目标。若所有模型都不可用，Host 在该聊天显示署名“系统”的离线/额度状态和可用操作，不伪造 Superagent 的模型回复；worker 仍不直接联系用户。

## 6. 权限、身份与工作区

### 6.1 委派授权

`TeamGrant` 包含：grantor human、team_id、允许的 host/workspace/规范化根目录、操作能力、网络/工具限制、预算、有效期与 revocation version。

```text
Worker 的有效能力 = TeamGrant ∩ 角色上限 ∩ 阶段需求 ∩ 执行器可强制的能力
Router 自身能力   = 只读信息 + 受 team_id 限定的协作工具
```

grant 由用户授权动作创建，Builder/Router 不能自己签发。`read-only` Router 可以安排 grant 内的 workspace-write Worker，不需要把 Router 自身提权。permission 字符串是展示层，后端以操作能力检查，不用简单字符串排序替代授权。

创建会话、消息发送、任务改派、账户/模型切换、发布操作均在服务端校验，不能靠工具隐藏或 role 字段自报。禁止 Worker 通过老 kode_sessions_create/send、全局模型目录、subagent 或动态工具绕过团队范围。嵌套子执行默认禁用；启用时也必须登记子 Assignment、继承 grant、占用资源与额度并留档。

commit、push、merge、deploy、外部通信是分别授权的能力。插件里写“自动提交/回写工单”不能超越 grant；已有明确授权不每轮重复询问。

### 6.2 单用户现在，多人未来

消息 sender 使用 PrincipalRef，human 身份由 Host 已认证用户映射；不得接受浏览器随意填的 admin/human id。返回数据按 team membership 检查。未来加多人账号前，不能把共用本机 admin 口令声称为多人隔离。

群聊预留 `conversation.kind=dm|group`、独立 member 及 ACL。未来多人多个 Superagents 场景可能包括跨项目协调、联合评审与人类讨论，但一期不自动派发群聊，不为未确认场景增加复杂 UI。

### 6.3 隔离执行与介入

- 工作区选择限定授权范围，不意味着修改用户当前脏树。代码写阶段使用固定 base 的 task worktree，review/verify 钉住该产物快照。
- 两个 Superagents 同仓库同时工作时各有分支/工作树；集成由明确阶段处理，不能把测试通过的未集成分支当最终结果。
- 只读评审不得修改源树；运行测试需要的 cache/temp 写入单独沙箱路径。设备/服务/端口等共享资源加 lease 锁。
- 无法在某 CLI/远端强制隔离、停止或团队工具范围时，不能将其标为兼容的自动 Worker，保留普通 session 可用性。
- session 排障默认只读；显式 takeover 暂停所属 Assignment 自动动作、撤销 lease/等待停止并记事件，人工恢复后重新核验产物与权限。

## 7. 工作运行状态与可靠性

### 7.1 拟议状态

```text
WorkRun: queued → running ↔ waiting_user / waiting_resource
                   ├→ completed（证据门禁）
                   ├→ failed
                   └→ cancelling → cancelled / cancel_unconfirmed

StageRun: pending → ready → running → passed / rejected / blocked / failed / cancelled
Assignment: prepared → dispatching → acknowledged → running → reported
                                       └→ uncertain / cancelling → stopped / cancel_unconfirmed
```

终态任务不直接复活；用户后续新要求创建新 WorkRun，并链接 prior_run_id。返工是同一 WorkRun 下新 StageRun attempt，旧 attempts 只读。结构版本、actor、expected revision、attempt_id 和 fencing epoch 全部参与转移校验。

### 7.2 派发事务与恢复

1. 认证请求；对 team/conversation + caller + idempotency_key 建唯一约束，内容 fingerprint 不同拒绝复用。
2. 同事务创建 WorkRun、固定配置版本和第一个 ready stage，写 audit 与待处理命令。
3. 调度事务申请预算/名额/资源 lease，写 Assignment（确定 session_id）、dispatch outbox 和审计。
4. adapter 以 assignment_id+attempt+epoch 幂等创建或找回运行；成功返回 binding，不在超时后直接再建一个会话。
5. assignment 消息携带不可变 mandate、阶段输入、产物版本、能力范围、上报地址与过期策略。启动成功不等于已读，更不等于完成。
6. 未知提交结果标 uncertain，查询执行端 receipt/session binding 后再决定恢复；外部非幂等副作用需要人工核对，不承诺 exactly-once。
7. report 在 home_hub 事务内保存、验证并触发下一阶段 outbox，重复 report 返回同结果。最终 IM 交付也经幂等 outbox，重启不重复发结果。

不在数据库事务里等待 CLI、HTTP 或 LLM。参考原型“事务内落命令，commit 后执行 effect”，不可用多次 REST 调用假装同步原子事务。

### 7.3 内部线程、批处理、已读

阶段线程已有负责人时只投相关 Worker；Coordinator 收结构化摘要。新需求仍先进入 Superagent；后续明确关联某工作项的补充可直达内部负责人，同时给 Coordinator 摘要，用户可见回答仍经 Superagent。

一个 Coordinator 只有一个活跃控制 turn，持有 epoch/lease。忙时内部事件合并；人工取消/授权等控制信号优先且不受模型回合阻塞。批次同时限制条数和总字符/token 预算，超长内容持久化并附可鉴权全文读取入口；不因截断丢证据。

区分 queued、accepted（输入持久化）、consumed（进入上下文）、reported。官方 dsh 有对应事件的 adapter 可以精确上报；PTY 只能标 approximate，不能伪装已读。任务关闭时撤回未消费输入；已进模型上下文的消息不能靠删队列撤销，只能停止执行并记录迟到动作。

### 7.4 取消、超时、进程恢复

通信层输入取消采用独立持久记录，不复用 message accepted 作为取消成功。请求由消息 source Hub 创建；远端执行 Host 仅处理匹配本地 input binding 的请求。双方协商 `input_cancellation_v1` 后，source 持续重发 requested，执行端按消息 ID 去重并返回已落盘结果，source 持久化结果后停止重发。结果丢失通过重发请求取回，不能重新执行撤回或停止操作。队列分页轮转，控制记录不因普通消息 TTL 被删除。旧协议连接不传此帧，能力未确认时拒绝新远端取消。

`queued_removed` 只证明特定输入从队列撤回；共享 turn 不允许取消某个输入时连带中断其他输入。`cancel_unconfirmed` 不能视为 WorkRun cancelled；执行器／子进程确认、lease 与 attempt fencing 仍须满足下面的完整约束。


用户在 IM 停止直接走 Hub 控制接口，不等待 Superagent 再推理。先停止新派发，再发送 cancel 并撤销租约；收到执行器和相关子进程停止确认才标 cancelled。失联或不能确认标 cancel_unconfirmed，不把未确认停止的任务名额立即释放给可能冲突的新任务。

租约失效后远端 adapter 阻止新受管工具/副作用并请求停止子进程。不能保证已经发出的外部写操作回滚；按操作 ID 复核。旧 epoch 的报告保留审计，但不得推进新 attempt。取消后的产物可以留档，不能偷偷成为交付依据。

Watchdog 依据 heartbeat/progress/活动，而不是只看运行时长；提醒和重试次数有上限与去重。重启重建队列、租约、未完成 effects 和未读流，首先核实 uncertain 状态。

## 8. home_hub 与跨机协议

### 8.1 权威规则

- TeamSpec、WorkflowPack 快照、WorkRun、StageRun、Assignment、消息、证据索引由 home_hub 唯一写入。
- 远端仅持该 Assignment 的受限执行授权、binding、待上报记录，不维护另一份可独立推进的团队状态。
- report、读取补充、申请授权、额度更新等操作按 authority 路由回 home_hub，并检查身份/attempt/epoch。原始账户样本来源属于其可信 execution Host，汇总准入属于配置的 budget authority。
- 断线可保存已产生结果；不能新派发或扩大任务。重连先对齐 epoch，再幂等补交记录。

### 8.2 协议协商与 v1

旧节点严格要求 Hello.version=1，因此不能直接先发 version=2。新客户端在已认证的 WS 升级请求中附带 x-kode-messaging-version: 2；服务端未收到声明则选 v1。服务端先发送旧结构 Hello 并选定版本，新客户端收到后回复相同版本（旧服务端会选择 v1）。仅双方明确确认 v2 后交换 Capabilities，完成前不发送应用帧。当前仅已实现投递观察同步能力 `delivery_observations_v1`：执行端持久事件批次、发送端原子镜像与幂等审计、持久 ack 游标。未实现的其他功能不宣称支持。能力建议拆为 `collab_commands_v1`、`collab_receipts_v1`、`quota_v1`、`model_selection_v1`、`artifact_transfer_v1`，不以单个版本号推断全部功能。

能力协商后的帧族：CollabCommand（id、authority、actor binding、operation、payload、expiry）、CollabResult、CollabEventBatch、QuotaDirectory。远端不得信任 payload 中的任意 human/role，必须由连接身份、授权引用和 assignment binding 验证。

v1 出站 DTO 明确删去 Message.envelope/read 字段、SessionInfo.collab 等所有新增字段；普通消息可附纯文本上下文。完整自动流程要求可确认创建、报告、取消及证据能力，不能把文本降级当作满足这些能力。旧节点继续普通 session 消息，不承接不具备保证的自动阶段。

传输查询分两路：待发消息索引与待同步收据/事件 outbox。不能只查 queued/received/delivering 而丢掉 accepted/rejected 等终态 receipt。重连按持久 cursor/ack 补发，不能只依赖进程内 sent map。

### 8.3 远端产物

报告中路径必须含 host 与 workspace/artifact identity。必要验收日志与小型产物由授权传输存入 home_hub 侧 artifact store，记录 hash/size/type，用户不能因远端离线而失去已完成任务的核心证据。大产物引用必须标 availability 和保留策略。严格校验路径、上限与内容类型，不执行 artifact 中的文本。

## 9. 数据表、事件与接口

### 9.1 持久化表组（建议，迁移实现前生成完整 DDL）

| 表/集合 | 主键与重要索引 | 内容 |
|---|---|---|
| superagents / team_revisions | id；(team_id, revision) | 稳定身份、不可变 TeamSpec、active revision |
| team_grants / memberships | grant_id；(team_id, principal_id) | 权限、人员/角色关联与撤销版本 |
| workflow_versions / capability_profiles | (id, version/hash) | 流程与角色资源、能力知识来源 |
| conversations / conversation_members | id；(principal_id, conversation_id) | DM/group 类型与权限，DM 绑定 Superagent |
| im_messages / read_cursors | (conversation_id, seq)；(conversation_id, principal_id) | 用户可见消息和用户已读，不混 Worker 消费状态 |
| work_runs / stage_runs | run_id；(team_id, status, created_at)；(run_id, stage_id, attempt) | 流程快照、阶段依赖与转移 |
| assignments / runtime_bindings | assignment_id；(stage_run_id, attempt)；session_id | 确定执行身份、epoch、实际模型/effort、状态 |
| internal_threads / subscriptions | thread_id；(thread_id, principal_id) | 内部协作与直通对象 |
| collab_events | (home_hub, seq)；(run_id, seq)；event_id unique | append-only 因果事件及 correlation/causation |
| command_outbox / delivery_receipts | command_id；(state, next_attempt_at) | 幂等副作用、消息与收据补发 |
| artifacts / evidence | artifact_id；(run_id, stage_run_id, snapshot_hash) | 内容哈希、位置、生产者、证据绑定 |
| account_bindings / quota_samples | binding_id；(binding_id, epoch, limit_id, window_id, model_scope) | 受信账户映射、真实额度样本 |
| reservations / resource_leases | reservation_id；account/team/resource + state | 预算、名额与独占资源预留 |

messages 增 status/created_at 等可索引列，并维护 JSON 与索引列同事务一致。每次 schema 修改独立递增 user_version；不能由额度分支和协作分支各自定义 v0→v1。所有新表有 team/authority 作用域；完整 FK/unique/check 约束与迁移清单在实施 P1 固化。

备份必须使用 SQLite backup API 或等价的一致快照（覆盖 WAL），不能直接 cp 主 db 文件。备份一次后校验；迁移在单事务中更新表、回填、索引和 user_version，失败拒绝启动，旧数据不部分修改。

### 9.2 审计规范

每条事件至少含 event_id、seq、at_ms、actor、team_id、run_id、stage/assignment/attempt、correlation_id、causation_id、配置版本、类型及 payload 引用。

事件包括：草拟/激活/变更、授权/撤销、请求接收、路由理由、quota snapshot/预留、角色分配、消息发送/接收/消费、模型生效、工具调用/结果、报告、评审、验证、返工、取消、接管、交付。不得只记录 UI 摘要。

记录可观察输入输出与决策摘要，不记录隐藏 chain-of-thought；凭证过滤，秘密不落盘。Host 普通日志不得输出带 key 的请求。账户信息和余额决策不上传中心 sync-server。

工作档案独立于短期传输 TTL；一期建议用户主动归档/删除，不默认 7 天删除完成任务证据。若未来配置保留期，删除记录标 tombstone 和缺失范围。回放只重建视图/状态，不重新执行命令。

审计写入失败时停止新的受管副作用；已经执行但记录未确认的操作进入 uncertain 并核对，不能降级为“执行成功但不留档”。执行器无法观测或约束其内部工具/子执行时，必须把 trace coverage 标为 partial，不能通过完整留档的自动团队准入。

### 9.3 API / tools（拟议）

| 接口 | 调用主体与行为 |
|---|---|
| POST /messaging/superagents/drafts；GET/PATCH /:id/draft | 已认证用户、其 Builder；乐观 revision，草案不执行 |
| POST /messaging/superagents/:id/activate | 用户确认动作；冻结配置和 grant，幂等激活 |
| GET /messaging/superagents；GET /:id | 仅用户有权限的联系人及团队状态 |
| POST /messaging/conversations/:id/messages | human 发请求；Coordinator 发可见回复；Worker 拒绝 |
| GET /messaging/conversations/:id/messages?after=&limit= | seq 分页，limit<=200；按 membership 校验 |
| GET /messaging/messages/:id/content | 取完整文本/分块；用于卡片截断续读，有字节上限及权限 |
| POST /messaging/runs；GET /runs/:id | Coordinator 启动冻结流程，用户/成员读取 |
| POST /messaging/runs/:id/cancel、/resume、/takeover | 用户控制；resume 重新校验授权/租约/证据 |
| POST /messaging/assignments/:id/reports | 已绑定 Worker；带 report id、expected revision、attempt、epoch |
| POST /messaging/assignments/:id/consumed | 已绑定受信 runtime adapter；不能由模型自报精确已读 |
| POST /messaging/runs/:id/decisions | 用户的审批/waiver；绑定精确版本，不接受引用的外部文本作为授权 |
| GET /messaging/runs/:id/events、/artifacts | 可溯源读取，按 cursor 分页 |
| GET /messaging/resources、/quota/coverage、/quota | 授权范围内目录、覆盖状态和额度投影 |
| POST /messaging/quota/samples | 可信采集器/Host；绑定来源作用域，普通 session 禁止 |

上表路径以 `/api/v1` 为前缀，Host 映射 `/api/kode/collab/*` 并持有服务端凭证。UI 不拿 admin token；不得仅依赖前端隐藏功能做权限限制。

Builder 工具：discover_workspaces/resources、inspect_workflow、draft_team、validate_draft。激活由用户的结构化动作完成。
Coordinator 工具：resources/rank、workflow_start/status、assign/reassign、internal_note、request_user_decision、publish_summary。操作都受 scope 与 grant 检查。
Worker 工具：阶段业务工具、task_report、context_read、internal_message/request_clarification；不能 publish user message 或扩大团队。
具体工具统一加 `kode_` 前缀并在实现时固定 JSON schema；旧 kode_sessions_* 保持普通 session 接口，托管身份走相同后端权限门禁。

## 10. IM 与 session 双模式

### 10.1 结构与交互约定

```text
[ IM | Session ]
创建 Superagent
────────────────────────────────────────
团队搭建助手         │ Superagent 名称 · 当前状态
项目 A 助手  需要你   │ 长期聊天 / 用户请求 / 阶段摘要 / 结果
项目 B 助手  运行中   │ [工作过程] [团队设置]（按需打开）
                     │ 输入消息、附件、停止当前工作
```

IM 只列长期联系人，不按 Host/workspace/session 分组要求用户导航。联系人排序由置顶/最近沟通、未读和待决状态决定；多个正在运行的请求在对话内有关联卡，不给每次任务创建新联系人。

主沟通内容：必要澄清、被授权工作的进度摘要、需人决定的风险、可查证交付。常规 Worker 原始日志收起；“工作过程”显示角色、阶段、通信和证据。系统控制通知署名系统，不把内部 Worker 原话伪装为用户或 Superagent。

### 10.2 模式切换

- `viewMode` 是用户界面偏好，保存 lastSuperagentId / lastSessionId / 各自草稿与滚动位置，不写任务状态。
- IM 使用独立 main panel 和联系人视图；Session 保留现有聊天与 federated workspace browser。
- 模式切换不能触发 create/start/stop/promotion，也不能改变 grant。
- 一期 session 模式可看到标注所属团队/任务的内部 session；默认只读。接管入口解释会暂停哪项工作，确认后走 takeover 控制。
- 旧普通会话不自动转为 Superagent；导入历史/创建团队是独立操作。

### 10.3 插件边界与待验证槽位

新增 `packages/collab` 与 Host 模块，使用 dsh 公开 sidebar/main/overlay 槽位。sidebar shell 自带“新建会话”且当前 Kode 已包装 workspace 槽；P5 验证可否单一 wrapper 同时切换 shell action 与内容。

若公开槽位不足，使用集中、可撤销的 adapter 或 cordis patch 替换小型 sidebar shell；保留 Session 原组件引用和 locale/store 注入。禁止多个插件各自改同一 entry.component；不手改生成的 packages/chat/client.js，不往 agent-client.js 堆 IM 实现。

视觉继续使用 dsh 现有 tokens、主题、字体、组件与键盘行为。本轮只确定功能拓扑与状态，具体视觉稿在后续获授权的 UI 阶段确认，不为本次规划修改全仓设计系统。

### 10.4 必备状态与性能

空联系人→创建入口；草案未完成→继续配置；额度未接通→修复来源；等待用户→明确决定；home_hub 离线→可读缓存与待发送状态；Worker 失败→Superagent 处理摘要；cancel_unconfirmed→明确未确认停止；产物缺失→标证据不可用，不显示验证通过。

数据增量 cursor 推送；前端 rAF/短周期合并刷新，避免逐 token 重建列表；消息分页/虚拟化；隐藏视图不高频轮询。键盘发送、焦点恢复、长中文标题、窄屏切换及无障碍状态文本纳入验收。

## 11. 实现落点与复用判断

用户要求先完善通信底层再开发 IM；执行顺序以新版 tasks.md 为准。用户已决定当前沿用现有技术栈、专注功能，TS 与移动端迁移规划均后置；以下为本期 Rust/Host 模块落点。语言边界、移动端候选与评审图见 [architecture-review.md](architecture-review.md)。

建议 Rust 模块：messaging 的 superagents.rs（身份/配置）、workflow.rs（门禁）、scheduler.rs（准入）、collab.rs（内部路由）、quota.rs、audit.rs、effects.rs；按文件规模再分目录，单文件尽量<2000 行。

建议 Host 模块：collab-api.js、collab-tools.js、superagent-runtime.js、team-builder.js、workflow-packs.js、model-selection.js、quota-collector.js、execution-adapters/*。现有 session-create、codex/acp sessions、runtime bridge 只接窄接口。

复用现有 Kode/dsh 执行器、消息、工作区、模型目录；保留 profile 扩展字段（修 agents.rs 的重建覆盖问题）。从原型借鉴事务/effect、订阅与 handback、prompt revision、消息去重、接管/停止测试；具体代码复用必须保留 MIT 归属。

不让原型 orchestrator.sqlite 和 Hub 各自推进同一个任务。其 core 接口是同步事务，Rust Hub 是异步 RPC 边界，不能拿远程 REST 简单实现 synchronous Repositories.atomic。是否独立提取某段代码需 P0 spike 证明收益；当前推荐实现 Kode 的单权威内核，复用语义/测试和可独立组件。

## 12. 方案自检与剩余验证

已解决 v1 的 Router/Worker 权限矛盾、IM 入口偏差、单角色默认模型认知偏差、明确请求被 observe 阻断、quota 任意 session 上报、account_key 与窗口混淆、消息 TTL 与档案混淆、取消与终态收据遗漏。

待验证：现有 backend 的额度来源覆盖；团队预算计量/估算与对账可行性；各 runtime 的 prompt/工具限制、停止与 consumed 能力；dsh sidebar 模式槽位；v1 双向协议 fixture；CLI effort 参数；跨机 artifact/cancel/report 的完整契约；完成状态门禁真实效果。tasks.md P0/P1 在这些未完成前不允许承诺产品已可用。
