# Design

## 决策 1：输入协议与 mobile 对齐

Composer 保留用户正文内部换行，统一 CRLF/CR 为 LF，并在发送前补齐一个
末尾 LF。Worker 端已有“正文与 Enter 分开写入”逻辑，避免 Ink 将二者识别为
paste。

## 决策 2：Alt+Enter 作为显式软换行

Enter 继续发送，Shift+Enter 保留浏览器默认换行，Alt+Enter 阻止发送并在
textarea selection 位置插入 LF。光标移动到插入点之后。

## 决策 3：复用 mobile 附件协议

Desktop 读取本地绝对文件路径，按 2 MiB 分块 POST 到 sync-server
`/api/v1/attachments`，携带 monitor token 和目标 `X-Kode-Worker-Id`。目标
Worker 写入自己的 `kode-attachments` 临时目录并返回本地绝对路径。

消息正文沿用 mobile 的 `Attached file: <path>` 引用格式，因此 CLI 和后续
transcript 展示无需新增协议。

## Verification

- `cargo test -p kode-bridge worker_attachment_upload_uses_monitor_binding --lib`
- `cargo check -p kode-gui`
- `pnpm --dir apps/gui check`
- `pnpm --dir apps/gui build`
