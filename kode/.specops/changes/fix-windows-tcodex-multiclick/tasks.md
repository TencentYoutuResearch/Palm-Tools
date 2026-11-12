---
schema_version: 2
id: fix-windows-tcodex-multiclick
document_class: tasks
status: proposed
---

# 任务

- [ ] 从最新 `upstream/main` 创建独立 bug 分支。
- [x] 增加基于时间和位移的多击点击链分类。
- [x] Windows 下延迟单击重放，双击窗口内两击都不发送给 PTY。
- [x] 补充 Windows detail-reset、deferred-click、超时、位移、drag 和
      triple-click 测试。
- [ ] 运行 GUI mouse suite、`svelte-check` 和相关 session-input suite。
- [ ] 在远端 Windows 非系统盘用
      `npm i -g @tencent/tcodex --registry=https://mirrors.tencent.com/npm`
      安装 TCodex。
- [x] 在 Windows debug build 的真实 TCodex PTY 会话中连续触发 5 次双击，确认
      session 进程和 tab 均保持。
- [ ] 用户在已进入对话内容的 TCodex 会话中复验双击不退出。
- [ ] 独立创建 PR，不混入 Monitor 协议改动。
