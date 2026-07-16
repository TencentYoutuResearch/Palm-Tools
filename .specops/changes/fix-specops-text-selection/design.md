# Design

## 问题分析

SpecOps 前端目前没有全局的 `user-select` 策略。浏览器默认行为下，所有文本（包括 UI 装饰文字）均可被鼠标选中并出现蓝色高亮。用户期望只有文档内容（spec 正文、chat markdown 消息）可选中，其余 UI 装饰（状态流、tracker 网格、session 列表、导航栏等）不应可选中。

当前仅 4 处显式设置了 `user-select: none`，且都服务于 macOS 窗口拖拽（`-webkit-app-region: drag`）或 diff 行号，并非有意禁止选中:

| 文件 | 选择器 | 用途 |
|---|---|---|
| `Rail.svelte` | `.rail-top` | macOS 拖拽区域 |
| `IwikiHeader.svelte` | `.iwiki-head` | macOS 拖拽区域 + 文档标题栏 |
| `ChatHeader.svelte` | `.chat-head` | macOS 拖拽区域 + Chat 标题栏 |
| `HistoryCommit.svelte` | `.ln` | Diff 行号 |

## 方案: 全局禁止 + 局部开启

### 原则

1. **默认禁止**: 在全局层面禁止所有文本选中
2. **显式开启**: 仅在文档内容区域通过 `user-select: text` 恢复选中能力

这与 Electron/Tauri 桌面应用的惯用模式一致。

### 全局禁止位置

在 `app.css` 的 `.root` 选择器上添加 `user-select: none`:

```css
.root {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) 28px;
  height: 100vh;
  overflow: hidden;
  user-select: none;          /* 新增 */
}
```

选择 `.root` 而非 `body` 的原因:
- `.root` 是 SpecOps 的 App 根容器，所有 UI 都在其子元素内
- 不影响 `body` 层可能插入的外部元素（如 Tauri webview 注入的脚本标签）
- Blast radius 更精准

### 局部开启位置

**1. SpecPageView.svelte — 文档块正文**

在 `<style>` 中添加:

```css
.spec-block .markdown {
  user-select: text;
}
```

位置: `.spec-block > .markdown`（第 807 行）是 spec 文档块的正文本体。此规则确保只有文档正文可选中，而 `.block-meta`（kind/line 信息）继续保持不可选中。

**2. Markdown.svelte — Chat markdown 内容**

在 `<style>` 中添加:

```css
.markdown {
  user-select: text;
}
```

位置: 第 15 行 `.markdown` 容器，被 `MessageBubble.svelte` 用于渲染 chat 消息的 markdown 内容。Chat 消息中的代码块、段落、列表等属于用户可读内容，应可选中。

### 不显式开启的区域（由全局禁止继承）

以下区域继续从全局 `.root { user-select: none }` 继承，无需额外规则，也无需逐个添加:

- SpecPageView: `.page-head`、`.state-strip`、`.trackers`、`.workflow-card`、`.required-action`、`.activity`（Discussion 侧边栏）、`.selection-card`、`.composer`、`.context-menu`
- Rail: `.rail-items`、`.rail-item`
- DocTree: `.tree`、`.group-title`、`.group-items`、`.subfile`
- SessionList: `.session`、`.group-head`
- AgentGroup: `.group-head`、`.purpose`
- StatusBar
- IwikiHeader / ChatHeader: 已有 `user-select: none`，保持不动

### 兼容性考量

`user-select` 属性在 Chromium（Tauri 2 webview 的底层引擎）中完全支持，不需要 vendor prefix。若未来考虑 Firefox/WebKit 兼容，可追加:

```css
-webkit-user-select: none;   /* Safari */
-moz-user-select: none;      /* Firefox */
user-select: none;
```

但在当前 Tauri 2 环境（macOS/Linux 上使用 WebKitGTK 或 Chromium）中，标准 `user-select` 已足够。

### 保持不变的现有规则

- `.rail-top`、`.iwiki-head`、`.chat-head` 的 `user-select: none` + `-webkit-app-region: drag` 保持不变
- `.ln` 的 `user-select: none` 保持不变
