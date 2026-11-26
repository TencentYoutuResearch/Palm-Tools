---
schema_version: 2
id: add-terminal-path-segment-navigation
document_class: tasks
status: completed
---

# Tasks

- [x] 记录父目录 reveal、文件名打开和系统文件管理器选中语义。
- [x] 实现路径累计分段解析器，覆盖 Unix、Windows、UNC、相对路径和 `~/`。
- [x] 为每个路径分段生成独立 xterm link range，并保持 CJK cell 映射正确。
- [x] 目录分段调用新的 reveal IPC，最后一段继续调用 `open_path`。
- [x] 在 Rust 侧实现 macOS/Windows reveal，并为 Linux 提供可用降级。
- [x] 补充路径分段、相对路径解析、行列号和 URL 不拆分测试。
- [x] 运行 terminal link、mouse、`svelte-check`、GUI 和 Rust 检查。
- [x] 在远端 Windows 真实终端中验证 Explorer 选中子项与文件打开。
