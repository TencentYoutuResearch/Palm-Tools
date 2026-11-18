# Design

## 决策 1：按目标 Worker 建立短期 lease

服务端维护目标 Worker 到最近 Monitor 拉取时间的映射。Monitor 的 list 请求
通过现有鉴权后刷新 lease，而不是因为存在 desktop-monitor binding 就永久镜像
所有 Worker。

## 决策 2：复用现有 `binding.changed` 协议

目标 Worker 已支持收到 `binding.changed` 后发送
`send_snapshot_and_history`。服务端在同步状态变化时使用该协议，不新增请求通道。

## 决策 3：heartbeat 负责关闭过期 lease

Worker 每次 heartbeat 时，服务端重新计算同步状态；Monitor 停止轮询并超过
lease 后，向 Worker 发送 `sync_enabled=false`，避免长期后台镜像。

## Verification

- Worker Monitor list 请求触发 `binding.changed(sync_enabled=true)`。
- lease 过期后 heartbeat 触发 `binding.changed(sync_enabled=false)`。
- 无 `workers.monitor` scope 仍返回 forbidden。
