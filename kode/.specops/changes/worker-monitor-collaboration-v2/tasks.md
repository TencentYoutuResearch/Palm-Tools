---
schema_version: 2
id: worker-monitor-collaboration-v2
document_class: tasks
status: proposed
---

# 任务

- [ ] 在最新 `upstream/main` 上创建 spec-only PR，保留本 proposal/design/tasks。
- [ ] 先合入现有 `fix/desktop-monitor-open-session` PR，后续实现从新 main 拉分支。
- [ ] 实现 Worker hostname 自动上报和 `display_name` 持久化迁移。
- [ ] 实现 Worker 重命名 API、授权、详情页入口和错误状态。
- [ ] 补充部署页的 mobile 绑定与 desktop 连接已有服务提示。
- [ ] 将 work mode、Monitor 目标和当前打开会话解耦，确保来源 Worker 不漂移。
- [ ] 增加 desktop worker-scoped WebSocket 订阅、重连校准和迟到事件隔离。
- [ ] 实现 desktop Monitor 创建会话，复用现有 worker-scoped catalogues。
- [ ] 实现 desktop Monitor 删除会话、确认框和失败保留。
- [ ] 增加会话重命名协议、Worker title command 和三端同步。
- [ ] 对齐 mobile 的 Worker 标题、CRUD 和事件 reducer 行为。
- [ ] 增加 server、bridge、GUI、mobile 单元和集成测试。
- [ ] 在远端 Windows 非系统盘准备 TCodex：运行
      `npm i -g @tencent/tcodex --registry=https://mirrors.tencent.com/npm`
      并确认 debug Kode 能解析其命令。
- [ ] 用 Mac debug desktop、远端 Windows debug desktop 与一个 Android emulator
      验证三端创建、删除、改名、切换目标和实时刷新。
- [ ] 验证账号中继、palm 登录链路、Worker 隔离和旧客户端兼容。
- [ ] 按 delivery slices 拆分提交和 PR，不把新增工作继续堆到 PR #36。
