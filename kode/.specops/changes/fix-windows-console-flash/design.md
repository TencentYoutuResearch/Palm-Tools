---
schema_version: 2
id: fix-windows-console-flash
kind: bug
document_class: work_item
work_type: bugfix
title: Windows 非 PTY 子进程无窗口创建设计
status: in_progress
verifies:
  - rust
paths:
  - crates/kode-core/src/process.rs
  - crates/kode-memory/src/process.rs
  - crates/kode-bridge/src
  - apps/gui/src-tauri/src
---

# Windows 非 PTY 子进程无窗口创建设计

## Root cause

安装版 `kode-gui.exe` 是 Windows GUI 子系统程序，自身没有控制台。它启动的控制台子系统
子进程默认会请求新的 console host。以下路径均会出现闪窗：

- 启动阶段的 shared memory MCP CLI 配置和 hook 探测；
- memory git sync 与 GUI 中各类 git 探测；
- Agent 模型发现、Worker inventory、ADB 版本/设备探测；
- 插件扫描、extension backend/view、SpecOps sidecar、SSH tunnel、远程部署和附件上传；
- ACP/Codex helper 探测、messaging bootstrap 和工作台后台服务启动。

现有 `backend_install.rs` 已单独对 PowerShell 使用 `CREATE_NO_WINDOW`，说明机制有效，
但策略没有跨模块统一，其它创建点仍遗漏。

## Design

在 `kode-core` 增加 `HideConsole` 扩展 trait：

```text
Command::new(program).hide_console().args(args)
```

- Windows：设置 `CREATE_NO_WINDOW = 0x0800_0000`；
- macOS/Linux：原样返回 command；
- 同时实现 `std::process::Command` 与 `tokio::process::Command`。

`kode-memory` 被 `kode-core` 依赖，不能反向依赖该 trait，因此使用 crate 内的同名私有
构造器实现同一 Windows 标志。该构造器只用于非 PTY 的外部命令。

PTY 创建仍走 `kode_core::pty::PtyHost` 和 `portable_pty::CommandBuilder`，不使用该 trait；
ConPTY 继续负责终端子进程及其控制台语义。

## Process boundary

只标记 Kode 主动拉起的非 PTY helper / probe / sidecar。命令的标准流配置保持不变：

```text
GUI / bridge / core / memory
  -> HideConsole command
  -> CREATE_NO_WINDOW on Windows
  -> original args + env + cwd + stdin/stdout/stderr + timeout
```

不设置 `DETACHED_PROCESS`，避免改变进程生命周期、作业对象和标准句柄行为。

## Verification

静态检查：

- 审计生产代码中的 `Command::new`，仅允许 PTY builder、Unix-only 路径和测试代码例外。
- macOS 执行 GUI、core、bridge、memory 编译；执行 memory 与 process helper 测试。

Windows 运行时检查：

- 增加 `#[cfg(windows)]` 测试，用隐藏的 PowerShell 子进程调用 Win32
  `GetConsoleWindow()`，断言返回零；同一进程继续输出可读文本，证明管道未被隐藏策略破坏。
- 在远端 Windows 主机构建当前分支，启动 `kode-gui.exe`。
- 冷启动至少重复三次，观察启动阶段无控制台闪窗。
- 分别触发 MCP 配置、模型/插件探测、git 操作、SpecOps 和 SSH 路径，确认不新增闪窗。
- 打开一个 PTY 会话，确认终端仍可交互，说明未误伤 ConPTY 路径。

## Rollback

删除迁移调用并移除 trait 即恢复旧行为；没有数据格式、协议或持久化变化。

## Verification evidence

远端 Windows Server 2025 主机 `21.130.222.251`，验证于
`2026-11-20 11:49-11:57 Asia/Shanghai`：

- Windows `cargo test -p kode-core process::tests -- --test-threads=1`：
  `4 passed`，其中 std/tokio 子进程均证明 `GetConsoleWindow()==0`。
- Windows `cargo test -p kode-core pty::tests -- --test-threads=1`：
  `7 passed`，PTY 路径未回退。
- Windows `cargo check -p kode-gui`、`pnpm tauri build --no-bundle` 成功。
- 测试产物目录 `F:\kode-artifacts\windows-console-flash-20261120`：
  `kode-gui.exe` SHA-256
  `bd063de34a3c37f7eb5561b2c4df0718fba328bdbb5c750d49e00b97c79b24f4`，
  NSIS 安装包 SHA-256
  `bb9c9460f314d6379a51d23c0ec6cccc75ca64e37acebf2611dc320b63c182f3`。
- 用隔离配置启动该真实 GUI 二进制并持续观察 25 秒，进程保持存活，
  `Win32_ProcessStartTrace` 中后代 `conhost.exe` / `OpenConsole.exe` /
  `WindowsTerminal.exe` 数量为 `0`。
- 用户于 `2026-11-23` 在 Windows 安装该构建后确认启动时不再出现控制台闪窗。

远端自动观察受当时 C: 可用空间为 0 和交互 session 限制，未录屏；用户随后在真实
Windows 安装环境确认了冷启动不闪窗。
