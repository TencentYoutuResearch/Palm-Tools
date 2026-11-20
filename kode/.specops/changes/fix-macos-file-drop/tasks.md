---
schema_version: 2
id: fix-macos-file-drop
document_class: tasks
status: proposed
---

# Tasks

- [x] 增加 macOS 平台 Tauri 配置，关闭有缺陷的原生文件 drop handler。
- [x] 统一识别 `Files` 与 `text/uri-list` 外部拖拽。
- [x] 让全局拖拽遮罩不拦截 HTML5 drop。
- [x] 保持 Windows 原生拖拽和现有远程附件上传链路不变。
- [x] 增加路径、拖拽类型和平台配置回归测试。
- [ ] macOS debug 版真实 Finder 拖拽验证。
- [ ] Windows debug 版 Explorer 拖拽回归。
