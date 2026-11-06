# 上游原型取证与复用评估

> 核对日期：2026-11-01。仅文档/源码静态阅读；没有安装、启动、调用模型、修改用户 profile 或读取凭证。
> 固定仓库：`deepseek-ai/dsh-superagent-prototype`；commit `6337fc823ce20251c8de8085948165c81aaa701e`（2026-10-31）。公开源码下载到系统临时目录检查，不加入业务仓库。

## 1. 先纠正“官方”的含义

这是 DeepSeek Harness 团队发布的研究原型。README 明确说明它不是正式 DeepSeek 产品，公开版也不完全等同内部版本或文章描述。不能用文章里的设计意向推断源码已经实现，也不能把 npm 市场里的 Agent Teams、dsh workflow 与该原型混为一件事。

来源：[README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md)。包名 `dsh-superagent`、version `0.1.0`、`private: true`、MIT、dsh bundle 形态，见 [package.json](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/package.json)。因此不能假设有一个可直接安装的稳定官方商业插件。

## 2. 已有能力：不应重复发明或错误声称缺失

| 已核实能力 | 证据 | 对 Kode 的价值 |
|---|---|---|
| Agent 带用户逐步完成部署 | SETUP.md：单问、默认建议、计划、确认、执行 | 创建助手的访谈方法可复用，但目标需从安装单仓库服务变成团队与流程设计 |
| Router/Worker 分别配置模型和 effort | policy.ts RoleModelSchema；app/role-models.ts；app/sessions.ts ensure | 纠正 v1“没有动态模型/effort”笼统结论：已有角色级默认配置，缺少所需的按任务能力/余额动态选路 |
| 受理、授权、线程、任务、执行尝试 | core/model.ts、engine.ts、ports.ts | 成熟概念分层与测试参考 |
| 事务内记录命令，提交后执行 effects | docs/007-architecture.md、app/effects.ts、outbox.ts | 防止先外部执行后才写状态，值得保留 |
| 线程订阅、直通、未读 handback | core 中 Intake/Tickets/Assignments、inputsRead/turnEnded | 边界比简单广播完善，应复用语义和测试 |
| 停止、重试、恢复、并发和人工优先 | executor/dsh.ts、runtime-concurrency 等测试 | 复用场景，不直接宣称跨 Kode CLI 同样成立 |
| 历史记录和管理面板 | docs/005-panel.md：Trigger/Eval/Execution/Settings | 已有可溯源基础，不是完全没有留档 |
| prompt/skill 版本与 session 绑定 | app/sessions.ts promptFor/bindSkills、app/prompts.ts | 工作流/模型选择需要类似冻结与溯源 |
| 多个外部发起人及允许列表 | policy.ts；GitHub/Feishu sources | 已有多人的请求来源能力，但不是多用户 IM 账户/多团队权限产品 |
| 预算失败观察 | app/sessions.ts RetryHealth/modelRetry | 已能显示 budget retry；不等于读取全账户余额或做预算预留 |

源码主入口：[架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/007-architecture.md)、[ports](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/ports.ts)、[role-models](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/role-models.ts)、[panel](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/005-panel.md)。

## 3. 与用户目标的实质差距

### 3.1 单仓库应用组合，不是多 Superagents 产品

README 描述一个 GitHub 仓库；Runtime 注册单个 `orchestrator` 服务，创建一个 masterId、一个 Store 和固定 `/orchestrator/api/*` 路由，client 的 PANEL_ID/route storage key 也是固定的。

多个独立进程/profile 可以各跑一套，但这不是一个 IM 中创建多个团队：仍需增加 Superagent registry、动态多实例路由、统一身份、资源池、跨团队预算、公平调度和联系人 UI。不能仅“多 insert 一次插件”而声称已支持。

证据：[runtime.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/runtime.ts)、[http.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/http.ts)、[client/index.tsx](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/client/index.tsx)。

### 3.2 人机边界与权限不同

原型允许执行器通过受控 reply/outbox 回复外部渠道，管理面板可打开执行器会话。用户要求只有所属 Superagent 与人沟通，需要统一发言主体和 Worker 问题/审批上收。

源码 `Sessions.ensure` 为托管 Router/Worker 设置 `danger-full-access`，Router 工具列表仍含 bash/read/jobs 等。不能从“Router 主要做协调”推导出它已经是我们要求的只读无执行工具。

部署文档明确要求单独 profile，原因包括进程级 PATH/Git 环境改动；脚本/prepare、GitHub 账号和源配置是该应用的一部分。对本项目这是具体兼容冲突，而非泛泛安全顾虑。

证据：[sessions.ts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/sessions.ts)、[bundle presets](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/cordis.patch.yml)、[deployment](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/006-deployment.md)。

### 3.3 角色默认模型不等于能力/余额调度

eval.model 与 executor.model 是角色级配置，RoleModel 包含 provider/model/reasoningEffort；initializeRoleModel 对新会话播种且保留已有选择。Worker 还可使用具备选模型能力的 subagent 工具。因此“完全不能选模型”是错误结论。

在本次检查的 Settings/core/调度路径中未发现统一能力画像、用户钉住职责、按任务动态选择异构 CLI、全账户额度采集、跨团队预留账本。它的 budget retry 保留当前模型/重试策略，不能替代额度感知。

现有 Kode factory 的官方 loop 与 Kode CLI driver 不同；需要专门 ExecutionAdapter，不能只把 provider 字段换成某 CLI 名就认为协议、权限、停止、read ack 都兼容。

### 3.4 已有 prompt 规则，但缺所需声明式交付阶段门禁

prompts/team/delivery.md 已要求某些 UI 证据、评审与 PR 行为，不能说完全没有流程。它也带有特定团队的 GitHub 自动合并、作者归属及分支操作约定，不能整体继承成通用默认。

本产品需要：创建助手生成可版本化流程；实现→独立评审→验证由 Hub 强制依赖；每一步绑定精确产物；失败自动返工且证据失效。原型当前 Ticket/Assignment/Report 的状态机不能直接等同这些业务阶段。

### 3.5 已有留档，不等于全链路产品审计

其 Trigger/Decision/Ticket/Assignment、prompt revisions 和 outbox 很有复用价值。我们还需跨 Host 工具执行和产物、流程版本、能力与余额选择、用户 grant、多个团队间资源决策、精确阶段验证证据的统一索引和保留策略。

### 3.6 前端入口差异

原型侧栏是一个 Superagent 管理面板入口，内有 Overview/Source/Trigger/Eval/Execution/Settings；目标侧栏是一组长期 Superagent 联系人，中心是私聊。原型面板适合借鉴“先处理需要人的事项”，不能直接充当目标 IM。

## 4. 三条接入路线

| 路线 | 能得到什么 | 必须付出的代价 | 判断 |
|---|---|---|---|
| A. 原插件隔离运行，上层聚合多个 profile | 快速体验单仓库原型，不改其内核 | 每团队部署/状态库/账号/环境；缺统一预算、权限、流程、Hub authority；UI 仍需重做 | 可用于实验比较，不作为当前目标架构 |
| B. fork 并改造原型 Runtime/Engine | 复用较多 TS 代码及测试 | 多实例、异构 executor、身份/权限、流程、额度、存储权威均要改；与 Rust Hub 事务边界冲突 | 技术可行，但不是薄薄的上层插件，需评估长期 fork 成本 |
| C. Kode 为唯一权威，dsh 插件承载 IM/执行，选择性复用原型 | 符合已有 Kode 架构和用户确认的 home_hub | 新增产品对象和状态机，移植或重做部分算法，必须用上游场景做回归 | **当前建议** |

原型 core 有 Repositories/Executor/Assessor/Outbox 接口，具备提取价值；但 `Repositories.atomic<T>(fn)` 是同步事务，不能简单映射到多个异步 Rust HTTP 调用。若要原样跑 TS core，需要让它与状态库同一个事务权威内执行或重新设计 command 接口，这已经是 B 路线的重要改造。

推荐的复用清单：
- 直接沿用现有 dsh 的 agent loop、skills、会话持久化、模型目录与 UI 槽位，以及 Kode 的 CLI/SSH adapter。
- 借鉴/移植原型的订阅/handback、effects/outbox、prompt version、卡片续读、取消恢复与测试矩阵，按 MIT 保留归属。
- 不接入原型全局 PATH/Git 修改、danger-full-access 默认、固定单实例 UI 和业务特定交付 prompt。
- 可在未来授权实施后的 P0 做隔离 spike，不能在这次计划阶段安装。只有证明单权威、权限与当前 dsh 兼容后才改变路线。

## 5. dsh 与本地工作流资产

本地 `integrations/dsh/package.json` 固定 dsh `0.2.1-rc.2`；原型开发依赖是 `0.2.1-alpha.2` 系列，部署文档示例是 `0.2.1-rc.3`。版本号接近不是已验证兼容，须测试 factory、prompt/tool scope、事件和槽位。

本地 `@deepseek-ai/dsh-tool-workflow/README.md` 描述模型编写 JS、调用规则要求显式 workflow 请求；它的持久记录以顶层生命周期为主，部分 background 输出是临时数据。可以作为受控执行能力参考，不能直接当完整审计或声明式阶段门禁。

`workflow-builder:build-workflow` 已有最接近创建助手的访谈结构：项目事实→关键场景→完成证据/授权/异常→工作流约定→模板生成。当前宿主模板列出 Codex/Cursor/CodeBuddy/Knot，不能声称已有 dsh 通用部署支持。需抽取规范并新增宿主适配，不运行其生成/安装脚本。

`palm-device-toolkit:orchestrate` 的 Plan→Parallel→Integrate、工作树隔离、根因证据、集成审查和回归留档可抽象复用。它特有的 TAPD、设备、构建部署、人机刷掌、强制人工 review 不应成为所有团队默认；是否保留由创建时的项目约定决定。本轮仅阅读它作为资料，未执行编排或委派。

## 6. 额度的官方资料及限制

- [DeepSeek Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/)：提供币种及余额；需要实际账户接入，不能由模型名称推定。
- [OpenRouter limits](https://openrouter.ai/docs/api/reference/limits)：key、预算与其他限制有不同 scope，不能把某一个 key cap 当完整账号钱包。
- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)：account/rateLimits/read 与 updated，兼容单桶和多 limit_id；窗口/credits 等字段可能缺失，应按实际版本与登录方式核实。

以上官方接口证明这些渠道有可行查询路径，**不证明所有当前 Kode 执行器或购买渠道均能取得真实余额**。Claude/tclaude、codebuddy、Cursor、tcodex 及 Kimi 的实际渠道需逐项核实；本轮不读取账号配置/凭证，不凭经验补造端点。

## 7. 验证范围

已执行：读取固定 commit 的公开文档和关键源码；核对本地 package、factory、session/create/pump、sidebar 槽位与 workflow 文档；查阅三家官方额度文档。
未执行：上游安装/构建/测试、与当前 profile 组合、真实模型调用、所有账号额度查询、多个 profile 并行运行、跨机协作/取消/审计实验。
结论为有证据支持的架构评估，不是运行兼容认证；phase tasks 包含这些验证，不以文档评审替代测试。

## Provider balance connector evidence — 2026-11-02

Rechecked official sources without accessing user accounts or credentials:

- DeepSeek: https://api-docs.deepseek.com/api/get-user-balance/ — GET `/user/balance`, availability flag and separate CNY/USD balance entries. Connector preserves decimal strings and currencies.
- OpenRouter current key: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key — GET `/api/v1/key`, key cap/remaining, lifetime usage, applicable budgets, free-model request limits and expiry. Key caps are distinct from account credits. Missing fields remain unknown; partial versions do not imply full coverage.
- OpenRouter credits: https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits — GET `/api/v1/credits`, purchased credits and usage; management-key permission required. Connector is selected explicitly, never automatically escalates credentials. Difference is labelled derived, not directly reported.
- OpenRouter reset schedule: https://openrouter.ai/docs/api/api-reference/api-keys/create-keys — daily/weekly/monthly reset at UTC midnight, Monday week boundary. Key reset timestamps computed from that rule are labelled derived; free-model reset time remains unknown.

`provider-balances.js` is a Host-side, explicit-poll connector with injected authorized
transport, fixed GET endpoints, redirect rejection, bounded response reads, sanitized
error categories and bounded exponential backoff. It never reads settings or credentials.
Tests use an owned loopback HTTP server and controlled observations, not provider account
acceptance. Numeric money uses decimal strings and exact scaled subtraction. These facts
must use a separate monetary quota path: do not coerce balances into Codex percentage
windows or call them team budgets. Binding/epoch persistence, collector activation and
admission integration remain pending; task 2.9 is not complete.

## Host collection seam inspection — 2026-11-02

Read only bundled public declaration/source files for dsh-llm and dsh-deepseek-account
0.2.1-rc.2, not user settings or credential storage. LlmRuntime exposes discovery/model
resolution/streaming registration, without a generic authenticated HTTP query method.
DeepSeekAccount exposes a separate Platform-wallet getBalance API; its semantics and
account binding cannot be assumed equivalent to public `/user/balance` API credentials.
The Kode runtime therefore installs an opt-in Host collector registry accepting a trusted
provider-supplied transport. It never calls resolveToken, credential resolution, settings
export, login or provider inference for discovery. This is an integration seam, not a claim
that live provider transports have already been registered.
