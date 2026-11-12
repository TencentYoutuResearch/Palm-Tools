---
schema_version: 2
id: fix-mobile-tcodex-reply-sync
kind: bug
document_class: work_item
work_type: bug
title: 修复 mobile 看不到 Windows TCodex Worker 回复
status: proposed
verifies:
  - rust
paths:
  - apps/mobile/lib/src
  - apps/mobile/test
  - apps/gui/src/lib
  - crates/kode-bridge/src
  - crates/kode-core/src/session
  - crates/kode-sync-server/src
---

# 修复 mobile 看不到 Windows TCodex Worker 回复

## Motivation

mobile 向 Windows Worker 的 TCodex 会话发送消息后，Worker 已完成处理，但 mobile
的用户消息仍长期显示 `SENT`，没有 `PROCESSED` 状态，也没有展示 Worker 回复内容。
下行 command 已成功，问题位于 Worker semantic transcript -> sync-server event ->
mobile history/WebSocket -> reducer 的上行链路之一。

该问题涉及 Windows transcript 路径、TCodex session binding、server event
持久化与 mobile 展示，不能只在 mobile 端隐藏或伪造状态。

已确认的根因边界：Windows 上 `HookRelay` 是空实现，TCodex 的
`SessionStart` hook 无法回传 `transcript_path`/`session_uuid`。因此 TCodex
snapshot 的 `session_uuid` 为 null，bridge 没有启动 semantic tail；server 只
收到 `command.status`，没有 user/assistant `message`。全平台 hook relay
可用性和 Codex/TCodex binding 是本缺陷的首要修复点。

跨设备验证使用远端 Windows 非系统盘上的 debug Kode Worker。TCodex 通过
`npm i -g @tencent/tcodex --registry=https://mirrors.tencent.com/npm` 安装，
避免依赖系统盘空间或公网 npm registry。

## Scope

- 以一次真实 Windows TCodex turn 为准，分别验证：
  - TCodex rollout JSONL 中有 user/assistant message；
  - bridge semantic tail 已绑定正确 session UUID 并发出 `message`；
  - sync-server 已持久化 `message` 并发布给 mobile；
  - mobile history/WS reducer 能合并 canonical user message 和 assistant reply。
- 修复 Worker 上行链路中实际断点，并补对应层测试。
- 在 Windows 提供与 Unix UDS 等价的 hook transport，使 Codex/TCodex
  `SessionStart` 能精确绑定当前 tab、transcript path 和 session UUID。
- 保证 mobile optimistic 用户气泡在 canonical user message 到达后变为
  `PROCESSED`，Worker 回复按顺序显示。
- 断线重连后通过 history 恢复，不依赖遗漏的瞬时 WebSocket。

## Acceptance criteria

- [ ] 在 Windows TCodex 会话中由 mobile 发送一条消息后，2 秒内（正常在线且
      Worker 已输出回复）mobile 能显示 assistant 回复。
- [ ] optimistic 用户消息最终进入 `PROCESSED`，不残留长期 `SENT` 或重复气泡。
- [ ] Worker 本地 TCodex 显示的回复、server history 和 mobile 内容一致。
- [ ] desktop Monitor 打开同一会话也能看到相同历史和状态。
- [ ] 页面重新进入、WebSocket 重连和 app 从后台恢复后内容仍存在。
- [ ] Codex 非 TCodex、Codebuddy、Claude/Tclaude 和 account relay 既有行为不回退。

## Out of scope

- 改变 mobile 消息发送成功语义；`SENT` 仍只表示 command 已执行。
- 新增 TCodex 专用消息协议或绕过 existing semantic events。
- 修复无关的 Worker 离线、账号过期或 server 部署问题。
- 仅调整 UI 文案来掩盖丢失的 reply event。

## Constitution conflicts

None. 修复保持 PTY 生命周期和 SpecOps run 隔离；所有改动限定在 transcript
语义事件和现有 session sync 边界。
