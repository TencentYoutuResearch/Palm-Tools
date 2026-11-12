---
schema_version: 2
id: fix-mobile-tcodex-reply-sync
document_class: tasks
status: proposed
---

# 任务

- [ ] 从最新 `upstream/main` 创建独立 bug 分支。
- [ ] 在远端 Windows 非系统盘安装 `@tencent/tcodex`，确认 `tcodex --version`
      和 PowerShell/PTY 命令解析可用。
- [ ] 在 Windows TCodex Worker 上复现并记录 session UUID、transcript path、
      cloud id、history 和 mobile WS 事件。
- [ ] 判定断点在 transcript binding、semantic parser、cloud upload、server
      persistence 或 mobile reducer。
- [ ] 在 Windows 实现实例隔离的 named-pipe HookRelay。
- [ ] 在 `kode-memory codex-hook` 增加 Windows named-pipe writer，并保持 relay
      不可用时静默 no-op。
- [ ] 增加 SessionStart -> `session_uuid_mapped` -> semantic tail 的 Windows
      回归测试或可由 Windows CI 编译/执行的等价测试。
- [ ] 在根因层做最小修复，并补 Windows TCodex regression test。
- [ ] 补 mobile optimistic -> processed 和 assistant reply 展示测试。
- [ ] 用远端 Windows debug Worker、sync-server 和 Android emulator 做端到端
      验证，确认 Worker 已完成 turn 后 mobile 出现 reply。
- [ ] 回归 desktop Monitor 和其他 backend 的 history/command 行为。
- [ ] 独立创建 PR，不混入 Worker/Monitor UI 或 Windows 双击修复。
