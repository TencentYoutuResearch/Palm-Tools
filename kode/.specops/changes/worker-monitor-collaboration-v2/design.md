---
schema_version: 2
id: worker-monitor-collaboration-v2
kind: feature
document_class: work_item
work_type: feature
title: Worker/Monitor 协作、身份与实时会话管理设计
status: proposed
verifies:
  - rust
paths:
  - apps/gui/src
  - apps/gui/src-tauri/src
  - apps/mobile/lib/src
  - crates/kode-bridge/src
  - crates/kode-sync-server/src
---

# Worker/Monitor 协作、身份与实时会话管理设计

## Identity model

Worker 身份和展示名称必须分离：

```text
worker_id      server-issued immutable device row id (`dev_...`)
installation   client installation id used only to recover this Worker registration
hostname       automatic machine name reported by the Worker
display_name   user-editable name; registration never overwrites it
```

`worker_id` 继续作为所有 session/event/command 的隔离键。不得使用 hostname、
display name 或 installation id 作为会话外键。self-hosted sync-server 的
`(server_url, installation_id)` 仍用于恢复凭据；account relay 的 device id
保持现有账号协议，不在本次变更中强行合并两套身份域。

`POST /api/v1/devices/register` 增加可选 `hostname`，更新已有设备时只刷新
`hostname`/`last_seen_at`，不覆盖用户设置过的 `display_name`。迁移时用现有
`name` 初始化 display name，避免 UI 立即丢失名称。

新增 worker profile 更新接口，语义等价于：

```text
PATCH /api/v1/workers/:worker_id
{ "display_name": "Office Windows" }
```

授权规则：

- Worker 自身 device bearer 可以修改自己。
- 同一 Worker binding 的 mobile/desktop Monitor 可以在当前单租户 self-hosted
  模式下修改。
- 引入账号系统后必须按 tenant membership 和 Worker ownership 校验；仅知道
  server URL 不构成权限。
- 其他 server 或 tenant 的设备统一返回 `404`，不泄露存在性。

Windows hostname 读取顺序为 `COMPUTERNAME`（Windows）、系统 hostname
（Unix/macOS），最后才使用 `Kode Desktop`。display name 优先用于目录、模式
入口、会话页标题和详情标题；hostname 可作为详情中的辅助信息。

## Monitor and open-session state

桌面状态拆成三个独立对象：

```text
workMode: "worker" | "monitor"
monitorWorkerId: selected Worker for the visible directory/list
deviceView: { sourceWorkerId, session, sessions }
```

`monitorWorkerId` 改变时：

- 取消旧目标的事件订阅；
- 拉取新目标列表；
- 不清空 `deviceView`；
- `deviceView` 的历史、输入和命令继续使用 `sourceWorkerId`；
- 只有点击新目标中的会话或显式关闭时，才改变/清空 `deviceView`。

这些规则同样适用于 Worker/Monitor 模式切换，避免切换导航状态意外终止当前
阅读或输入。会话标题栏显示来源 Worker 名称，避免用户误以为当前对话已切换。

## Real-time list synchronization

Mobile 已通过 `/ws` 消费 worker-scoped session 事件。Desktop self-hosted
Monitor 复用同一事件协议：

```text
GET /ws
Authorization: Bearer <desktop monitor token>
X-Kode-Worker-Id: <selected worker>
```

事件处理：

- `session.created` / `session.updated`：插入或替换完整 DTO；
- `session.exited`：移除对应 cloud session；
- `meta`：patch title/model/token 等稀疏字段；
- `connection.hello`：触发一次完整列表校准；
- socket 断开、切换 Worker 或权限撤销：停止消费并忽略迟到事件。

切换目标使用 generation/epoch 防止旧请求或旧 socket 覆盖新列表。30 秒轮询保留
为兼容 fallback，但不再是主要刷新机制。

## Session management

创建、删除和重命名都必须在当前 bearer 所选 Worker 上执行。

### Create

复用 mobile 已有 `POST /api/v1/sessions`、backend/model/path catalogues 与
`Idempotency-Key`。Desktop Monitor 新增 IPC 和选择界面，不直接访问远端文件
系统或 CLI 参数。成功响应使用 canonical cloud id 打开会话。

### Delete

复用 `DELETE /api/v1/sessions/:id` 的 command lifecycle。桌面必须二次确认，
收到 `command.status=executed` 或 `session.exited` 后才从列表移除；遇到 404
按已删除处理，其它失败保留该行并显示错误。

### Rename

新增 worker-scoped title 操作：

```text
PATCH /api/v1/sessions/:id
{ "title": "Device validation on M4" }
```

server 验证 session 属于当前 Worker，并下发 command kind `rename`。Worker 调用
与本地 GUI 相同的 `set_title` 路径，立即 emit `meta { title }`，同时持久化
title pin。server patch DTO 后向所有移动/桌面 socket 发布更新。

规则：

- 空标题非法；长度和字符边界在 server 与 Worker 双重校验；
- command 使用 `Idempotency-Key`；
- UI 可在 command 被接受后乐观显示标题，但失败或超时回退到最近确认值；
- AI 自动标题不得覆盖 pinned user title；
- mobile、来源 desktop 和其他 Monitor 都从 canonical DTO/事件更新。

## Mobile behavior

Mobile 保持 Monitor-only：

- Worker 切换入口继续在绑定设备二级页；
- 切换目标会切换列表和 WebSocket context；
- 会话标题显示当前目标 Worker display name；
- 重命名、删除和创建完成后复用与 desktop 相同的 server 事件；
- 切换目标后，如有旧请求返回，必须通过 generation 丢弃。

## Account integration

- 账号栏、CloudBase installation/device identity 和 palm 相关接口不改 schema。
- account relay 的现有 device/session/command 路由保持独立。
- 若当前账号可发现多个 desktop，名称采用 relay 返回的 display name；用户改名
  需要 relay 侧 ownership API，不在客户端伪造。
- self-hosted sync-server 在没有账号时可以继续使用当前单租户授权模型；引入
  user/tenant 后，server 使用登录身份而非“知道 server URL”作为跨 Worker 权限。

## Compatibility and migration

- 旧 Worker 不上报 hostname 时继续显示现有 name。
- 旧 mobile 不发送 `X-Kode-Worker-Id` 时保持绑定 Worker 行为。
- 旧 desktop 不消费 `/ws` 时继续依赖 REST 列表。
- `display_name` 为持久字段，hostname 只更新自身列。
- 所有新增 REST 路由加入现有 cross-tenant/foreign-device 测试。
- 协议解析失败不回退为无 Worker 路由。

## Verification strategy

1. server unit/integration：
   - register migration and display-name preservation；
   - rename authorization、foreign Worker 404；
   - create/delete/rename worker scoping；
   - WebSocket event fanout per Worker。
2. bridge：
   - Windows hostname；
   - worker-scoped create/delete/rename；
   - title command emits `meta` and persists pin；
   - TCodex reply event must be emitted before mobile timeout expectations。
3. GUI：
   - target switch preserves open session and source routing；
   - late response generation isolation；
   - create/delete/rename states and error rollback；
   - WebSocket reducers and reconnect reconciliation。
4. mobile：
   - switch Worker while an old refresh is pending；
   - created/updated/exited/meta reducer；
   - title display and CRUD confirmation。
5. E2E：
   - two debug desktops plus one Android emulator;
   - create/delete/rename from each end;
   - verify list, title and conversation reply converge online and after reconnect。
