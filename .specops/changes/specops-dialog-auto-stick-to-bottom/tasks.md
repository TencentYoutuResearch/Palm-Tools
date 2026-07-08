# Tasks

- [ ] 在 `apps/specops/src/server/public/app.js` 顶部模块作用域新增 `const STICK_TO_BOTTOM_THRESHOLD_PX = 24` 常量,以及 `let sessionStickToBottom = true`、`let clarifyStickToBottom = true` 两个标志
- [ ] 新增辅助函数 `isScrolledToBottom(el)`,返回 `el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD_PX`
- [ ] 为 `#session-transcript` 绑定 `scroll` 事件监听(在 DOMContentLoaded 或已有初始化处),更新 `sessionStickToBottom = isScrolledToBottom(el)`
- [ ] 为 `#clarify-transcript` 绑定同样的 `scroll` 监听,更新 `clarifyStickToBottom`
- [ ] 修改 `renderTranscriptCompact(session)`(`app.js:531`):
  - 在 `transcript.replaceChildren()` 之前读取 `const wasAtBottom = sessionStickToBottom`(或 `isScrolledToBottom(transcript)`,因为重建后 scrollTop 会重置,必须用重建前的状态)
  - 末尾的 `transcript.scrollTop = transcript.scrollHeight`(`app.js:589`)改为 `if (wasAtBottom) transcript.scrollTop = transcript.scrollHeight`
- [ ] ���改 `appendClarifyMessage(role, text)`(`app.js:1430`):
  - `appendChatBubble` 之后,把无条件的 `clarifyTranscript.scrollTop = clarifyTranscript.scrollHeight` 改为 `if (clarifyStickToBottom) clarifyTranscript.scrollTop = clarifyTranscript.scrollHeight`
- [ ] 切换 session 的入口(渲染 transcript 前重置 `sessionStickToBottom = true`)—— 找到切换 session 的 handler(通常在 session 列表点击处)加一行重置,确保新会话首屏贴底
- [ ] 可选:在 `showClarifyPanel(show)`(`app.js:1425`)里 `clarifyTranscript.replaceChildren()` 时把 `clarifyStickToBottom` 重置为 true
- [ ] 在 `apps/specops/src/server/public/styles.css` 视觉确认:滚动容器已有 `overflow-y: auto`(`styles.css:1389`),无需改动;如新增「跳到底部」按钮则跳过(out of scope)
- [ ] 跑 `pnpm test`(cwd=`apps/specops`)确认现有测试通过
- [ ] 如有针对 `renderTranscriptCompact` / `appendClarifyMessage` 的单元测试,补一条用例覆盖「用户不在底部时不强制滚动」分支;若该模块目前无 DOM 测试基建,仅靠手动验证即可(在 SpecOps server 实例里上滑观察)
