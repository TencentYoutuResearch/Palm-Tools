---
schema_version: 2
id: fix-windows-terminal-link-direct-click
document_class: tasks
status: proposed
---

# Tasks

- [x] 记录 Windows 终端链接改为无修饰键单击直达的规格边界。
- [ ] 将平台链接激活规则抽成可测试的纯函数。
- [ ] 让 OSC 8、link provider 和链接点击捕获层复用同一激活规则。
- [ ] 只在链接命中时阻止选区，保留非链接点击与拖拽选择。
- [ ] 增加 Windows 单击直达和 macOS `Cmd+Click` 回归测试。
- [ ] 运行 terminal link、mouse、`svelte-check` 和 GUI 构建验证。
- [ ] 在远端 Windows 的真实 TCodex 会话中无修饰键单击 URL，并核对浏览器启动参数。
