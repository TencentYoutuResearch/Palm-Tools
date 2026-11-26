---
schema_version: 2
id: add-terminal-path-segment-navigation
kind: feature
work_type: feature
title: 终端路径支持目录分段导航与文件打开
status: completed
verifies:
  - typescript
  - rust
paths:
  - apps/gui/src/lib/Terminal.svelte
  - apps/gui/src/lib/terminal_path_links.ts
  - apps/gui/src/lib/ipc.ts
  - apps/gui/src-tauri/src/workspace.rs
  - apps/gui/src-tauri/src/lib.rs
  - apps/gui/tests/terminal_path_links.test.ts
  - docs/UX-CONTRACT.md
  - .specops/specs/windows-session-experience.md
---

# 终端路径支持目录分段导航与文件打开

## Motivation

Kode 终端会输出大量绝对路径、相对路径和 `path:line:column` 形式的代码位置。
当前整个路径被识别为一个链接，点击后只能打开最终目标，用户无法从一条长路径直接
跳到其中某一级父目录。

用户希望像文件管理器一样沿路径导航：

- 点击父目录分段时，打开该目录，并在文件管理器中选中它的下一级子目录或子文件；
- 点击最后一级文件名时，直接打开该文件；
- 如果最终目标本身是目录，则直接打开该目录。

## Scope

- 本地终端中识别出的路径拆成多个可点击的累计路径分段。
- 点击非最后一段目录时，打开该目录并高亮下一段目标。
- 点击最后一段时调用现有文件/路径打开能力；文件交给系统默认程序打开，目录直接打开。
- 支持 Unix 绝对路径、相对路径、`~/` 路径和 Windows 盘符/UNC 路径的显示分段。
- `path:line:column` 的行列号后缀不参与文件管理器目标，点击文件名仍打开原文件路径。
- 保持 URL、普通文本、拖拽选区和现有 TCodex 鼠标安全行为不变。
- 在 macOS 和远端 Windows 上验证文件管理器选中语义；Linux 提供可用降级路径。

## Acceptance criteria

- [x] 点击 `/repo/src/lib/file.ts` 中的 `/repo/src` 时，打开 `/repo/src` 并选中
      `lib`。
- [x] 点击 `/repo/src/lib/file.ts` 中的 `file.ts` 时，直接打开该文件。
- [x] 点击 Windows `F:\repo\src\main.rs` 中不同目录前缀时，Explorer 打开对应父
      目录并选中下一级目录或文件。
- [x] 点击相对路径和 `~/` 路径前，先按当前会话工作目录或用户主目录解析成绝对路径。
- [x] 点击最终目标为目录时直接打开该目录。
- [x] 行列号后缀不会传入 `open_path` 或文件管理器 reveal 目标。
- [x] URL 仍按 URL 规则整体打开，不拆成主机名或路径分段。
- [x] 非链接文本点击、拖拽选区和 TCodex 鼠标报告过滤行为不变。
- [x] 单元测试覆盖 Unix、Windows、相对路径、`~/`、行列号和多级父目录目标计算。
- [x] 远端 Windows 使用真实终端路径输出，验证父目录点击会打开 Explorer 并
      选中子项，文件名点击会启动对应文件打开程序。

## Out of scope

- 在 Kode 内嵌文件浏览器、重做 WorkspacePanel 或新增目录树 UI。
- 修改远程 Worker 文件系统协议；本次只打开 Kode 本机可访问的路径。
- 支持包含未转义空格的终端路径识别。
- 修改文件关联、默认编辑器或系统文件管理器配置。
- 改变 URL scheme 白名单、PTY 生命周期或 TCodex backend。

## Constitution conflicts

无。变更复用现有路径校验和系统打开边界，不改变 PTY ownership、backend 参数或
SpecOps run 隔离。
