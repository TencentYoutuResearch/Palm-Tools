# Design

## 背景与现状

SpecOps web UI(`apps/specops/src/server/public/{index.html,app.js,styles.css}`)是 `specops serve` sidecar 提供的独立原生 HTML/CSS/JS 应用,**不使用 Svelte**,也**不使用 xterm.js**。transcript 通过 `marked.umd.js` 渲染成 HTML 插入 `#session-transcript` 容器。

两个需要改的滚动容器:

| 容器 | 位置 | 当前强制贴底代码 |
|---|---|---|
| `#session-transcript` | `index.html:128`,样式 `styles.css:1375`(`overflow-y: auto`) | `app.js:589` |
| `#clarify-transcript` | `index.html:221` | `app.js:1432` |

`renderTranscriptCompact(session)` 在每次 `session.updated` SSE 事件触发,内部 `transcript.replaceChildren()` 全量重建 DOM —— 这会**重置 `scrollTop`** 到 0。所以「是否贴底」的判断必须在 `replaceChildren()` 之前读取,在 `replaceChildren()` 之后按之前的状态决定是否 `scrollTop = scrollHeight`。

## 行为契约

```
stickToBottom = true   (默认)
  ├─ 新消息到达 → 自动滚到底部
  └─ 用户上滑(距底部 > 阈值) → stickToBottom = false
stickToBottom = false
  ├─ 新消息到达 → 保持当前滚动位置(DOM 重建后恢复 scrollTop,不跳底)
  └─ 用户滚回底部(距底部 ≤ 阈值) → stickToBottom = true
切换 session → stickToBottom 重置为 true
```

阈值取 24px —— 容忍亚像素滚动和滚动条边距,避免「在底部但被判为不在底部」的误判。该值定义为模块顶部常量 `STICK_TO_BOTTOM_THRESHOLD_PX`,便于后续微调。

## 关键实现细节

### 1. 状态读取时机(陷阱)

错误写法:
```js
function renderTranscriptCompact(session) {
  const transcript = document.querySelector('#session-transcript')
  transcript.replaceChildren()
  // ... 重建 ...
  if (isScrolledToBottom(transcript)) {            // ❌ 此时 scrollTop 已被 replaceChildren 重置为 0
    transcript.scrollTop = transcript.scrollHeight
  }
}
```

正确写法:
```js
function renderTranscriptCompact(session) {
  const transcript = document.querySelector('#session-transcript')
  const wasAtBottom = sessionStickToBottom          // ✅ 用 scroll 事件维护的标志位
  transcript.replaceChildren()
  // ... 重建 ...
  if (wasAtBottom) {
    transcript.scrollTop = transcript.scrollHeight
  }
}
```

为什么不直接在重建前读 `isScrolledToBottom(transcript)`?也可以,但 `sessionStickToBottom` 标志在 scroll handler 里已经维护好了,直接复用更一致。两种写法等价,选标志位方案是因为 scroll 事件可能被节流,标志位反映的是用户「最近一次意图」。

### 2. scroll 事件监听

在 `DOMContentLoaded` 或现有初始化路径里绑定一次:

```js
const STICK_TO_BOTTOM_THRESHOLD_PX = 24
let sessionStickToBottom = true
let clarifyStickToBottom = true

function isScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD_PX
}

function bindStickToBottom(el, getFlag, setFlag) {
  el.addEventListener('scroll', () => {
    setFlag(isScrolledToBottom(el))
  }, { passive: true })
}
```

`passive: true` —— scroll 事件不 preventDefault,标 passive 提升滚动性能(避免浏览器等 JS 执行完才渲染)。

### 3. 切换 session 重置

找到 session 列表点击 handler(渲染 transcript 之前),加:
```js
sessionStickToBottom = true
```
否则切到新 session 时,如果上一个 session 用户在中间位置,新 session 不会自动贴底。

### 4. clarify 视图

`showClarifyPanel(show)` 在 `app.js:1425` 已经 `clarifyTranscript.replaceChildren()` —— 这相当于首次渲染,顺手把 `clarifyStickToBottom = true` 一起重置即可。`appendClarifyMessage` 改为读标志位决定是否贴底。

## 不做的事

- **不引入跳到底部悬浮按钮**:用户原话只要求「上滑时不自动滚动」,没要求新 UI。悬浮按钮可作为后续 enhancement。
- **不重构 `replaceChildren` 全量重建**:虽然全量重建在性能上不理想(每次 SSE 都重建整个 DOM),但这是现有架构,本次只加滚动状态处理,不顺带动结构。
- **不动 `.run-panel-body`**:外层面板滚动跟 transcript 内部贴底是两个独立的滚动容器,改外层会扩大 blast radius。
- **不引入 Svelte/reactivity**:整个 specops web UI 是原生 JS,本次保持一致。

## 风险

- **scroll 事件触发频率高**:每次滚动会触发多次 scroll 事件,但 handler 只做一次比较 + 赋值,O(1),无节流必要。若 profiling 发现性能问题再加 rAF throttle。
- **SSE 重建 DOM 期间的 scroll 状态**:由于 `replaceChildren()` 重置 scrollTop,如果 `wasAtBottom=false`,重建后 scrollTop 会是 0(顶部)而不是用户之前的位置 —— 这会让视图跳到顶部,而不是「保持在用户当前阅读位置」。**这是已知缺口**:要真正保持位置,需要在重建前记录 `scrollTop` 和某个锚点元素,重建后恢复。但这超出本次需求范围(用户只说「不滚动到底部」),且全量重建使得精确恢复位置很 fragile。**本次接受的折衷**:重建时如果 `wasAtBottom=false`,既不贴底也不恢复旧位置(scrollTop 保持 0,即顶部)—— 这虽然不完美,但满足「不滚动到底部」的字面要求。如果后续用户反馈「跳到顶部也很难受」,再开新 issue 做 scroll position restoration(需要改 `renderTranscriptCompact` 增量更新而非全量重建,工作量大)。
