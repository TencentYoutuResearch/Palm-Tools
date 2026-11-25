---
schema_version: 2
id: fix-terminal-wrapped-links-direct-click
document_class: tasks
status: proposed
---

# Tasks

- [x] 记录物理行软换行导致链接失效的根因和跨平台直接点击规格。
- [ ] 实现基于 `isWrapped` 的逻辑行重建和字符到物理 cell 映射。
- [ ] 让 link provider 返回跨物理行的 URL/路径 range。
- [ ] 让点击 hit-test 基于逻辑行定位完整链接目标。
- [ ] 将链接激活统一为所有桌面平台的普通单击。
- [ ] 保留链接区域内起手的拖拽文本选择。
- [ ] 增加软换行、硬换行、CJK、路径分段和跨平台直接点击测试。
- [ ] 运行 terminal link、mouse、`svelte-check` 和 GUI 构建。
- [ ] 在远端 Windows 与本地 macOS 真实终端中验证换行 URL 和路径点击。
