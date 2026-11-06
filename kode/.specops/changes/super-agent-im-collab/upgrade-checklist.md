# Kode + dsh 协作升级核对表

这是维护者的兼容性核对表，不是安装或发布授权。当前 Goal 不执行日常环境安装、用户服务重启、提交或发布。

## 上游依赖与执行入口

- 固定并核对 dsh base/web-app、官方 AgentLoop、LLM、Session、持久化、Tools、SystemPrompt 和 UI renderer 的实际依赖实例。原生插件必须使用兼容的 Node ABI。
- 保留官方执行器到受管 Kode 执行器的切换逻辑；不支持模型选择的原执行器不能直接调用不存在的 selectModel。
- 保持 prepared-call 的真实 adapter registration、config、dispose、单次调用身份及模型／effort 检查；不能退回绕过预算的原始模型入口。
- 核对 Tools public pipeline、串行 scheduler symbol、执行前授权与审计持久化；受管 Worker 不能通过原 session/subagent 工具绕开控制。
- 核对消费确认和 Session 持久化事件；实际不可变 mandate 与准备送入模型的输入必须一致。
- SystemPrompt section 的装配结果必须包含完整受信 Builder／Coordinator 过程。版本号字符串本身不证明完整提示词已生效。

## 状态、传输和数据库

- Home 单写权威、稳定团队／会话绑定、revision／attempt／epoch 和命令收据契约不能变化后仍沿用旧成功判断。
- 迁移须有一致备份、事务和旧库保留测试。迁移失败不能留下半升级库；不能直接对用户数据库试验。
- schema29 将命名资源从实验 v28 的 Host 范围收紧为 Home 全局范围。v28 仍有命名占用时升级拒绝；先通过原执行端确认停止并释放，禁止删除占用行强制升级。非空资源准入必须携带 `exclusive_resource_scope:"home"`，升级后核对 Host 与 Home 都执行此契约。
- 验证旧记录缺省字段、普通 session 行为、v1 普通通信以及未协商完整协作能力时的拒绝行为。
- 新 Host 与 Home 需使用匹配契约。可选字段兼容旧存储记录不等于旧 deny-unknown-fields 服务接受新请求；不匹配必须明确失败，不能丢弃审计来继续副作用。
- 重新验证投递后崩溃、丢失创建／确认响应、迟到报告、重连终态收据和远端取消。恢复只补传原记录，不能重新执行模型或工具。
- 保持原命令收据的 append-only／negative-proof 语义；将来删除历史须保留等价 tombstone，不能让旧请求重新变成可执行。

## 创建助手的项目检查

- 核对 Builder v9 提示词与 Host/Home 相同的项目路径选择集合，每次最多八个位置。
- 检查随包 native server 的 `--inspect-project` 模式，验证所选目录身份、逐层链接拒绝、硬链接拒绝、文件／目录／返回量边界和超时。
- 确认 Home 能解析 `directory_scanned`、`directory_partial`，并保护未选择的观察记录。完整扫描与目录缺失可更新当前清单，部分扫描保留先前记录，历史收据继续可查。
- 缺少匹配 helper 时，嵌套读取须明确失败。根文档兼容路径标记覆盖缺口，身份校验失败继续拒绝。

## IM 和原生 Session

- sidebar/main/new action 的单一组件 owner、SlotRegistry/theme 注入与卸载恢复仍兼容；不手改上游生成聊天文件。
- 使用实际完整 desktop profile 验证 native Session 编辑器、草稿、同一 Session 身份及联系人导航，不以 placeholder shell 代替。
- 运行 Worker 时切换 IM／Session，不增加任务或调用，不改授权、不终止执行，回到原联系人位置。
- 更换 Coordinator Session 时，验证精确前任控制权、停止／结算证明及原输入消费记录；原始需求不重放。新会话回复接管任务须消费自己的 Hub 工作通知。两个联系人的身份、历史、工作区和资源池关联不能串线。
- 核对 taking_over／paused 与 Assignment interrupted 状态、真实停止／结算和资源释放证据。恢复原任务时保留历史 attempts，重新核验所有阶段。交付检查须正确识别已结算的历史中断分配。
- 验证接管与恢复的精确原请求收据、较新版本的缺席证明、Home／Chrome 重启恢复和当前冻结授权撤销后的拒绝。内部会话诊断保持 owner-only，并明确区分已留存元数据与运行端存活探测。
- 验证窄屏、中文、键盘、离线／取消未确认／证据缺失与分页。媒体模拟没有改变实际主题时不能宣称暗色主题通过。
- IM 流保留 owner 身份、已接受 cursor、隐藏页取消和重连边界；消息按帧通知，虚拟化需保留稳定消息身份、测量缓存、草稿和阅读锚点。接收消息不等于已读，阅读确认仍依实际呈现的连续消息前缀。运行变高长历史、突发消息及重挂载的真实浏览器用例。
- 追溯检索、实际浏览器下载、分段数量、缺失标注及远端离线时的必要 Home 归档均需核对；不通过回放重新执行动作。

## 升级后的必要检查

使用当前包定义的完整 dsh 测试入口、受影响 Rust 单线程测试和项目 `./run.sh check`，并保留日志、源码哈希、终态、跳过项原因及实际端到端证据。核对共享账户／共享预算／同时专家升级的压力场景；独立的单团队测试不替代组合验收。

涉及供应商、认证 CLI、日常安装、服务重启或付费推理的检查，先区分既有授权与尚未授权事项。未经执行的检查保持未验证，不以文档核对或元数据查询冒充运行结果。

升级受管 Codex 引擎或其供应商协议时，应重新验证完整计量 codec、可选详情容器的缺省语义、native late/invalid/missing 用量和单次事件结算。请求模型、供应商返回名和实际模型验证状态需保持区分。原生客户端提前断开时，验证同一上游有界排空到真实 EOF、坏尾帧／超时拒绝、stdout 排空与进程停止、第二请求不转发，以及 Home 重启后预算预留和唯一结算不变；仅看见完成事件不足以证明收据完整。

## 工作流指令资源与只读 Session

- 核对 execution.dependencies 的精确版本引用、v7 哈希格式与旧空字段哈希兼容。Home 与 Host 都需保留完整资源和来源。
- 验证 owner-only 资源登记、选定 Host 的 Builder 目录、预检的版本／哈希／权限拒绝，以及激活前资源展示。
- 验证每个 Worker 只收到所属阶段的冻结指令，模型准入要求精确 manifest，Home 重启后仍可追溯。
- dsh0.2.1-rc.2 的冷历史 promotion、Gateway resolveReceiverContext／resolveParameter 是只读适配接缝。升级时运行实际 desktop 历史查看与公开写入拒绝测试，核对 Agent 激活状态、事件数量与推理调用数。
- 同时核对普通 Session 的原有解析、编辑器、草稿和 IM 切换。

## 当前版本的接缝验证记录

`evidence/terminal-stream-20261105/aggregate-upstream-drain-final.log` 对应冻结的 797 文件源码，1176 项中 1169 通过、0 失败、7 明确跳过。以下是本次已执行接缝的入口，不代表未来升级后免于回归：

| 接缝 | 当前实际测试与检查范围 |
|---|---|
| Factory / 模型选择 / 卸载恢复 | `native-factory.test.js` 验证 blank official session 的受限 promotion、普通第三方会话保留和卸载恢复；`session-create.test.js` 验证失败半成品重用，不重复创建。 |
| Prompt / Tools | `prompt-provenance.test.js` 校验有效完整受信过程与冻结 mandate 哈希；`official-loop.test.js` 使用实际官方工具前后置链，检查拒绝、持久化与不确定结果；`workflow-dependencies-native.test.js` 检查每个 Worker 只消费所属阶段的冻结依赖。 |
| 消费确认 | `native-factory.test.js` 经 STDIO、Hub、native driver 验证真实输入事件消费与重启幂等；`coordinator-inbox.test.js` 对不可读历史、持久化失败保持未知，不能伪造 consumed。 |
| sidebar / main / 导航 | `collab-client.test.js` 检查单一 slot owner 与卸载恢复；`desktop-collab-shell.test.js` 使用完整桌面验证两类草稿、Session 身份和团队权限；`desktop-collab-pipeline.test.js` 验证运行中 Worker 切换时不停止、不重复启动。 |
| 上游 SSE 与计量 | `codex-response-drain.test.js`、`codex-model-gate.test.js`、`codex-native-terminal.test.js` 检查同一响应真实 EOF、提前关闭、异常尾帧、超时及唯一请求；`assignment-provider-usage-fallback.test.js` 经真实隔离 Home 检查唯一用量、预算门禁和重启后的账本。 |

真实供应商整链、可选 CLI 跳过项和未完成的界面验收，以 [验证说明](validation.md) 为准。此表是检查证据索引，未安装或修改用户日常环境。
