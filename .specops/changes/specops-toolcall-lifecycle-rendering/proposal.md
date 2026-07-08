---
schema_version: 1
id: specops-toolcall-lifecycle-rendering
kind: change
title: 关联 SpecOps session toolcall 生命周期并渲染结果
status: completed
verifies:
  - specops
paths:
  - apps/specops/frontend/src/components/chat
  - apps/specops/frontend/src/lib
  - apps/specops/tests
---

# 关联 SpecOps session toolcall 生命周期并渲染结果

## Motivation

用户原始请求：

> specops session里面的toolcall需要前后关联，把running和后续ok这两种状态关联在一起 ok后把json内容渲染出来，你看看怎么融合实现下

SpecOps session transcript 当前已经把工具调用拆成 `tool_use` 和 `tool_result` 两类条目，并通过 `tool_call_id` 提供逻辑关联能力：`tool_use` 表示工具开始调用，状态通常是 `running`；`tool_result` 表示工具完成，状态为 `ok` 或 `error`，并携带 `preview`。

问题在于前端仍按 flat transcript 逐条渲染，导致一次工具调用被拆成两个独立卡片：一个 `running` 卡片和一个后续结果卡片。用户无法一眼看出二者属于同一次 toolcall，也无法在调用完成后自然地查看 JSON 结果。

本变更要把同一 `tool_call_id` 的 `running` 和后续 `ok` / `error` 融合为一个工具调用生命周期视图，在结果到达后于同一卡片内渲染 JSON / KV / text preview。

## Scope

### In scope

- 在 SpecOps 前端 session transcript 渲染层按 `tool_call_id` 关联 `tool_use` 与 `tool_result`。
- 将关联后的工具调用显示为一个统一 ToolCard：头部展示工具名、summary、最终状态；展开后展示结果 preview。
- 复用现有 `parseToolPreview()` 解析 JSON / KV / text；JSON 用格式化形式渲染。
- 保留兼容性：未完成的 `tool_use` 仍显示 `running`；孤立或旧数据中的 `tool_result` 仍可单独显示结果。
- 为配对逻辑和结果渲染相关路径补充测试。

## Out of scope

- 不修改 `crates/kode-core` / `crates/kode-bridge` 的工具调用解析。
- 不修改 SpecOps server transcript API 或 session 持久化格式。
- 不修改 GUI PTY/xterm 终端渲染。
- 不改变 SpecOps run isolation、worktree、verify/apply 流程。
- 不处理协议级交互卡片（AskUserQuestion / ExitPlanMode / TaskCreate / TaskUpdate），这些已有独立展示逻辑。

## Acceptance criteria

- 同一 `tool_call_id` 的 `tool_use(running)` 与 `tool_result(ok/error)` 在 SpecOps session 中显示为一个工具调用卡片。
- `tool_result.status === "ok"` 后，展开卡片能看到 JSON preview 的格式化渲染；KV/text preview 保持可读。
- 未完成工具调用仍显示 `running`，不会因为缺少 result 而消失。
- 孤立 `tool_result`、无 `tool_call_id` 的旧数据、普通 text transcript 条目继续正常渲染。
- 不改变 server transcript API，不影响 SpecOps run isolation 和 GUI terminal 渲染。
- `verify.specops` 通过。

## Constitution conflicts

未发现冲突。本变更只调整 `apps/specops` 前端 console 的 transcript 展示层，不触碰 constitution 中的 PTY child lifecycle、backend default args、SpecOps run isolation 三个硬约束，也不把 SpecOps console 渲染耦合到 GUI terminal 渲染。
