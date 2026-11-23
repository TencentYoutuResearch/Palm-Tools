---
schema_version: 2
id: fix-windows-mobile-input-submit
kind: bug
document_class: work_item
work_type: bugfix
title: 修复 Windows 移动端消息未自动提交
status: in_progress
verifies:
  - rust
paths:
  - crates/kode-bridge/src/lib.rs
  - crates/kode-bridge/src/lib_tests.rs
---

# 修复 Windows 移动端消息未自动提交

## Motivation

移动端向 Windows Worker 发送消息时，文本经常只停留在 Agent 输入框，没有触发发送。
用户随后发送第二条消息时，两条文本会拼在同一个输入框中，并可能一起提交给 Agent。

移动端 `input` 命令最终调用 `submit_text_input`。该路径为避免 Ink 把整批字节当成
paste，会先写正文，再等待 `50ms` 后单独写 Enter。Windows/ConPTY 下 TUI 消费正文的
延迟可能超过 `50ms`，导致 Enter 在输入框就绪前丢失。

## Scope

- 仅调整 Windows 下移动端文本与 Enter 之间的提交等待时间。
- macOS/Linux 保持现有 `50ms` 时序和用户体验。
- 增加平台专用时序测试，防止后续改动误伤 macOS。

## Acceptance criteria

- [ ] Windows 下连续发送两条移动端消息时，每条消息分别提交，不再拼接到同一输入框。
- [ ] 正文补齐末尾换行的现有行为保持不变。
- [ ] ACP、空输入 Enter 和 pending interaction 分支保持不变。
- [ ] macOS/Linux 提交延迟仍为 `50ms`。
- [ ] macOS 现有 bridge 回归通过。

## Out of scope

- 修改移动端 UI、命令协议、idempotency 或 sync-server 重试策略。
- 修改 Agent/TUI 的输入解析行为。
- 调整 macOS/Linux 的输入速度。

## Constitution conflicts

无。PTY 的 wait/kill 生命周期和 backend 默认参数均不变。
