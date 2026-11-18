---
schema_version: 2
id: fix-macos-ime-output-gating
document_class: tasks
status: proposed
---

# Tasks

- [x] 将 PTY output gating 限定为 Windows。
- [x] 仅在 Windows 注册 composition start/end listeners。
- [x] 增加平台边界回归测试，证明非 Windows 不进入 IME output gate。
- [x] 保留 Windows 缓冲上限、按序回放和 dispose 清理测试。
- [ ] 在 macOS debug app 中复现连续输入与流式输出并目视确认无需刷新。
- [ ] 在 Windows 上复测 IME 候选框不再因 PTY 重绘跳动。
