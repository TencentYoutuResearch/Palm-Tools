---
schema_version: 2
id: fix-macos-file-drop
kind: bug
document_class: work_item
work_type: bugfix
title: 修复 macOS 外部文件拖拽被原生 handler 吞掉
status: proposed
verifies:
  - rust
  - svelte
paths:
  - apps/gui/src/App.svelte
  - apps/gui/src/lib/file_drop.ts
  - apps/gui/tests/file_drop.test.ts
  - apps/gui/src-tauri/tauri.macos.conf.json
---

# 修复 macOS 外部文件拖拽被原生 handler 吞掉

## Motivation

Windows 文件拖拽修复启用了 Tauri/Wry 原生 drop handler，但 macOS 随后的
Finder 拖拽回归。macOS 当前 Wry `0.55.1` 的原生 handler 仍从旧
`NSFilenamesPboardType` 读取路径；部分 Finder/文件选择器只发布
`public.file-url`，路径读取失败后原生 handler 仍会消费拖拽，前端收不到可用的
drop 事件。同时，全窗口拖拽遮罩没有显式禁用 pointer events，可能成为 HTML5
drop 的实际落点，进一步造成“松手后无反应”。

Windows 的原生拖拽链路已经验证可用，不能为了 macOS 将它回退。

## Scope

- macOS 关闭 Tauri 原生文件 drop handler，恢复 WKWebView 的标准 HTML5
  `dataTransfer` 路径。
- Windows 继续使用已验证的原生 `onDragDropEvent`。
- 前端统一接受 `Files` 与 `text/uri-list` 两类外部拖拽载荷。
- 拖拽提示遮罩只负责视觉提示，不拦截 HTML5 drop。
- 继续复用现有绝对路径校验、去重、远程附件上传和 `@path` 插入逻辑。
- 增加平台配置一致性和 macOS file URL 回归测试。

## Acceptance criteria

- [ ] macOS 从 Finder 拖入带空格路径的文件时，活动会话 composer 插入且仅插入
      一次 `@/absolute/path `，不会自动提交。
- [ ] macOS 拖入文件夹、多个文件或 `file://` URI 时使用绝对路径，不退化为
      basename。
- [ ] macOS Workspace 文件面板仍能接收外部文件 drop，而不是错误插入会话。
- [ ] macOS 拖拽取消或离开窗口后遮罩消失，不遗留 pointer blocker。
- [ ] Windows 原生文件拖拽行为保持不变。
- [ ] 拖入相同文件时不会因 Webview/Window 双监听或 HTML5 fallback 重复插入。
- [ ] macOS 不需要刷新窗口即可继续拖拽。

## Out of scope

- 全局升级 Tauri/Wry 或改写第三方原生拖拽实现。
- 修改远程附件上传协议。
- 新增从浏览器拖入 URL/富文本的行为。
- 改变 Windows 已验证的 ConPTY、IME 或终端鼠标处理。

## Constitution conflicts

无。本变更不涉及 PTY 生命周期、backend 默认参数或 SpecOps Run 隔离。
