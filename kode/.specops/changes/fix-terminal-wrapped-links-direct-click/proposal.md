---
schema_version: 2
id: fix-terminal-wrapped-links-direct-click
kind: bug
work_type: bugfix
title: 修复终端换行链接并统一直接点击
status: in_progress
verifies:
  - typescript
paths:
  - apps/gui/src/lib/Terminal.svelte
  - apps/gui/src/lib/terminal_links.ts
  - apps/gui/src/lib/terminal_path_links.ts
  - apps/gui/tests/terminal_links.test.ts
  - apps/gui/tests/terminal_path_links.test.ts
  - docs/UX-CONTRACT.md
  - .specops/specs/windows-session-experience.md
---

# 修复终端换行链接并统一直接点击

## Motivation

终端中的长 URL 和长文件路径在窗口宽度不足时会被 xterm 软换行成多个物理 buffer
行。现有 link provider 每次只读取一个物理行，因此无法识别跨行的完整 URL/路径，
展示换行后链接高亮和点击都会失效。

同时，Windows 已改为普通单击打开链接，macOS 仍要求 `Cmd+Click`。同一桌面产品存在
无必要的平台差异；用户希望 macOS 也统一为普通单击。`Cmd+Click` 不是功能必需，
只是沿用了终端应用的历史修饰键习惯。

## Scope

- 将相邻且 `isWrapped=true` 的物理行重建为一个逻辑行。
- URL 识别、路径识别、路径分段和点击 hit-test 都基于完整逻辑行。
- 生成的 link range 可以跨多个物理行，鼠标悬停和点击任意一行片段都能激活完整目标。
- Windows、macOS 和 Linux 的终端链接统一为普通单击打开；不要求修饰键。
- 从链接区域开始的拖拽仍用于文本选择，不因单击激活规则而丢失选择能力。
- 保留 URL 整体打开、路径父目录 reveal、文件名 open 的现有行为。
- 增加软换行、跨行路径分段、跨行点击和跨平台直接点击回归测试。

## Acceptance criteria

- [x] URL 被软换行成两行或多行后，悬停任意片段都识别为同一个完整 URL。
- [x] 普通单击换行 URL 的任意片段，只打开一次完整 URL。
- [x] 路径被软换行后，各父目录分段和最终文件名仍正确映射到物理行列。
- [x] 点击跨行父目录会执行 reveal；点击跨行文件名会打开完整路径。
- [x] 普通文本硬换行不会被错误拼接成链接。
- [x] Windows、macOS 和 Linux 都支持普通单击链接，不再要求 `Cmd+Click` 或
      `Ctrl+Click`。
- [x] 从链接文本开始的拖拽仍选择文本，不触发打开。
- [x] 非链接区域单击、终端滚动、TCodex 鼠标报告过滤和会话交互保持现状。
- [x] 单元测试覆盖 `isWrapped` 逻辑行拼接、字符到物理 cell 映射、跨行 range 和点击 hit-test。
- [x] 远端 Windows 在真实终端中验证换行 URL、路径 reveal/open 和直接点击。
- [ ] 本地 macOS 在真实终端中验证换行 URL、路径 reveal/open 和直接点击。

## Out of scope

- 修改终端列宽、自动换行策略或改变 xterm.js 渲染器。
- 支持包含未转义空格的路径。
- 修改远程 Worker 文件系统协议。
- 改变 URL scheme 白名单、路径安全校验或系统默认程序选择。
- 为链接增加悬停 tooltip、上下文菜单或新按钮。

## Constitution conflicts

无。变更只扩展 GUI 终端链接识别范围和点击规则，不改变 PTY ownership、backend
参数或 SpecOps run 隔离。
