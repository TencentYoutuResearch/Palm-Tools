---
schema_version: 2
id: fix-windows-mobile-input-submit
document_class: tasks
status: in_progress
---

# Tasks

- [ ] 将移动端 PTY 文本提交等待按平台拆分，Windows 使用更长间隔。
- [ ] 保持 macOS/Linux 原有 `50ms` 延迟。
- [ ] 增加 Windows 与非 Windows 的时序契约测试。
- [ ] 运行 macOS bridge 回归。
- [ ] 在 Windows 连续发送两条移动端消息验证不再拼接。
