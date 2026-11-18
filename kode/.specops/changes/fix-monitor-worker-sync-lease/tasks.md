---
schema_version: 2
id: fix-monitor-worker-sync-lease
document_class: tasks
status: proposed
---

# Tasks

- [x] 为授权通过的 Monitor list 请求建立目标 Worker 同步 lease。
- [x] 在目标 Worker 在线时推送 `binding.changed(sync_enabled=true)`。
- [x] 在 Worker heartbeat 时关闭已过期的 lease。
- [x] 覆盖 desktop、mobile 和无 monitor scope 的测试。
- [x] 在 devcloud + GavinComp-Win + Android 模拟器完成线上回归。
