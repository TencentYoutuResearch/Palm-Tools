---
schema_version: 2
id: fix-desktop-monitor-composer-files
kind: bug
document_class: work_item
work_type: bug
title: 完善 Desktop Monitor Composer 换行、提交和附件
status: proposed
verifies:
  - rust
  - svelte
paths:
  - apps/gui/src/lib/DeviceSession.svelte
  - apps/gui/src/lib/monitor_attachments.ts
  - apps/gui/src-tauri/src/cloud_sync.rs
  - crates/kode-bridge/src/cloud_sync.rs
---

# 完善 Desktop Monitor Composer 换行、提交和附件

## Motivation

Desktop Monitor 的 Composer 目前只能用 Shift+Enter 换行，Alt+Enter 会被当成发送；
远端消息提交没有遵循 mobile 的末尾 LF 约定；也没有与 mobile 对齐的文件上传能力。

## Scope

- Alt+Enter 在当前光标位置插入换行，光标移动到新行。
- Monitor 文本消息按 mobile 协议规范化，并在发送前补齐末尾 LF。
- 为 self-hosted Worker 增加文件选择、分块上传、附件 chip 和移除操作。
- 上传复用 `/api/v1/attachments`、目标 Worker header 和 `Attached file:` 引用格式。

## Acceptance criteria

- [x] Alt+Enter 在 Composer 中插入换行而不会发送。
- [x] 内部换行保留，提交文本以单个 LF 结尾。
- [x] Monitor 可通过附件按钮选择一个或多个文件。
- [x] 附件通过当前 Worker 上传，并显示上传/失败状态。
- [x] 发送时附件路径以 mobile 兼容格式追加到消息正文。
- [x] 单条消息最多 6 个附件，上传完成前不能发送。
