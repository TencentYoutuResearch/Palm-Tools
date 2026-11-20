# Design

## 决策 1：owner 存活必须跨平台判断

`owner_alive` 表示产生投影的 GUI 进程是否仍存在，不是 Workbench 是否在线。
Windows 使用系统进程 API，Unix 保留现有 signal-0 检查。无法确认进程存活时按
dead 处理，避免重复优先于错误显示。

## 决策 2：Bridge 先归并，服务端再防御

Bridge 发布快照时按以下优先级选择规范投影：

1. 当前 live owner 的投影。
2. 有 `session_uuid` 的 shared-runtime 投影按 `session_uuid` 只保留最近、
   可确定归属的一条。
3. 无 UUID 时保留唯一 `runtime_session_id`；不能仅按 title/cwd 合并。

服务端 hello snapshot 已经具有 authoritative replacement 语义。Bridge 归并后，
未出现在新 snapshot 的旧本地 ID 会自动被标记 exited。服务端额外按
`device_id + session_uuid` 扫描 active 行，作为旧客户端或并发重连的防御层。

## 决策 3：归并不丢历史

被归并的 cloud session 只更新 `status=exited`，不删除 `sessions` 或历史事件。
旧 Monitor/mobile 链接仍能读取历史；新的列表只展示规范 active 行。

## 测试矩阵

- Windows dead PID、live PID。
- Unix dead PID、live PID。
- 同 UUID 三个 local ID，仅一个 active。
- 同标题不同 UUID、UUID 为空的独立会话不合并。
- snapshot 归并后旧 ID 产生 `session.exited`。
- desktop Monitor 与 mobile `/api/v1/sessions` 两条读路径。
