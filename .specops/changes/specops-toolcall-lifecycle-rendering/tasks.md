# Tasks

- [x] 实现 transcript toolcall 配对逻辑 `[verify: specops]`
  - 在 `AgentGroup.svelte` 或前端 `lib` 纯 helper 中，将 flat `TranscriptEntry[]` 转换成 display items。
  - 同一 agent group 内按 `tool_call_id` 将 `tool_use` 与对应 `tool_result` 配对。
  - 保持原始显示顺序，以 `tool_use` 的位置作为 paired card 的位置；已消费的 `tool_result` 不再重复渲染。
  - 对无 `tool_call_id`、孤立 `tool_use`、孤立 `tool_result` 保持兼容降级。

- [ ] 扩展 `ToolCard.svelte` 渲染完整生命周期 `[verify: specops]`
  - 支持接收可选的 result entry，或接收 paired display item。
  - 头部展示工具名、summary 与最终状态：无 result 时为 `running`，有 result 时使用 `ok` / `error`。
  - 展开区域优先渲染 result preview；未完成时显示无 preview 的 running 状态。
  - 复用 `parseToolPreview()`，JSON 结果用格式化 JSON 显示。

- [ ] 补��测试覆盖配对和 preview 渲染路径 `[verify: specops]`
  - 覆盖 `tool_use + tool_result(ok)` 的 1:1 配对。
  - 覆盖 `tool_use` 未完成、孤立 `tool_result`、无 `tool_call_id` 等兼容场景。
  - 保留现有 `parseToolPreview()` JSON / KV / text 行为。

- [ ] 验证 SpecOps 前端回归 `[verify: specops]`
  - 运行 `pnpm test`（cwd: `apps/specops`）。
  - 如实现触及 Svelte 组件类型，补跑项目现有前端类型检查或构建命令。
