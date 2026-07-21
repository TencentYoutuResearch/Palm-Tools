# Design

## 决策

### 决策 1：用 `Set<tool_call_id>` 持久化展开态，而非增量 diff 渲染

**选择**：在 `app.js` 顶层维护 `expandedToolCallIds = new Set()`，`appendToolCard()` 按 Set 决定初值，click handler 同步 Set。`replaceChildren()` 全量重建路径保留不动。

**理由**：
- `renderTranscriptCompact()` 当前是 `replaceChildren()` + 全量重建，逻辑简单清晰；改成 diff/patch 增量渲染涉及 entry key 比对、保留滚动位置、保留子节点引用等大量边角，风险远高于收益。
- 用户痛点是"展开态被吞"，本质是状态没有出处。把状态外置到 Set，DOM 重建后从 Set 恢复即可——最小改动面、最低回归风险。
- `tool_call_id` 已是稳定 dedupe key（`session-monitor.ts:87` 用它去重），用作 Set key 可靠。

**边界处理**：
- `callId == null` 的 entry（理论上不应出现，bridge 总会带 id）：用 WeakSet<HTMLElement> 兜底——但既然 `appendToolCard()` 已有 `callId != null` 分支，实际无 id 的 card 走不到展开逻辑，可直接忽略。
- session 切换：必须清空 Set，否则切到别的 session 后同 id（虽然极不可能撞）会被错误地展开。在 `openSession()` 入口清空。
- session 关闭（`session.closed` 事件）：activeSession 会被清，下次打开别的 session 时 `openSession()` 会清 Set，无需特殊处理。

### 决策 2：二次解析放在渲染层，不改 TranscriptEntry shape

**选择**：新增 `renderToolPreview(preview: string): Node`，纯前端解析，`session-monitor.ts` 和 `TranscriptEntry` 不动。

**理由**：
- 服务端解析会把展示逻辑塞进 domain 层，破坏前后端分工；同一份 preview 在不同上下文可能要不同呈现（未来 GUI 端如果复用 transcript，服务端格式化反而绑死）。
- 解析失败可以无副作用 fallback 到纯文本，不会污染持久化数据。
- 不动 `TranscriptEntry` 字段 shape = 不动 jsonl 持久化、不动 SSE 协议、不动 dedupe 逻辑——零向后兼容成本。

### 决策 3：二次解析的尝试顺序与回退

`renderToolPreview(preview)` 内部按以下顺序尝试，任一抛错就进下一种：

1. **JSON**：`JSON.parse(preview)` 成功 → 渲染为 `<pre>` 包裹的缩进 JSON，key 用 `<span class="tj-key">` 着色、字符串值用 `<span class="tj-str">`。深度不限（直接 `JSON.stringify(obj, null, 2)` 后按行拆分渲染）。注意：`preview` 可能是 `"foo"` 这种合法 JSON 字符串，`JSON.parse` 会成功但结果是个字符串——这种情况下走纯文本更合理（判断 `typeof parsed !== 'object' || parsed === null` 时降级到方案 3）。
2. **多行 key:value**：preview 含换行 + 每行大致匹配 `^\s*[\w-]+\s*[:=]` → 按行拆，每行渲染 `<span class="kv-key">$key</span><span class="kv-sep">: </span><span class="kv-val">$val</span>`。
3. **纯文本 fallback**：`<pre>` + `textContent = preview`，等同当前行为。

所有路径外层 try/catch，最终兜底返回 `<pre>textContent=preview</pre>`。**绝不向上抛**——单条 tool card 解析失败不能让整条 transcript 渲染崩溃。

### 决策 4：不新增 npm 依赖

`marked.umd.js` 已存在于 `public/`，但用于 markdown，不适合 JSON 语法高亮。轻量自实现 key/value 着色（CSS class + textContent，不用 innerHTML 防 XSS）足够。如未来需要更复杂高亮再评估引入 highlight.js / shiki，本变更不引入。

## 关键文件 / 行号参考

- `apps/specops/src/server/public/app.js:441-487` —— `appendToolCard()`，改 click handler + 创建后查 Set。
- `apps/specops/src/server/public/app.js:501-504` —— `renderTranscriptCompact()` 全量重建，保留不动。
- `apps/specops/src/server/public/app.js:1671-1674` —— SSE `session.updated` handler，确认其触发路径无需改（改在渲染端恢复状态即可）。
- `apps/specops/src/server/public/styles.css:1491-1502` —— `.chat-tool-preview` 样式，补 key/value 着色与最大高度。
- `apps/specops/src/domain/session-monitor.ts:96-98` —— 确认 `summary` / `preview` 来源，本变更不动。
- `apps/specops/src/adapters/kode.ts:44-54` —— `TranscriptEntry` 字段定义，本变更不动 shape。

## 风险与回退

- **风险**：`expandedToolCallIds` Set 在长会话里可能积累大量 id（每次 tool call 都加），但用户折叠后会移除，且 session 切换清空——实际不会无限增长。若担心可加上限（如 >200 时清最早）但 MVP 不必。
- **风险**：`renderToolPreview` 的 JSON 路径可能误判——例如 preview 是 `"null"` 或 `"123"` 这种合法 JSON 字符串。已通过"parsed 不是 object 降级"处理。
- **回退**：所有改动集中在 `app.js` 的两个函数 + `styles.css` 一段；如出问题 git revert 单 PR 即可，无协议/数据迁移成本。

## 不做的方案

- **diff/patch 增量渲染**：改动面大、回归风险高，留作未来工作（见 proposal.md Out of scope）。
- **服务端格式化**：破坏前后端分工，绑死展示形态。
- **新增 syntax-highlight 依赖**：超出当前可读性诉求，本变更轻量自实现足够。
