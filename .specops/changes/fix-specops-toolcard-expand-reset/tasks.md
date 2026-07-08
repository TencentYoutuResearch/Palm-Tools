# Tasks

- [ ] 在 `app.js` 顶部（模块级）新增 `expandedToolCallIds = new Set()` 用于持久化用户展开的 tool card。
- [ ] `appendToolCard()`（`app.js:441-487`）创建 card 后：若 `callId` 在 `expandedToolCallIds` 中则 `previewWrap.hidden = false`、chev 设为 `▾`；否则保持默认折叠。
- [ ] 改写 click handler（`app.js:478-481`）：翻转 `hidden` 后同步把 `callId` 加入 / 移出 `expandedToolCallIds`（`callId == null` 时跳过，无 id 的 card 用临时 DOM 引用兜底）。
- [ ] session 切换 / `openSession` 切到别的 session 时清空 `expandedToolCallIds`，避免跨 session 串状态。
- [ ] 新增 `renderToolPreview(preview)` 函数，按"JSON → key:value → 纯文本"顺序尝试解析，全程 try/catch，失败 fallback 到 `textContent = preview`。
- [ ] `appendToolCard()`（`app.js:473-474`）用 `renderToolPreview()` 的返回 Node 替换原 `previewWrap.textContent = entry.preview`。
- [ ] `appendToolCard()` 的 result 分支（`app.js:450-451`）—— 已存在的 card 收到新 preview 时，清空 previewWrap 后重新 append `renderToolPreview(entry.preview)`。
- [ ] `styles.css`（`.chat-tool-preview` 区域）补：JSON / key:value 渲染的样式（key 着色、缩进、可选最大高度 + overflow:auto 防止超长 card 撑爆视口）。
- [ ] 补单元测试覆盖 `renderToolPreview`：合法 JSON、多行 key:value、纯文本、恶意/异常输入（确保 fallback 不抛）。
- [ ] 在真浏览器目视验证：active run 期间点开 tool card 不被折叠回去；JSON preview 能看到结构化展示。
- [ ] `pnpm test`（apps/specops）通过。
