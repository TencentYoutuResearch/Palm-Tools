---
schema_version: 2
id: specops-note-author-context
kind: feature
document_class: work_item
work_type: feature
title: SpecOps 文档笔记补充作者与上下文引用信息
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/domain/notes.ts
  - apps/specops/src/server/index.ts
  - apps/specops/frontend/src/components/iwiki/SpecPageView.svelte
  - apps/specops/tests/notes.test.ts
targets:
  - apps/specops/notes
---

# SpecOps 文档笔记补充作者与上下文引用信息

## Motivation

用户反馈：SpecOps 文档页（`SpecPageView.svelte`）的 "Add note" 功能目前只保存了笔记正文
（`body`），但没有记录**是谁**（哪个用户/agent）生成的这条笔记，也没有把"引用的是文档
哪一部分内容"整理成一份清晰、结构化的上下文，导致后续查看笔记时无法判断来源和可信度，
也难以快速定位笔记针对的原文片段。

调研（见下方 Scope）确认现状：

- `DocumentNote`（`apps/specops/src/domain/notes.ts:9-24`）当前字段为：
  `schema_version`, `id`, `document_path`, `block_id`, `block_kind`,
  `line_start`, `line_end`, `quote`, `body`, `source_hash`, `status`,
  `stale`, `created_at`, `updated_at`。
- 没有任何字段标识笔记的创建者（用户名 / agent key / session）。
- 文档引用信息（`document_path` + `block_id` + `line_start/end` + `quote` +
  `source_hash`）是分散的多个字段，前端展示时（`SpecPageView.svelte:846-856`）
  只展示固定标题 "Note" 和 `body`，没有把引用片段（`quote`/行号）渲染出来，
  用户在 Discussion 面板里看不到笔记具体对应文档的哪一段。
- 创建请求体（`SpecPageView.svelte:328-331`，`POST /api/notes`）也没有携带任何
  身份信息。

## Scope

- 在 `DocumentNote` 类型中新增作者/来源字段：
  - `created_by: string | null` — 用户标识（当前 SpecOps 会话/登录态可获取到的
    用户名或标识；无法获取时为 `null`，但字段必须存在）。
  - `source: 'ui' | 'agent' | 'api'` — 笔记创建渠道，默认 `'ui'`。
- 在 `POST /api/notes` 请求/响应中传递并持久化上述字段。
- 在 `SpecPageView.svelte` 的 Discussion 面板笔记卡片中，展示：
  - 创建者（`created_by`，缺失时显示 "Unknown"）。
  - 引用的文档片段：`quote` 文本 + `line_start`-`line_end` 行号（若存在），
    使标题不再固定写死 "Note"，而是带上下文的摘要。
- 更新 `apps/specops/tests/notes.test.ts` 覆盖新增字段的创建、持久化、序列化。
- 更新相关文档（如有必要，补充到 spec 或本 change 的 `design.md`）。

## Acceptance criteria

- [ ] `DocumentNote` 接口新增 `created_by` 和 `source` 字段，且 `schema_version`
      按需要递增（如从 1 升级为 2）并在读取旧版本笔记文件时做兼容处理
      （缺失字段时回填默认值，不报错）。
- [ ] `createDocumentNote()` 接受并写入 `created_by` / `source` 参数。
- [ ] `POST /api/notes` 请求体支持传入 `created_by`；若未提供则回退为已知的
      当前用户上下文（若有）或 `null`。
- [ ] `GET /api/notes` 返回的 `DocumentNote` 包含新增字段。
- [ ] `SpecPageView.svelte` 的笔记卡片渲染出创建者和引用的文档片段
      （`quote` + 行号范围），不再是纯 "Note" + `body`。
- [ ] `apps/specops/tests/notes.test.ts` 新增/更新用例验证新增字段的写入与读取。
- [ ] `pnpm test`（`apps/specops`）通过。

## Out of scope

- 不引入完整的用户认证/登录体系；`created_by` 只使用当前 SpecOps 已有的、
  可获取的用户/会话标识，若当前架构完全没有身份概念，则先落地字段与展示逻辑，
  身份来源接入作为后续独立工作。
- 不实现笔记的编辑历史（多次编辑追踪 `updated_by`）；本次只解决“谁创建”和
  “引用了文档哪部分”两个问题。
- 不修改 `resolve` / `deprecate` 状态机逻辑。
- 不涉及 GUI（`apps/gui`）终端侧的任何改动，仅限 `apps/specops`。

## Constitution conflicts

无冲突。本变更仅限于 `apps/specops`（SpecOps 控制台），未触及
`crates/kode-core` PTY 生命周期、backend 默认参数、或 SpecOps Run 隔离机制，
不违反 `.specops/constitution.md` 中列出的任一不变量。
