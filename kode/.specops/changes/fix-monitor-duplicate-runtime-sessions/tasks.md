---
schema_version: 2
id: fix-monitor-duplicate-runtime-sessions
document_class: tasks
status: proposed
---

# Tasks

- [x] 实现跨平台 GUI owner PID 存活检查。
- [x] 从 cloud snapshot 中剔除死亡 owner 的 GUI runtime。
- [x] Bridge 按稳定会话身份归并 shared-runtime 投影。
- [x] 服务端防御性归并同 Worker、同 `session_uuid` 的 active 记录。
- [x] 增加 dead/live owner、重复 UUID、同名不同会话和旧 ID 历史测试。
- [x] 增加并运行 desktop Monitor 与 mobile session list 自动化回归。
- [ ] 使用 Windows debug Worker 验证重启和重连后的会话列表。
