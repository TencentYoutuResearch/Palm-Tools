---
schema_version: 2
id: toolcard-render
kind: spec
document_class: normative
spec_type: capability
title: SpecOps tool card 渲染层不变性
status: deprecated
verifies: []
paths:
  - apps/specops/src/server/public/app.js
  - apps/specops/src/server/public/styles.css
---

# SpecOps tool card 渲染层不变性

## 背景

SpecOps 会话面板的 `renderTranscriptCompact()`（`apps/specops/src/server/public/app.js`）采用全量 `replaceChildren()` 重建策略，每次 `session.updated` SSE 事件都会清空 `#session-transcript` 并重建 DOM。流式 run 期间事件频率接近每秒一次。

## Invariants

### INV-1：用户对 tool card 的展开/折叠操作必须跨 DOM 重建保留

用户的展开/折叠意图不能被 `replaceChildren()` 重建吞掉。展开态必须存放在 DOM 之外的状态源（如模块级 `Set<tool_call_id>`），`appendToolCard()` 创建节点后从该状态源恢复初值，click handler 同步写回。

**Why**：会话流式写入时 SSE 触发全量重建，若状态只活在 DOM `hidden` 属性上，用户点开后下一次 `session.updated` 就会丢失，导致"展开不到 1 秒就恢复"的体验劣化。

**How to apply**：任何对 `renderTranscriptCompact` / `appendToolCard` 的改动必须保证：(a) 展开态有 DOM 外存储；(b) 重建后从存储恢复；(c) 用户最近一次操作决定状态，而非"默认展开"。session 切换时清空存储避免跨会话串状态。

### INV-2：preview 内容的二次解析必须永不抛错

对 `preview` 字段做结构化渲染（JSON 缩进、key:value 着色等）时，解析失败必须无副作用 fallback 到纯文本 `<pre>` 形式，绝不向上抛错。

**Why**：单条 tool card 的 preview 内容形态不可控（来自不同 backend / 不同 tool 的自由文本），任一解析异常若向上传播会导致整条 transcript 渲染崩溃，影响远大于"展示得不漂亮"。

**How to apply**：解析函数（如 `renderToolPreview`）外层必须 try/catch，所有路径最终返回一个可挂载的 Node；解析只发生在渲染层，不修改 `TranscriptEntry` 字段或 jsonl 持久化数据。

### INV-3：解析与渲染逻辑必须停留在前端渲染层

`preview` / `summary` 的二次解析、状态恢复等逻辑只发生在 `apps/specops/src/server/public/` 前端代码中。不得把解析结果写回 `TranscriptEntry`、不得改 `session-monitor.ts` 的字段、不得改 SSE 传输协议或 jsonl 持久化 shape。

**Why**：SpecOps 前端 UI 与 GUI 终端渲染相互独立（见 constitution），把展示逻辑塞进 domain 层会破坏前后端分工、绑死展示形态，并带来向后兼容成本。同一份 transcript 数据未来可能在其他上下文复用，渲染层保持自由度。

**How to apply**：本 spec 覆盖范围内的所有改动 path 必须落在 `apps/specops/src/server/public/{app.js,styles.css}`；如需新增辅助函数也放在前端 bundle 内，不引入到 `src/domain/` 或 `src/server/` 的非静态资源。
