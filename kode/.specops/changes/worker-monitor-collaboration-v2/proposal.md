---
schema_version: 2
id: worker-monitor-collaboration-v2
kind: feature
document_class: work_item
work_type: feature
title: 完善跨设备 Worker/Monitor 协作、身份与实时会话管理
status: proposed
verifies:
  - rust
paths:
  - apps/gui/src
  - apps/gui/src-tauri/src
  - apps/mobile/lib/src
  - apps/mobile/test
  - crates/kode-bridge/src
  - crates/kode-sync-server/src
  - crates/kode-relay/src
---

# 完善跨设备 Worker/Monitor 协作、身份与实时会话管理

## Motivation

设备研发人员经常同时使用多台 PC，每台 PC 连接不同操作系统、不同 Agent 和不同
Android 设备。当前桌面端已经具备 Worker/Monitor 模式和同一 sync-server 下的
Worker 发现与只读详情能力，但跨端协作仍存在明显断点：

- Windows Worker 注册名经常统一显示为 `Kode Desktop`，无法区分多台 PC。
- Server 部署页没有清楚说明 mobile 和其他 desktop 分别应如何加入已有服务。
- 切换 Monitor 目标会清空当前打开的会话，目标列表和当前对话没有解耦。
- Desktop Monitor 能输入、中断和回答，但不能像 mobile 一样创建、删除会话。
- 会话标题不能由 desktop、mobile 和 Worker 本人一致地重命名并同步。
- Desktop Monitor 会话列表主要依赖 30 秒轮询，增删和改名不能及时到达三端。

这些能力必须继续只影响当前 sync-server 上的 Worker，不得改变账号中继、PTY
生命周期、Agent 通信和现有会话事件语义。

## Scope

- 将 Worker 身份、自动主机名和用户显示名分离：
  - `worker_id` 使用 server 签发、按 server 持久化的不可变标识。
  - `hostname` 由 Worker 自动上报，可随机器变化刷新。
  - `display_name` 可由授权用户修改，重连不会回退。
- 在 Worker 详情/设备管理页提供重命名入口；桌面仍只在按需详情中展示设备和
  inventory，不把详情变成默认一级页面。
- 在部署或连接 server 页面增加低干扰提示：
  - mobile 扫描当前 Worker 二维码绑定；
  - 另一台 desktop 使用“连接已有服务”，不要重新部署覆盖；
  - 不显示或复制 token。
- 将 `workMode`、`monitorWorkerId` 和当前打开会话拆成独立状态：
  - 切换监控目标只刷新会话列表；
  - 当前已经打开的远端会话保留其来源 Worker；
  - 只有用户点击另一 Worker 的会话时才替换当前会话视图。
- Desktop Monitor 对齐 mobile 的会话控制：
  - 创建会话；
  - 带确认删除会话；
  - 重命名会话；
  - 输入、中断、回答和 plan response 保持现有能力。
- Worker 本人、desktop Monitor 和 mobile Monitor 共用一条标题更新链路：
  - Worker 本地重命名立即更新本地状态；
  - server 更新 canonical session DTO；
  - 所有活跃客户端收到 `meta` 或完整 `session.updated` 并更新列表与详情标题。
- 增加 desktop Monitor 实时事件订阅：
  - 使用当前 Worker 的 WebSocket 事件流处理 created/updated/exited/meta；
  - 重连后做一次完整列表校准；
  - 保留低频轮询作为断线与兼容 fallback。
- mobile 仍只能作为 Monitor；保留右上角绑定设备入口、目标 Worker 持久化和
  Worker 名称标题。
- 账号系统存在时，Worker 发现和重命名受当前 server 的 tenant/ownership
  约束；无账号的现有单租户部署保持兼容。

## Acceptance criteria

- [ ] 两台 Windows desktop 在同一 server 上显示不同默认名称，至少使用
      `COMPUTERNAME`/系统 hostname 作为 `hostname`，不得都退化为
      `Kode Desktop`。
- [ ] 用户修改 `display_name` 后，连接重试、Kode 重启和 Worker 重连不会把名称
      覆盖回自动 hostname。
- [ ] Worker 详情页可重命名，重命名权限和失败状态有明确反馈；无权限或离线时
      不伪造成功。
- [ ] 部署页明确展示 mobile 绑定和其他 desktop 连接已有服务的步骤，文案不
      泄露 token。
- [ ] 从 Worker A 切换到 Worker B 时，A 的已打开会话保持可见且输入仍路由到
      A；点击 B 的会话后才切换到 B。
- [ ] 会话列表只展示当前 Monitor 目标 Worker 的会话，不混合其他 Worker。
- [ ] Desktop Monitor 可以创建、删除和重命名会话；删除需要二次确认，离线或
      执行失败时列表不乐观丢失。
- [ ] mobile、Worker 本地和其他 desktop 对同一会话的重命名能在正常在线场景
      下及时同步，不产生重复会话或标题回退。
- [ ] 任一端的创建、删除、退出和重命名事件会刷新其他在线端的列表；WebSocket
      重连后列表与服务端权威数据一致。
- [ ] mobile 仍只提供 Monitor 角色，可切换同一 server 上的不同 Worker，并在
      会话页顶部显示对应 Worker 名称。
- [ ] session/event/command 的隔离键继续包含 Worker 唯一标识，所有 worker-scoped
      REST 和 WebSocket 请求携带同一 `X-Kode-Worker-Id`。
- [ ] 账号中继现有设备、会话、通信和 palm 相关行为不受影响；没有账号的
      self-hosted sync-server 继续可用。
- [ ] 单端 UI、协议、持久化、跨 Worker 隔离和三端在线同步均有自动化测试。
- [ ] 使用两个 desktop debug 版本和一个 Android emulator 完成闭环验证。

## Delivery slices

为避免协议迁移、UI 状态和 Windows 回归互相遮挡，按以下 PR 落地：

1. `fix/desktop-monitor-open-session`：现有 PR，只负责让 desktop Monitor 打开
   worker-scoped 会话并发送基础命令。
2. SpecOps-only：本 proposal/design/tasks 和两个独立 bug change。
3. Worker identity and onboarding：`hostname`/`display_name`、重命名 API、详情入口
   和部署页提示。
4. Monitor navigation and live updates：目标/当前会话解耦、worker-scoped WebSocket
   和列表校准。
5. Monitor session controls：desktop 创建、删除、重命名，以及三端标题同步。
6. 独立 Windows bug PR：TCodex 双击不得退出会话。
7. 独立 mobile/sync bug PR：TCodex 已处理消息的回复内容必须上行并显示。

第 3 至 5 项可以在 spec 合入后并行开发；涉及同一协议的 PR 采用顺序评审或明确
stacked branch，不能把所有改动继续堆到现有 PR #36。

## Out of scope

- 自动迁移正在运行的 Agent、PTY 或完整上下文到另一台 Worker。
- 用自动上下文复制替代显式 spec、memory、handoff 或用户确认。
- 跨不同 sync-server 或不同 tenant 的 Worker 发现。
- 通用远程 shell、ADB 命令执行或任意 Worker 管理能力。
- 修改账号登录、CloudBase 设备身份或 palm 识别链路。
- 替换 xterm.js 或重新设计终端渲染器。

## Constitution conflicts

None. 本变更保持 PTY 生命周期、backend 默认参数和 SpecOps run 隔离不变。新增
会话操作继续通过现有 command/setup 边界执行，不把 Worker 数据库或工作区直接
暴露给另一个 Worker。
