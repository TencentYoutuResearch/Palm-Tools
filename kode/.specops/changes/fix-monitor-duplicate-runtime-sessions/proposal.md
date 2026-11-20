---
schema_version: 2
id: fix-monitor-duplicate-runtime-sessions
kind: bug
document_class: work_item
work_type: bugfix
title: 修复 Monitor 将已死亡 GUI owner 的历史 runtime 重复显示
status: proposed
verifies:
  - rust
paths:
  - crates/kode-bridge/src/runtime.rs
  - crates/kode-bridge/src/cloud_sync.rs
  - crates/kode-sync-server/src/lib.rs
  - crates/kode-sync-server/src/multidevice_tests.rs
---

# 修复 Monitor 将已死亡 GUI owner 的历史 runtime 重复显示

## Motivation

Mac Monitor 选择 Windows Worker 后，同一会话会显示多次。服务端证据显示同一
Windows `boot_id` 下，相同 `session_uuid` 同时存在多个 shared-runtime
`local_id`，其 owner PID 分别来自已经退出的三个 GUI 进程。

根因链路：

1. `runtime.rs` 只在 Unix 上检查 GUI PID 存活；Windows 上直接把
   workbench 的在线状态当作每个 GUI owner 都存活。
2. `cloud_sync.rs` 因而持续发布历史 GUI PID 留下且未标记 exited 的 runtime
   投影。
3. 服务端只按 `local_id` 幂等；同一个稳定 `session_uuid` 换了 `local_id` 后
   会插入新行，Monitor 与 mobile 都会看到重复会话。

## Scope

- Windows/macOS/Linux 统一判断 GUI runtime owner PID 是否真实存活。
- `owner_alive=false` 的 GUI runtime 不进入 cloud snapshot。
- Bridge 发布前按稳定会话身份归并 shared-runtime 投影，避免同一会话以多个
  本地投影上传。
- 服务端对同一 Worker、同一 `session_uuid` 的历史 active 行做防御性归并：
  仅保留规范行，其他行标记 exited 并保留历史。
- 不按标题或目录去重；无 `session_uuid` 的会话不得仅因标题相同而合并。
- Desktop Monitor 和 mobile session list 共用修复后的服务端结果。

## Acceptance criteria

- [ ] Windows 上退出 GUI PID 的 runtime 投影不再得到 `owner_alive=true`。
- [ ] 同一 `session_uuid` 的多个 shared-runtime `local_id` 只产生一个 active
      Monitor 行。
- [ ] 被归并的旧 cloud session 标记 exited，历史事件仍可按旧 ID 读取。
- [ ] 同名但 `session_uuid` 不同或为空的真实会话不会被误合并。
- [ ] 当前 live owner 的会话、DSH runtime 和 shared local-id 会话不受影响。
- [ ] Mac Monitor 与 mobile session list 均无重复，且会话可正常打开。
- [ ] Windows Worker 重启、切换 GUI 进程和断线重连后不重新出现重复行。

## Out of scope

- 删除云端的 exited 历史记录。
- 改变会话命令路由或 runtime 协议版本。
- 修改 Monitor 的目录分组与排序规则。
- 清理与本次重复身份无关的历史 Worker 数据。

## Constitution conflicts

无。本变更不涉及 PTY child lifecycle、backend 默认参数或 SpecOps Run 隔离。
