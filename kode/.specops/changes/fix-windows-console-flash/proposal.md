---
schema_version: 2
id: fix-windows-console-flash
kind: bug
document_class: work_item
work_type: bugfix
title: 消除 Windows Kode 子进程控制台闪窗
status: in_progress
verifies:
  - rust
paths:
  - crates/kode-core/src
  - crates/kode-bridge/src
  - crates/kode-memory/src
  - apps/gui/src-tauri/src
---

# 消除 Windows Kode 子进程控制台闪窗

## Motivation

Windows 安装版 Kode 以 `windows_subsystem = "windows"` 运行，但启动和日常操作会调用
`git`、Agent CLI、`adb`、`cmd.exe`、PowerShell、SSH、SpecOps sidecar 等控制台子系统
程序。当前只有后端安装器显式设置了 `CREATE_NO_WINDOW`，其它创建点由 GUI 进程直接
`Command::new(...).spawn()/output()`。Windows 会为这些子进程分配新的可见控制台，因此
启动时会出现多个控制台窗口逐个闪现，运行过程中触发模型发现、MCP 配置或插件探测时也会
再次闪现。

该问题不改变命令输出或业务结果，但会持续打断用户，并让用户误以为后台进程异常启动。

## Scope

- 提供统一的无窗口子进程构建入口，同时覆盖 `std::process::Command` 和
  `tokio::process::Command`。
- 仅对 Windows 设置 `CREATE_NO_WINDOW`；macOS/Linux 保持现有行为。
- 将 GUI、bridge、core、memory 中所有非 PTY 的系统子进程创建点迁移到统一入口。
- 保持 stdout、stderr、stdin 管道路径、超时、kill-on-drop、环境变量和工作目录不变。
- 增加 Windows 专用运行时测试，直接验证隐藏子进程没有可用的控制台窗口。
- 在远端 Windows 主机编译并启动真实 GUI，观察启动及显式触发相关功能时不再闪窗。

## Acceptance criteria

- [x] Windows 下通过统一入口创建的 `std::process::Command` 和
  `tokio::process::Command` 均设置 `CREATE_NO_WINDOW`。
- [x] Windows 专用测试启动控制台子进程后，`GetConsoleWindow()` 返回空，stdout/stderr
  管道仍可正常读取。
- [x] 安装版 GUI 启动时不再因 MCP 配置、模型发现、memory git 同步、sidecar 探测等
  非 PTY 子进程创建而出现控制台闪窗。
- [ ] 显式触发 git、插件/模型发现、远程 SSH 和 SpecOps 后不出现控制台闪窗。
- [x] PTY 会话创建路径保持不变，Windows 终端 tab、输入输出和退出检测正常。
- [x] macOS GUI、core、bridge、memory 编译与相关测试通过，没有平台行为回归。
- [x] 远端 Windows 完成至少一次真实 GUI 启动与核心功能触发验证，并记录构建身份、
  验证时间和结果。

## Out of scope

- 隐藏用户主动打开的终端、开发命令行或 `run-windows.cmd` 的构建控制台。
- 修改 PTY/ConPTY 的窗口策略、终端渲染、安装器 UI 或 UAC 提示。
- 改变子进程命令、参数、业务超时、产物或 Agent 行为。
- 处理第三方程序自身另外创建的新窗口。

## Constitution conflicts

无。PTY 子进程继续使用 `portable-pty` 的独立生命周期和 kill handle，本变更不触碰
PTY 生命周期 invariant，也不耦合 GUI 终端与 SpecOps 控制台渲染。
