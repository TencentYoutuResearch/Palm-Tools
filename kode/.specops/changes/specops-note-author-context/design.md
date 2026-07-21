# Design

## 现状（调研结论）

- 类型定义：`apps/specops/src/domain/notes.ts:9-24`

```ts
export interface DocumentNote {
  schema_version: 1
  id: string
  document_path: string
  block_id: string
  block_kind: string
  line_start: number | null
  line_end: number | null
  quote: string
  body: string
  source_hash: string
  status: DocumentNoteStatus
  stale: boolean
  created_at: string
  updated_at: string
}
```

- 创建入口：`apps/specops/src/domain/notes.ts:37-60` `createDocumentNote()`
- REST：`apps/specops/src/server/index.ts:614-635`
  - `GET /api/notes`
  - `POST /api/notes`
  - `POST /api/notes/{id}/resolve|deprecate`
- 前端提交：`apps/specops/frontend/src/components/iwiki/SpecPageView.svelte:324-347`
  （`submitComposer()` 中 `composerMode === 'note'` 分支）
- 前端展示：`apps/specops/frontend/src/components/iwiki/SpecPageView.svelte:846-856`
  （固定标题 "Note" + `body`，未展示 `quote` / 行号 / 作者）
- 持久化：`.specops/state/notes/{uuid}.json`，每个笔记一个文件

## 缺口

1. **身份缺失**：无论是前端 UI 还是后端 API，都没有传递/存储"谁创建了这条笔记"。
2. **引用信息未聚合展示**：`quote` / `line_start` / `line_end` / `document_path`
   / `block_id` 已经存在于数据模型中，但前端渲染时完全没用到——用户看不到笔记
   实际引用的原文片段。

## 提案方向

### 数据结构

新增两个字段，`schema_version` 递增以便区分新旧格式：

```ts
export interface DocumentNote {
  schema_version: 2
  // ...existing fields...
  created_by: string | null   // 创建者标识；无法获取时为 null
  source: 'ui' | 'agent' | 'api'
}
```

读取旧文件（`schema_version: 1`）时在 `listDocumentNotes()` 做一次迁移填充：
`created_by: null`, `source: 'ui'`。

### 身份来源

调研阶段未确认 SpecOps 当前是否已有登录/会话身份概念。若已有（例如请求头、
cookie、或本地 CLI 调用者的系统用户名），`created_by` 直接使用该值；若完全没有，
则：
- 后端接受请求体中显式传入的 `created_by`（前端可从本地已知的用户配置读取，
  如 git `user.name` 或环境变量，具体来源留给实现阶段确认，不在本提案中臆造）。
- 若前端也拿不到，落库为 `null`，前端展示为 "Unknown"。

### 前端展示

笔记卡片改为类似：

```
[创建者名 / Unknown] · [source 标签]
> "被引用的原文片段（quote）" (行 line_start-line_end)
笔记正文（body）
```

## 风险与权衡

- 引入 `schema_version: 2` 需要保证旧文件仍可被解析，不能因为字段缺失而抛错。
- 若后续要接入真实用户认证系统，`created_by` 的语义（用户名 vs UUID）需要在
  那时统一，本次先以“尽力标注、缺失时明确为 Unknown”为目标，不过度设计。
