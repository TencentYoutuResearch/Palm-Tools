---
schema_version: 2
id: fix-desktop-monitor-composer-files
document_class: tasks
status: proposed
---

# Tasks

- [x] Alt+Enter 插入换行并保持光标位置。
- [x] 文本消息规范化为 mobile 兼容的末尾 LF 格式。
- [x] Bridge 和 Tauri IPC 支持当前 Worker 的分块附件上传。
- [x] Monitor Composer 增加附件选择、状态、移除和最大数量限制。
- [x] 发送时追加 `Attached file:` 引用。
- [x] 后续行 URL 可点击，Windows 调用系统浏览器。
- [x] 增加使用原始文本的整条消息复制。
- [x] 使用两个隔离 Mac debug Worker 实测换行、直执行、模型切换、Codebuddy 和附件。
- [ ] 使用 Windows debug 客户端实测系统浏览器打开 URL；当前仅完成 Windows 命令选择单测。
