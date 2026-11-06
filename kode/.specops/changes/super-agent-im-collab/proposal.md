---
schema_version: 2
id: super-agent-im-collab
kind: feature
document_class: work_item
work_type: feature
title: IM 为入口的多个 Superagents、创建助手与可溯源自动交付流程
status: in_progress
verifies:
  - rust
  - specops
paths:
  - crates/kode-bridge/src/messaging
  - crates/kode-core/src/config.rs
  - crates/kode-core/src/session
  - crates/kode-core/src/model_discovery.rs
  - integrations/dsh/src
  - integrations/dsh/packages/collab
  - integrations/dsh/cordis.patch.yml
  - integrations/dsh/test
targets:
  - kode-bridge/messaging
  - dsh/kode-host
  - dsh/superagents-im
---

# Superagents IM 产品方案（v2）

> 2026-11-01，根据用户最新 11 点需求修订。Goal 已授权隔离实现及测试；安装、提交和发布仍未授权。
> 当前正文：[design.md](design.md)、[tasks.md](tasks.md)；取证：[upstream-assessment.md](upstream-assessment.md)。history/v1（原始验收记录，见 validation.md） 是已替代历史，不能与 v2 混用。

## Motivation

用户希望用 IM 管理工作：创建几个长期负责的 Superagents，此后只提出目标，由它们自行组织 Worker、选择模型、执行流程、处理异常并交付。用户无需管理底层会话，也无需每次重复“安排实现、评审、验证”。

### 已确认产品决定

| 用户要求 | 落点 |
|---|---|
| 1. 创建 Superagent，指定 Worker/工作区，创建 Agent 引导 | 内置“团队搭建助手”（暂名），生成可编辑的 TeamSpec 与 WorkflowPack |
| 2. IM 侧边栏只列 Superagents，长期群聊、多人 | 一期多个 Superagents、单用户私聊；身份与会话类型预留多人 |
| 3. 用户不关心会话/模型/执行器 | 长期联系人与内部运行会话分离；自动调度，技术细节收进设置与排障 |
| 4. session / IM 切换 | 两种视图共享任务事实，切换不复制、重建或终止执行 |
| 5. 一句话自动走实现→评审→验证 | 流程包+角色指令+Hub 阶段门禁，不能靠 Worker 自报完成跳过阶段 |
| 6. 模型擅长不同工作，可配置且创建助手能引导 | CapabilityProfile 有来源、时效、用户钉住项；先硬过滤再排序 |
| 7. 所有 Agent 的余额都能感知 | 全资源 coverage 清单、账户/额度桶接入及上线核验；缺失真实余额时允许用户配置并使用明确标注的“团队预算”（D1 已确认） |
| 8. 角色创建、工作、通信可溯源 | 请求→流程版本→分配→消息→工具/产物→评审→验证→交付证据链 |
| 9. 同意委派权限方案 | Router 自身权限与用户授予团队的委派能力分离，服务端检查 |
| 10. 创建频道的 Hub 管理状态 | home_hub 为唯一写入权威，远端 Worker 操作路由回来 |
| 11. 评估官方原型复用 | 固定上游 commit 核对已有能力，比较全量接入与选择性复用 |

用户给出的 ds-v4.1-flash、gpt-6-astra、gpt-6.1-sol、kimi-k3.1 能力/成本评价是初始偏好，**不是本次测评结论或硬编码名单**。必须匹配运行时实际模型 ID，不存在时不能暗中替换。

### 核心体验

1. 点击“创建 Superagent”，进入团队搭建助手。助手自身是系统内置 Superagent。
2. 助手读取用户选择的工作区，核实流程/工具/验证入口，询问职责、完成标准、资源、预算和授权边界。
3. 展示团队草案：“负责什么、在哪工作、有哪些角色、怎样验收、何时找你”。高级设置可指定执行器/模型，但不是必填步骤。
4. 用户激活后，IM 出现该 Superagent。Worker 资源池是逻辑配置，无需预先常驻全部执行会话。
5. 用户说“帮我实现这个需求”；自动进入已激活流程，按需实现、独立评审、验证与返工。
6. 只有所属 Superagent 向用户澄清、反馈风险与交付。Worker 提问和原始输出进入内部流。
7. 用户可展开“工作过程”查证据，或切到 session 模式排障。

## Scope

### S1 长期身份与团队

- Superagent 是长期联系人；TeamSpec 绑定职责、工作区、允许的 Worker 资源、流程、预算、并发和授权。
- WorkerSpec 是逻辑角色+候选执行资源；Assignment 才是一次具体派发。
- 内部模型、会话可轮换，联系人和 IM 历史稳定。多团队共用账户、工作区、设备时统一协调。

### S2 创建助手与流程包

- 对话引导，工作区能发现的事实自行核实，避免技术配置问卷。
- WorkflowPack 为声明式流程、角色提示词、skills 引用、已核实命令和完成证据的版本化组合。
- 一期随附通用需求交付/缺陷修复模板，按项目定制；长期可加调研、文档等模板。默认研发流程不是后端固定三阶段：流程结构、交付终点、代码托管与项目管理绑定均可配置。
- 抽取 palm-device 的取证、隔离、集成、评审、验证与留档方法；TAPD、M3/M4、设备部署和人工门禁仅属于项目包。
- Prompt 定义行为，plugin/skill 提供方法，Hub 强制依赖和证据。激活时确认常设方式，日常在已有授权内自动执行。

### S3 模型、能力与额度

- ExecutionTarget = Host + executor profile + provider/model + effort + account binding。
- CapabilityProfile 保存客观工具/模态能力及可编辑任务适配评价，保留来源、版本、更新时间。
- 先过滤权限、工作区、工具、模型支持、额度；再按质量门槛、成本、时延和负载排序。困难任务升级专家，验证不得因模型便宜而降低证据标准。
- 真实余额/订阅额度窗口、组织预算、本地预算分开；覆盖创建助手、Superagent、Worker 及被允许的子执行。
- 样本由受信采集器提交，普通 session 无权伪造。密钥由现有 Host/CLI 保管，不进入配置草案、审计或模型上下文。

### S4 工作流与可靠通信

- WorkRun 对应用户工作请求；StageRun 对应流程阶段；Assignment 对应执行尝试。
- 首个需求模板自动实现→独立评审→验证，失败返工；产物变化使旧证据失效。
- Hub 负责状态门禁、名额/预算预留、持久命令、远端租约和 fencing、取消与恢复。
- 用户 IM 与内部协作流分离；home_hub 是唯一权威。断线远端保存结果等待同步，不能自行完成整个 WorkRun。

### S5 IM/session 与留档

- IM 联系人只列 Superagents；主区域为长期私聊，显示必要阶段状态、结果与“需要你”。
- 技术详情按需展开，排障模式可读 Worker 会话；接管写入需暂停自动派发并留痕。
- 保存通信、分配、版本、授权、额度决策、实际工具调用和产物引用；保存可观察行为，不要求隐藏推理。
- 传输 TTL 不等于历史保留期，不能清理投递队列时删掉工作证据。

## Acceptance criteria

以下验收以当前源码和实际执行证据为准。专项结果记录在 acceptance-audit.md，PR 分支复核与适用范围见 validation.md。

1. **AC1** 创建两个 Superagents，绑定不同工作区/资源池；内部会话轮换后联系人、历史与运行状态不变；取消草稿不启动 Worker。
2. **AC2** IM 不出现 Worker/session；Worker 的问题、授权、额度错误由所属 Superagent 收口；无需选择模型即可完成团队草拟。
3. **AC3** 使用默认研发模板时，用户只输入需求，自动实现、独立评审、验证；其他已激活模板按其阶段/交付终点运行。缺少所需证据时后端拒绝 completed；产物改变后旧证据不再有效。
4. **AC4** 评审失败自动返工，重复失败按配置升级/求助；高成本模型受团队预算与授权约束。
5. **AC5** 不改源码即可修改模型职责；钉住偏好不能绕过硬过滤；每次选择理由、实际模型/effort 可追溯。
6. **AC6** 全部资源都有额度 coverage 记录，含账户绑定、来源、限制桶、时效和接入状态。真实余额缺失时可按用户录入的“团队预算”准入；计量不完整显式估算/待对账，不能冒充真实余额或无限额度。已知供应商耗尽不能被团队预算覆盖。
7. **AC7** 多团队共用预算不会重复预留；同仓库写任务隔离工作树；共享设备有锁；队列不会永久饿死某团队。
8. **AC8** 创建成功响应丢失、投递后崩溃、重复/迟到报告、远端断线可恢复，无重复派发/交付；取消区分请求与确认。
9. **AC9** 只读 Superagent 能在用户授权的 workspace-write 范围委派；越界、提权、擅自推送/部署/对外发消息被后端拒绝。
10. **AC10** 运行中切换 IM/session 不新建任务/调用、不丢草稿、不改权限、不停止 Worker，回到原联系人位置。
11. **AC11** 最终结果能定位原请求、流程/提示词/能力版本、Assignment、通信、产物、独立评审与验证；重启仍可查，已归档必要证据不依赖远端在线。
12. **AC12** 旧 session 工具行为兼容；旧库一致备份与原子迁移；v1 保留普通通信但不被当成完整协作节点；终态收据重连不丢。
13. **AC13** 模块分拆、不膨胀 agent-client.js；相关 dsh、Rust 单线程、GUI 检查及端到端目视验证通过；明确区分已执行与未验证。

## Out of scope

- Goal 已授权实现及测试；不安装到日常环境、不启动新增付费测试、不提交或发布。
- 一期不做多人登录/租户、群聊、跨 Superagent 自主群体讨论；保留数据边界，后续独立设计。
- 外部 QQ/企微/飞书入口、移动端专属 IM 界面、Legacy TUI 增强不在一期。
- 不保证任意闭源执行器/登录方式都公开真实余额；不编造接口，不抓凭证，不用消耗充作余额。
- 不保证 LLM 判断绝对正确、跨系统 exactly-once 或账户结算实时无误差。

## 决策与待决项

- **D1（已确认）** 用户允许录入预算，系统扣减并明确标成“团队预算”；供应商余额、团队预算、观测消耗分账。具体额度/周期在团队创建时配置。
- **D2** “团队搭建助手”为暂名。
- **D3** 一期建议多 Superagents+单用户+单写入 home_hub+已验证远端 Worker+两类研发流程，不宣称所有业务场景首期实现。
- **D4** 交付终点不写死。研发默认模板建议实现→独立评审→验证，团队配置完成标准、交付终点和项目工具；Hub 按已激活版本校验证据。commit/push/merge/deploy 等操作仍需相应授权。
- **D5** 推荐 Kode 承载产品、选择性复用上游算法/测试/指令；全插件接入需要隔离 spike，禁止两个状态机双写同一任务。

- **D6（已确认顺序）** 先补强现有 Agent 通信底层并以 session 工具验收，再开发 IM。具体阶段以 tasks.md 新版为准。
- **D7（已确认）** 当前专注功能，沿用现有技术栈；TS 迁移及其专项规划后置，不作为本期依赖。
- **D8（已确认）** 移动端迁移及其专项规划后置；本期不做移动端替换或迁移 spike，仅保持现有接口兼容。详见 [architecture-review.md](architecture-review.md)。

## Constitution conflicts

- Rust 测试单线程；不碰 PTY wait/kill 与高频渲染路径；CLI 默认参数不含 positional，启动行为改动补回归。
- SpecOps Run 绑定 immutable base、独立 worktree；产品 Worker 也隔离写工作区。
- 本期后端与 IM 非视觉实现已完成，PR 分支复核记录见 validation.md。
- 保留用户未提交改动；未来基线可由用户先提交，也可在明确授权下建立包含依赖的快照/worktree，不擅自 stash、回滚或代提交。
- 界面继承 dsh 槽位与设计系统；本轮只定产品结构，不确立新配色或视觉风格。
