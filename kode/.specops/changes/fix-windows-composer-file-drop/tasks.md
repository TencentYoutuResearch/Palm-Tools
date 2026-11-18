---
schema_version: 2
id: fix-windows-composer-file-drop
document_class: tasks
status: in_progress
---

# 任务

- [x] 在 `onMount` 开始阶段注册 Webview 与 Window 两路 Tauri 原生拖放监听。
- [x] 对两路监听可能重复投递的原生拖放事件去重。
- [x] 将本地外部拖放改为统一的会话 composer 引用插入。
- [x] 统一工作区内部拖放和外部拖放的引用文本生成。
- [x] 支持 Windows drive、UNC、verbatim 和 file URI 路径归一化。
- [x] 保持远程会话拖放上传、endpoint 匹配和防重复行为。
- [x] 补充 Windows 路径、目录、verbatim/UNC 和引用文本测试。
- [x] 运行 file-drop、workspace、remote attachment、session-input 和
      `svelte-check`。
- [x] Windows debug 真实 Explorer 拖放返回 `Copy`，并写入完整 `@path `。
