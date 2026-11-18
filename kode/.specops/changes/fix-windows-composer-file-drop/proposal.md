---
schema_version: 2
id: fix-windows-composer-file-drop
kind: bug
document_class: work_item
work_type: bug
title: 修复 Windows Kode 无法把文件和目录拖入会话输入框
status: in_progress
verifies:
  - typescript
paths:
  - apps/gui/src/App.svelte
  - apps/gui/src/lib/file_drop.ts
  - apps/gui/tests/file_drop.test.ts
---

# 修复 Windows Kode 无法把文件和目录拖入会话输入框

## Motivation

Windows Kode 中，把 Explorer 文件或目录拖到当前会话输入区域时，路径不能稳定
插入。现有代码已经监听 Tauri 原生拖放，但本地路径最终直接写 PTY，绕过了
`insertWorkspaceReference` 的 transport 分流。因此 ACP/runtime 会话的可见
textarea 不会收到引用，只有 PTY 会话存在写入路径。

原生拖放监听还注册在会话恢复等可失败启动步骤之后。只要某个可选启动步骤
异常，文件拖放监听就不会安装。Windows 还会提供 drive、verbatim 和 UNC
路径，现有绝对路径识别只覆盖 POSIX 与普通 drive path。

## Scope

- 在组件挂载后尽早安装 Tauri 原生文件拖放监听，不依赖会话恢复完成。
- 本地文件与目录拖放统一走当前会话的引用插入路径。
- ACP/runtime 会话把 `@path` 插入可见 composer，并保持焦点和选区。
- PTY 会话继续保持现有行为：写入引用但不提交。
- 归一化 Windows drive、verbatim、UNC 和 file URI 路径。
- 保持远程会话外部拖放的现有 SSH 上传流程。

## Acceptance criteria

- [x] Windows Explorer 拖入本地文件时，当前 PTY 输入框插入 `@path ` 且不提交。
- [x] Windows Explorer 拖入本地目录时，同样插入目录引用且不提交。
- [x] ACP/runtime 会话的可见 textarea 收到文件或目录引用，而不是写 PTY。
- [x] `C:\...`、`\\server\share\...`、`\\?\C:\...` 和
      `\\?\UNC\server\share\...` 均被识别为可信绝对路径。
- [x] Windows `file://` URI 可还原为 drive 或 UNC 路径。
- [x] 拖放监听在启动恢复前安装，后续可选启动步骤失败不会破坏拖放。
- [x] 工作区文件树拖入会话仍保留 endpoint 匹配、相对 Git 路径和单次插入语义。
- [x] 远程会话从本机拖入文件时仍先上传，再插入远程路径。
- [x] 现有 file-drop、workspace-drag、remote-attachment 和 GUI 检查通过。

## Out of scope

- 自动发送消息或自动提交终端输入。
- 复制附件到本地工作区。
- 修改 PTY、ACP、SSH 上传协议。
- 改变 macOS 既有拖放行为。

## Constitution conflicts

None. 变更只调整本地路径格式化和会话输入路由，不改变 session ownership、
远程隔离或命令提交语义。
