---
schema_version: 2
id: fix-windows-terminal-link-direct-click
document_class: design
status: completed
---

# Design

## Platform activation contract

链接激活规则集中在一个纯函数中：

```text
activate link =
  Windows platform
  or macOS Cmd key
```

所有入口必须复用该规则：

1. xterm 内置 `linkHandler` 的 OSC 8 激活；
2. `registerLinkProvider` 返回链接的 `activate` 回调；
3. 终端容器的点击捕获逻辑，用于阻止链接文本进入选区。

函数接收事件和 Windows 平台标记，不直接读取全局环境，便于单元测试。

## Hit-testing boundary

Windows 的普通单击只有在命中链接时才被消费。对非链接区域，点击捕获逻辑继续返回，
保留终端光标、文本选择和现有 TCodex 鼠标安全处理。

拖拽仍属于选择手势，不因链接单击规则被提前打开。链接激活由 xterm 在完成点击判定
后触发。

## TCodex interaction

Windows TCodex 当前已有自己的 mouse ownership 和 mouse-report filtering。链接
单击直达不能绕过这些保护，也不能向 PTY 注入鼠标报告。

如果当前 backend 的 mouse tracking 会先拦截单击，手势分类器应识别链接命中并跳过
本地 click ownership，让终端链接层处理该次激活；否则维持现有本地选择逻辑。该行为
必须通过现有 mouse suite 证明不会造成 TCodex 退出或中断。

## Verification strategy

- 纯函数测试覆盖 Windows 单击直达和 macOS `Cmd+Click`。
- 终端检查验证 OSC 8、link provider 和点击捕获三处都使用同一规则。
- 运行 `pnpm --dir apps/gui test:terminal-links`、mouse suite、`svelte-check` 和
  GUI 构建。
- 在远端 Windows 启动真实 TCodex，确认终端输出包含 URL；先清理浏览器进程，再通过
  无修饰键单击链接，验证默认浏览器新进程的启动参数包含同一 URL。

## Risks

- 如果点击捕获层在链接命中判断前消费事件，可能阻塞文本选择。实现必须先命中链接再
  `preventDefault`。
- TCodex 的 mouse reporting 可能改变事件顺序。Windows 验证必须覆盖真实 TCodex，
  不能只依赖纯函数测试。
- macOS 平台标记误判会让普通单击打开链接，测试必须锁住该边界。

## Rollback

将激活谓词恢复为 Windows `Ctrl+Click` 即可，不涉及数据、协议或持久化迁移。

## Verification evidence

Remote Windows Server 2025 host `21.130.222.251`, commit `65f8017`:

- Windows Node tests: terminal links `9 passed`, terminal mouse `25 passed`.
- Windows `pnpm check`: 0 errors; only two pre-existing CSS compatibility warnings.
- Windows debug GUI build completed with the real Tauri/WebView2 stack.
- A real TCodex session emitted
  `https://copilot.tencent.com/login?platform=CLI&state=...`.
- Existing Edge processes were cleared, then a direct terminal click launched exactly
  one Edge main process with that URL in `--single-argument`.
