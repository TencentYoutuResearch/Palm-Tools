---
schema_version: 2
id: fix-monitor-tcodex-model-switch
document_class: tasks
status: proposed
---

# Tasks

- [x] 在 bridge worker command allowlist 中增加 `model`。
- [x] 增加 worker-scoped backend model catalogue 读取与 Tauri IPC。
- [x] 在 Desktop Monitor 的 idle worker session 中显示模型选择器与刷新入口。
- [x] 等待精确 command receipt；失败或超时恢复原模型并显示错误。
- [x] 兼容 TCodex `Model changed to …` 成功确认。
- [x] 覆盖 TCodex 菜单、reasoning 和确认文案的单元测试。
- [x] 覆盖 desktop、sync-server 和 mobile 的模型路由与回执测试。
- [x] 分别验证 `tcodex`、`tclaude`、`codebuddy` 的模型目录与切换执行分支。
- [x] 用 `workers.monitor` scope 授权跨 Worker session list，不依赖
      shared-inventory 开关；旧绑定继续限制在自身 Worker。
- [x] 使用 debug desktop Worker 和 Android emulator 验证模型列表、切换、
      receipt、界面更新和失败提示。
