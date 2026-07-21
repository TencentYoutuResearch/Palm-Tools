---
schema_version: 1
id: specops-toolcall-lifecycle-rendering-design
kind: change
title: SpecOps toolcall 生命周期渲染设计
status: proposed
verifies:
  - specops
paths:
  - apps/specops/frontend/src/components/chat
  - apps/specops/frontend/src/lib
  - apps/specops/tests
---

# SpecOps toolcall 生命周期渲染设计

## 当前数据流

SpecOps server transcript 已经提供工具调用关联所需字段：

- `apps/specops/src/domain/session.ts` �� `TranscriptEntry` 注释说明：
  - `tool_use` 表示工具调用开始，携带 `tool` / `tool_call_id` / `summary` / `status`。
  - `tool_result` 表示工具调用结果，通过 `tool_call_id` 与 `tool_use` 配对，携带 `preview` / `status`。
- `apps/specops/src/domain/session-monitor.ts` 同步 transcript 时已按 `(kode_session_id, kind, tool_call_id)` 去重。
- `apps/specops/src/adapters/kode.ts` 的 transcript client 已声明 UI 应通过 `tool_call_id` 配对。

因此本变更不需要修改后端协议。缺口只在 SpecOps 前端把 flat transcript 直接逐条渲染。

## 推荐设计

在前端引入 display item 层，把 flat transcript 转换为 UI 友好的结构：

```ts
type DisplayItem =
  | { kind: 'message'; entry: TranscriptEntry }
  | { kind: 'tool'; use?: TranscriptEntry; result?: TranscriptEntry }
```

配对规则：

1. 只在当前 `AgentGroup` 的 entries 内配对，避免跨 `kode_session_id` 关联。
2. `tool_call_id` 是唯一关联键；没有 `tool_call_id` 的工具条目保持独立渲染。
3. 输出顺序保持 transcript 的语义顺序：paired item 放在 `tool_use` 首次出现的位置。
4. 已与 `tool_use` 配对的 `tool_result` 不再作为第二张卡片重复渲染。
5. 异常数据降级处理：
   - 只有 `tool_use`：显示 running tool card，无 preview。
   - 只有 `tool_result`：显示 result tool card，仍可展开 preview。
   - 重复 result：使用稳定策略并用测试固定行为，优先避免重复卡片。

## 组件改造

### `AgentGroup.svelte`

当前逻辑直接遍历 `entries`：

```svelte
{#each entries as entry}
  {#if entry.kind === 'tool_use' || entry.kind === 'tool_result'}
    <ToolCard {entry} />
  {:else}
    <MessageBubble {entry} />
  {/if}
{/each}
```

改造后先计算 display items，再按 item 类型渲染：

- `message` → `MessageBubble`
- `tool` → `ToolCard entry={use ?? result} resultEntry={result}`

如果配对逻辑较长，优先提取到 `frontend/src/lib/` 的纯函数，便于 Vitest 覆盖。

### `ToolCard.svelte`

扩展输入，使它能表达完整生命周期：

- `entry`：优先为 `tool_use`，孤立 result 时可为 `tool_result`。
- `resultEntry?: TranscriptEntry`：配对到的结果。

派生字段：

- `tool = entry.tool ?? resultEntry?.tool ?? 'tool'`
- `summary = entry.summary ?? entry.text ?? ''`
- `status = resultEntry?.status ?? entry.status ?? 'running'`
- `previewSource = resultEntry?.preview ?? (entry.kind === 'tool_result' ? entry.preview : '')`

展开区域：

- 有 `previewSource`：调用 `parseToolPreview(previewSource)`，按 JSON / KV / text 渲染。
- 无 `previewSource`：显示未完成提示和 `tool_call_id`。

## 权衡

### 为什么不改 server transcript？

后端已经保存了完整的 flat log，这是更接近事实的事件流；配对是展示层需求。前端 display item 可以在不迁移历史 session 文件、不改变 API 的前提下改善 UX。

### 为什么不把 tool_result 合并写回 tool_use？

这会改变持久化格式，并使 transcript 失去事件流语义。保持 flat 存储、UI 层组合更容易兼容旧数据和未来协议。

### 为什么继续复用 `parseToolPreview()`？

该 parser 已有 JSON / KV / text 的安全 fallback 和测试覆盖。复用它能避免引入新的 JSON 解析分支，也保持现有结果预览的一致性。

## 验证策略

- 用 Vitest 覆盖 display item 配对函数。
- 保留并复用现有 `tool-preview-parser.test.ts` 对 JSON / KV / text 的测试。
- 运行 `pnpm test`（cwd: `apps/specops`），对应 `verify.specops`。
