---
schema_version: 2
id: fix-windows-tcodex-multiclick
document_class: tasks
status: in_progress
---

# 任务

- [x] 按用户要求使用 `feat/worker-monitor-validation` 验证分支，不另建并行分支。
- [x] 增加基于时间和位移的多击点击链分类。
- [x] 将第一击转发延迟到多击判定窗口结束，并在第二击到达时取消。
- [x] 补充 Windows detail-reset、延迟单击、超时、位移、drag 和 triple-click 测试。
- [x] 为 TCodex 关闭单击向 TUI 的转发，仅保留本地选择能力。
- [x] 在 TCodex 正常退出时保留 tab 并增加恢复确认。
- [x] 补充 safe-mouse、退出恢复判定和恢复操作回归测试。
- [x] 在 PTY 写入前过滤 TCodex 的 SGR、urxvt 和 X10 mouse reports。
- [x] 每次鼠标事件动态读取当前 backend，避免初始化时序绕过保护。
- [x] 在 TCodex 终端内吞掉原生 click/dblclick，并补充混合输入测试。
- [x] 将 mouse-report 过滤、safe-mouse 和退出恢复限制到 Windows。
- [x] 补充 macOS/非 Windows 路径不启用安全模式的回归测试。
- [x] 在 Windows TCodex 输出中过滤 xterm 鼠标模式激活序列。
- [x] 覆盖分包 DECSET、混合私有模式和普通终端输出测试。
- [x] 增加 Windows/TCodex PTY 输入与退出码审计。
- [x] 在 TCodex 空闲时拦截第一个 Ctrl+C 并要求确认。
- [x] 覆盖首次 PTY 回放与实时输出共用 mouse-mode gate。
- [x] 运行 GUI mouse suite、`svelte-check` 和相关 session-input suite。
- [x] 在远端 Windows 非系统盘用
      `npm i -g @tencent/tcodex --registry=https://mirrors.tencent.com/npm`
      安装 TCodex。
- [x] 在 Windows debug build 的真实 TCodex 会话中自动验证空闲 Ctrl+C 被拦截、
      进程保持运行，并连续点击 70 次后 tab 与进程仍保持运行。
- [x] Windows Ctrl+C 始终由剪贴板层消费，不再发送 ETX 或触发关闭会话。
- [x] 在已安装版本中验证选区 Ctrl+C 写入剪贴板、会话保持运行且审计无 `03`。
- [ ] 独立创建 PR，不混入 Monitor 协议改动。
