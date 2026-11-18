# Design

## 决策 1：沿用现有 command 与 receipt 链路

Desktop Monitor 的 `model` operation 复用 sync-server 已有
`POST /api/v1/sessions/:id/model`。bridge 的 worker command allowlist 增加
`model`，请求继续携带 monitor token 与 `X-Kode-Worker-Id`。不新增第二套远端
控制协议，也不从 UI 直接调用 Worker bridge。

## 决策 2：模型目录从当前 Worker 读取

新增 worker-scoped catalogue 调用，转发
`GET /api/v1/backends/:key/models`，使用当前 Worker header。Desktop 只在
`workerScoped` 会话中显示选择器；账号中继路径保持不变。选择器先保留会话 DTO
当前模型，再合并远端 catalogue，避免目录尚未返回时出现空值。

`codebuddy` ACP 继续通过 advertised model config option 或显式 legacy
`session/set_model` 切换；`tcodex` 和 `tclaude` PTY 只通过各自已识别的原生
`/model` 菜单/命令切换。模型 ID 必须来自当前 Worker 的 catalogue，不跨 backend
复用别名。

## 决策 3：以执行回执作为唯一成功依据

UI 发起 `model` command 后轮询 history 中的 `command.status`，仅在对应
`command_id` 为 `executed` 后认为切换成功。失败时恢复当前模型并显示错误。
这与 mobile 的 `_waitForActionExecution` 语义一致，不把 HTTP `202 dispatched`
当成切换成功。

## 决策 4：TCodex 按真实菜单和确认文案解析

保留现有“只向已识别菜单发送按键”的约束，并把 `Model changed to ` 加入 native
confirmation 识别。菜单选择仍验证精确 model identity，reasoning level 继续按
当前 footer effort 保持；不根据任意屏幕文本盲目发送 Enter。

## 决策 5：Worker snapshot 同时包含 PTY 与 ACP

Worker 的 session snapshot 不能只以 `session.pty` 是否存在判断活跃。CodeBuddy
ACP 会话没有 PTY，但仍由 `ctx.acp` 注册并可直接接收模型命令。snapshot 过滤
同时接受存活的 PTY、ACP registry 中的会话，以及 `--acp` structured session；
这样 desktop/mobile Monitor 都能看到并控制 CodeBuddy。

## 决策 6：跨 Worker session list 由 monitor scope 授权

`GET /api/v1/workers/:worker_id/sessions` 不属于共享 inventory。持有
`workers.monitor` 的 binding 可以在 `X-Kode-Worker-Id` 中指定任意已注册
Worker；header 必须与路径 Worker 一致。没有该 scope 的旧 binding 仍只能读取
自己绑定的 Worker，不因 listing 需求获得 inventory 或 management 权限。

Desktop 首次跨 Worker 访问时先使用当前设备 bearer 给自身创建 monitor
binding，再保存返回的 `workers.monitor` token，并以目标 Worker header 发起
请求。不能用当前设备 bearer 直接给目标 Worker 创建 binding。

## 风险与回退

- 模型目录冷加载可能较慢：选择器期间保持当前模型可见，并由 UI 禁用重复提交。
- 旧 sync-server 可能不接受新增 catalogue 调用：错误就地展示，不影响输入、
  中断和回答。
- 回退只需移除 desktop model UI/worker catalogue 和 TCodex confirmation
  兼容项，不涉及数据迁移。

## Verification

- `cargo test -p kode-bridge model_switch::tests --lib`
- `cargo check -p kode-gui`
- `cargo test -p kode-sync-server mobile_monitor_scope_routes_sessions_to_the_selected_worker --lib`
- `pnpm --dir apps/gui check`
- `flutter test test/session_model_api_test.dart test/session_model_sheet_test.dart`
- Debug desktop Worker + Android emulator：打开 idle TCodex 会话、列出模型、
  切换模型并核对 `executed` 回执与界面模型。
- 同一本地服务下分别创建 `tcodex`、`tclaude`、`codebuddy` 会话，逐项核对
  catalogue、command receipt 和切换后的 session model。
