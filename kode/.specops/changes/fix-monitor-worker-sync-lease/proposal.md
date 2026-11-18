---
schema_version: 2
id: fix-monitor-worker-sync-lease
kind: bug
document_class: work_item
work_type: bug
title: 修复 Monitor 读取兄弟 Worker 时未启用实时 session snapshot
status: proposed
verifies:
  - rust
paths:
  - crates/kode-sync-server/src
---

# 修复 Monitor 读取兄弟 Worker 时未启用实时 session snapshot

## Motivation

Desktop 和 mobile Monitor 可以授权读取兄弟 Worker，但 sync-server 仅在该
Worker 存在手机 binding 时要求它上传 session snapshot。Monitor 只拿到读取权限，
没有触发目标 Worker 的同步，因此接口可能返回空列表或很久以前的 exited 快照。

## Scope

- Monitor 请求目标 Worker 的 session list 时，为该校验通过的 Worker 建立短期
  同步 lease。
- lease 有效期内向目标 Worker 下发 `binding.changed`，使其立即上传 snapshot。
- 持续轮询续租；lease 过期后在下一次 Worker heartbeat 关闭同步。
- 同时覆盖 desktop `/workers/:id/sessions` 和 mobile `/sessions`。

## Acceptance criteria

- [x] 无手机 binding 的在线 Worker 在 Monitor 首次列表请求后仍返回当前活跃 session。
- [x] 目标 Worker 收到 `sync_enabled=true`，并重新上传 snapshot。
- [x] Monitor 持续轮询时 lease 持续有效。
- [x] 停止轮询超过 lease 后，Worker 收到 `sync_enabled=false`。
- [x] 无 `workers.monitor` scope 的旧 binding 仍不能读取其他 Worker。

## Out of scope

- 永久开启全服 Worker 镜像。
- 修改 session 状态过滤规则或把 exited 会话显示为活跃。
