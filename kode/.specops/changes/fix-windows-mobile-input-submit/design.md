---
schema_version: 2
id: fix-windows-mobile-input-submit
kind: bug
document_class: work_item
work_type: bugfix
title: Windows 移动端提交间隔设计
status: in_progress
verifies:
  - rust
paths:
  - crates/kode-bridge/src/lib.rs
---

# Windows 移动端提交间隔设计

## Current flow

```text
mobile input
  -> sync-server command
  -> submit_text_input
  -> PTY write(body)
  -> sleep(50ms)
  -> PTY write(CR)
```

正文与 Enter 必须分两次写，否则 Ink 类 TUI 会把整段识别为 paste，只显示但不提交。

## Windows adjustment

Windows/ConPTY 对输入渲染和 TUI 状态更新的延迟高于 macOS/Linux。将 Windows 的两次
写入间隔提高到 `300ms`，给输入框足够时间消化正文后再提交 Enter。

```text
not(windows): 50ms
windows:      300ms
```

该值只影响本地 PTY 的移动端文本提交，不改变 ACP prompt，也不改变协议 acknowledgement。
macOS 继续使用原常量，因此行为和手感不变。

## Verification

- 单元测试固定 Windows 与非 Windows 的提交间隔契约。
- macOS 运行 bridge 全量测试，确认输入、同步和会话路由无回退。
- Windows 用移动端连续发送两条消息，确认分别进入 Agent 而不是拼接。

## Verification evidence

基于 `upstream/main@77f067a` 的 PR 分支：

- macOS `kode-bridge`：`225 passed`，`1 ignored`。
- macOS `kode-core`：`261 passed`，`2 ignored`。
- macOS `kode-memory`：`179 passed`。
- macOS `kode-gui` 编译检查通过。
- Windows `kode-core process::tests`：`4 passed`。
- Windows `kode-bridge mobile_text_input`：`2 passed`，其中 Windows 合同测试确认
  提交间隔为 `300ms`。

剩余人工验证：用移动端向 Windows Worker 连续发送两条消息，确认 Agent 收到两个独立
turn。
