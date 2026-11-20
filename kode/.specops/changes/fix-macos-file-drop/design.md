# Design

## 决策 1：按平台选择拖拽传输层

macOS 使用 WKWebView 原生 HTML5 drop，Windows 保留 Tauri 原生 handler：

- 新增 `tauri.macos.conf.json`，把主窗口的 `dragDropEnabled` 设为 `false`。
- 主配置继续保留 Windows 已验证的 `dragDropEnabled: true`。
- 前端 handler 不按平台复制业务逻辑，只让两种传输层产出同一组绝对路径。

这比整体升级 Tauri/Wry 风险小。当前 Wry 的 macOS 修复尚未进入本项目锁定的
兼容版本，直接升级会扩大 Tauri runtime 的回归面。

## 决策 2：HTML5 外部拖拽识别不只看 `Files`

Finder 有时只暴露 `text/uri-list`。前端使用统一的
`hasExternalFileDrag(types)` 判断，`Files` 与 `text/uri-list` 任一存在都进入
drop 路径。实际路径仍必须通过绝对路径或 `file://` 校验，普通文本不会被当作
文件。

## 决策 3：视觉遮罩不可拦截 drop

全局 `.drag-drop-overlay` 设置 `pointer-events: none`。真正的 HTML5 drop 由
`<main>` 的 capture handler 接收；终端区的局部 overlay 仍只用于阻止 xterm
消费事件。

## 风险

- macOS 平台配置使用 JSON Merge Patch，数组会整体替换，因此
  `tauri.macos.conf.json` 必须复制完整主窗口配置。增加测试比较主配置与 macOS
  配置，除 `dragDropEnabled` 外必须一致，防止未来窗口属性漂移。
- 禁用原生 handler 后，拖拽期间 Tauri 原生 `enter/over` 事件不会触发；HTML5
  `dragover/drop` 必须独立驱动遮罩和插入流程。

## Verification

- `absoluteDroppedFilePaths` 覆盖 Finder `file://`、带空格路径和多文件。
- 平台配置测试确认只有 macOS 禁用 native drop。
- macOS debug 版使用真实 Finder 拖文件到 Composer 和 Workspace 面板。
- Windows debug 版回归原生 Explorer 拖拽。
