---
schema_version: 2
id: fix-windows-terminal-link-direct-click
kind: bug
document_class: work_item
work_type: bugfix
title: Windows 终端链接改为单击直达
status: completed
verifies:
  - typescript
paths:
  - apps/gui/src/lib/Terminal.svelte
  - apps/gui/src/lib/terminal_links.ts
  - apps/gui/tests/terminal_links.test.ts
  - docs/UX-CONTRACT.md
  - .specops/specs/windows-session-experience.md
---

# Windows 终端链接改为单击直达

## Motivation

Windows Kode 终端中的 URL 当前需要 `Ctrl+Click` 才能打开。TCodex 输出的登录
链接、文档链接和普通 URL 通常以可点击文本呈现，额外按修饰键与桌面浏览器和
TCodex 自身的使用习惯不一致。

用户要求 Windows 上直接单击链接即可唤起系统默认浏览器，避免每次打开链接都要
先按住 `Ctrl`。

## Scope

- Windows 终端中的 HTTP、HTTPS、文件 URL 和已识别链接使用普通单击激活。
- OSC 8 超链接、xterm link provider 识别出的链接和点击选区捕获层共享同一套平台
  激活规则。
- macOS 继续使用 `Cmd+Click`，普通单击和现有文本选择行为不变。
- 只有点击命中真实链接时才消费事件；非链接点击、拖拽选区和 TCodex 安全鼠标路径
  保持现状。
- 更新链接激活的单元测试，并在远端 Windows 的真实 TCodex 会话中验证。

## Acceptance criteria

- [x] Windows 上不按任何修饰键，单击可识别的 URL 会调用现有 `open_path` 并打开
      系统默认浏览器。
- [x] OSC 8 超链接与终端文本识别链接都支持 Windows 单击直达。
- [x] 链接点击仍通过现有 URL 白名单和系统打开命令，不新增任意协议执行能力。
- [x] 非链接区域单击、拖拽选区、复制和 TCodex 会话交互不发生回归。
- [x] macOS 仍只允许 `Cmd+Click` 激活链接，普通单击不会打开浏览器。
- [x] 单元测试覆盖 Windows 无修饰键、Windows 带修饰键、macOS `Cmd+Click` 和
      非链接路径。
- [x] 远端 Windows 在真实 TCodex 会话中无修饰键单击终端 URL，系统浏览器启动参数
      与终端 URL 一致。

## Out of scope

- 改变 macOS 或 Linux 的链接点击修饰键。
- 修改 URL 正则、支持新的 URI scheme 或替换系统默认浏览器打开实现。
- 改变 TCodex 的鼠标报告过滤、Ctrl+C、会话恢复或 PTY 生命周期。
- 为链接增加额外的上下文菜单或可见操作按钮。

## Constitution conflicts

无。变更只调整 GUI 中链接点击到现有 `open_path` 命令的平台激活条件，不改变 PTY
生命周期、backend 参数或 SpecOps run 隔离。
