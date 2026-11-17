---
schema_version: 2
id: fix-monitor-tcodex-model-switch
kind: bug
document_class: work_item
work_type: bug
title: 修复 Monitor 模式切换 Worker TCodex 模型失败
status: proposed
verifies:
  - rust
  - flutter
paths:
  - apps/gui/src
  - apps/gui/src-tauri/src/cloud_sync.rs
  - apps/mobile/lib/src
  - crates/kode-bridge/src/cloud_sync.rs
  - crates/kode-bridge/src/model_switch.rs
  - crates/kode-sync-server/src
---

# 修复 Monitor 模式切换 Worker TCodex 模型失败

## Motivation

在 Monitor 模式下，桌面端和 mobile 都应能通过中心服务控制当前 Worker 的会话
模型。当前桌面 Monitor 的 worker command allowlist 不包含 `model`，也没有
加载远端 Worker 模型目录的 IPC，因此无法像 mobile 一样切换模型。TCodex
`0.1.4` 的交互菜单还会输出 `Model changed to …` 确认文案，现有 PTY 菜单解析器
只识别旧的 `Set model to` / `Model set to`，可能把已成功的切换误报为失败。

## Scope

- Desktop Monitor 为 self-hosted Worker 会话加载 backend model catalogue。
- 会话处于 idle 且没有待处理交互时显示模型选择控件。
- 模型选择继续使用 sync-server 的 `POST /api/v1/sessions/:id/model` 命令链路，
  所有请求携带当前 `X-Kode-Worker-Id`，回执为 `executed` 后才更新界面。
- Bridge 允许 worker-scoped `model` command，并提供所选 Worker 的模型目录读取。
- TCodex PTY 模型切换兼容当前 `Model changed to …` 成功确认。
- mobile 保持现有模型选择 API，复用同一 server/bridge 执行语义。

## Acceptance criteria

- [ ] Desktop Monitor 在 idle 的 Worker TCodex 会话中能看到并可切换模型。
- [ ] 模型目录请求只读取当前选中的 Worker，不读取绑定设备或其他 Worker。
- [ ] 选择模型后必须收到原 command 的 `executed` 回执；`failed`、`expired`
      或超时必须展示错误，不能乐观显示成功。
- [ ] Mobile Monitor 对同一 Worker 的模型列表和切换继续成功，并保持 mobile
      draft 不丢失。
- [ ] Desktop 和 mobile 分别验证 `tcodex`、`tclaude`、`codebuddy` 的模型目录、
      模型切换回执和切换后模型显示。
- [ ] `codebuddy` 走其 advertised ACP model configuration；`tcodex` / `tclaude`
      走各自原生 PTY 模型命令，互不套用错误分支。
- [ ] TCodex `0.1.4` 的 `/model` 菜单、reasoning level 选择和
      `Model changed to <id>` 确认均可被解析。
- [ ] busy、starting 或存在待回答交互时，桌面模型控件不可发起切换；后端仍须
      独立执行相同保护。
- [ ] 账号中继、PTY 生命周期、session ownership 和 worker isolation 不变。
- [ ] 使用 debug desktop Worker + Android emulator 完成真实模型切换验证。

## Out of scope

- 改变 backend 的模型命名、模型可见性或租户权限。
- 为离线 Worker 排队模型切换命令。
- 在 Monitor 内替换桌面终端或暴露 Worker 本地 PTY 画面。
- 修改账号中继的模型切换能力。
- 自动解决桌面端未清空的真实草稿或未关闭的 TUI 菜单。

## Constitution conflicts

None. 命令仍由 Worker 本地 PTY/ACP owner 执行，不直接跨设备修改会话状态，
也不改变 PTY 生命周期或 backend 默认参数。
