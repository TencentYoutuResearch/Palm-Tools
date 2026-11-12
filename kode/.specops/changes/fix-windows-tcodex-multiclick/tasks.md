---
schema_version: 2
id: fix-windows-tcodex-multiclick
document_class: tasks
status: proposed
---

# 任务

- [ ] 从最新 `upstream/main` 创建独立 bug 分支。
- [ ] 增加基于时间和位移的多击点击链分类。
- [ ] 补充 Windows detail-reset、超时、位移、drag 和 triple-click 测试。
- [ ] 运行 GUI mouse suite、`svelte-check` 和相关 session-input suite。
- [ ] 在远端 Windows 非系统盘用
      `npm i -g @tencent/tcodex --registry=https://mirrors.tencent.com/npm`
      安装 TCodex。
- [ ] 在 Windows debug build 的真实 TCodex 会话中人工双击，确认进程、turn 和
      tab 均不退出。
- [ ] 独立创建 PR，不混入 Monitor 协议改动。
