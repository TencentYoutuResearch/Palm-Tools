# Tasks

- [ ] 在 `apps/specops/src/domain/notes.ts` 的 `DocumentNote` 接口新增
      `created_by: string | null` 和 `source: 'ui' | 'agent' | 'api'` 字段
- [ ] 更新 `createDocumentNote()` 签名，接受 `created_by` / `source` 参数并写入
      持久化的 JSON 文件
- [ ] 处理旧版本笔记文件（缺失新字段）的读取兼容：`listDocumentNotes()` /
      `setDocumentNoteStatus()` 中对缺失字段回填默认值
- [ ] 更新 `apps/specops/src/server/index.ts` 中 `POST /api/notes` 处理逻辑，
      读取请求体中的 `created_by`（如提供），否则使用可获取的默认身份或 `null`
- [ ] 更新 `SpecPageView.svelte` 提交笔记的请求体，附带当前可获取的用户/身份标识
- [ ] 更新 `SpecPageView.svelte` 笔记卡片渲染逻辑：显示创建者、引用的 `quote`
      文本与 `line_start`-`line_end` 行号范围
- [ ] 更新 `apps/specops/tests/notes.test.ts`，覆盖新增字段的创建、序列化、
      向后兼容读取
- [ ] 运行 `pnpm test`（`apps/specops`）确认全部通过
