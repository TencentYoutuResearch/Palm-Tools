---
schema_version: 2
id: fix-windows-console-flash
document_class: tasks
status: in_progress
---

# Tasks

- [x] 增加跨平台 `HideConsole` helper，并在 Windows 设置 `CREATE_NO_WINDOW`。
- [x] 为 `kode-memory` 增加不依赖 `kode-core` 的非 PTY command 构造器。
- [x] 迁移 GUI 启动、git、MCP、插件、extension backend/view、SpecOps、SSH、工作台 sidecar 创建点。
- [x] 迁移 bridge 的模型发现、inventory、ACP、SSH、messaging bootstrap 和 extension 创建点。
- [x] 迁移 core 的 Codex helper 探测和 memory git/hook 探测。
- [x] 增加 Windows `GetConsoleWindow()==0` 运行时测试，并保持 stdout/stderr 管道验证。
- [x] 审计剩余 `Command::new`，确认只保留 PTY、Unix-only 和测试路径。
- [x] 运行 macOS GUI/core/bridge/memory 编译和相关测试。
- [x] 在远端 Windows 构建当前分支并以隔离配置启动真实 GUI，程序化观察无 console host。
- [ ] 在远端 Windows 触发 MCP、模型/插件、git、SpecOps、SSH 路径，验证不闪窗。
- [x] 在远端 Windows 运行 PTY 回归测试，确认终端路径未回退。
- [x] 在 Windows 安装版环境完成冷启动人工确认，用户确认不再闪控制台。
