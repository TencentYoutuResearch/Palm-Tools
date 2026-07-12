---
schema_version: 1
id: specops-composer-ime-enter-guard
kind: bug
title: SpecOps 输入框在 IME 组合期回车误发送消息
status: completed
verifies:
  - specops
paths:
  - apps/specops/frontend/src/components/chat/Composer.svelte
  - apps/specops/frontend/src/components/iwiki/AskFloat.svelte
---

# SpecOps 输入框在 IME 组合期回车误发送消息

## Motivation

用户原话:

> 对话框在中文或者其他输入有提示框的情况下按回车不要直接发送消息,回车只是把中文输入框内容输出,你看看怎么优化下

(用户补充澄清:主要是指 specops。)

SpecOps Web 控制台有两个 `<textarea>` 输入框,用户在里面用中文(或任何 IME)打字时,IME 会弹出
候选提示框。用户按 Enter 的本意是**确认 IME 候选词**(把组合中的中文输出到输入框),但当前代码把这个
Enter 当成"发送消息",导致消息被提前发送 —— 内容要么是空的、要么是半截拼音。

根因:两个 `<textarea>` 的 `onkeydown` 处理器只检查了 `e.key === 'Enter' && !e.shiftKey`,
**没有检查 `e.isComposing`**。IME 组合进行中,确认候选的那个 keydown 事件:
`e.key === 'Enter'`(IME 用 Enter 键确认候选),且 `e.isComposing === true`(组合尚未结束)。
当前代码无视 `isComposing`,直接 `preventDefault()` + `send()`/`submit()`,把消息发了出去。

全仓搜索 `apps/specops/` 确认:**没有任何 `isComposing` / `compositionstart` / `compositionend` /
`keyCode === 229` 处理**,这是普遍缺失。

两处受影响代码:

| 组件 | 文件 | 行 | 发送动作 |
|---|---|---|---|
| 主聊天输入框 | `apps/specops/frontend/src/components/chat/Composer.svelte` | 137 | `send()` → `api.post('/api/sessions/:id/input')` |
| "新建对话"浮层 | `apps/specops/frontend/src/components/iwiki/AskFloat.svelte` | 145 | `submit()` → `api.post('/api/intakes' \| '/api/clarifies')` |

## Scope

修复范围限定在 SpecOps 前端两个 `<textarea>` 的 `onkeydown` 守卫,不引入新依赖、新状态机、新测试基建。

### In-scope 改动

1. **`Composer.svelte:137`** —— 主聊天输入框 `onkeydown` 守卫增加 `&& !e.isComposing`。
2. **`AskFloat.svelte:145`** —— "新建对话"浮层输入框 `onkeydown` 守卫增加 `&& !e.isComposing`。

修复后:IME 组合中的 Enter 不再触发 `send()`/`submit()`,而是让浏览器默认行为把候选词提交进
textarea 的文本里;用户再按一次 Enter(此时 `isComposing === false`)才真正发送。

### Out of scope

- `apps/gui/` 的 xterm.js 终端 IME 处理(`Terminal.svelte:480` 已有 `isComposing` 守卫,且走的是
  xterm 内部 `_keyDown` 路径,不是本次报告的 bug)。
- `apps/gui/src/lib/*.svelte` 的其它对话框(BackendChooser / RenameDialog / CommandPalette 等)
  —— 这些是 GUI 桌面端,用户明确说"主要是指 specops",不扩大范围。
- `apps/specops/frontend/src/components/iwiki/SpecPageView.svelte` 的三个 textarea(无 `onkeydown`,
  只用发送按钮,无此 bug)。
- 新增前端组件测试框架 / IME 自动化测试 —— 当前 `apps/specops/tests/` 只有 server 级集成测试,
  引入前端测试 harness 是独立的、更大的工作,不在本次 bugfix 范围内。

## Acceptance criteria

- [ ] 在 SpecOps Web 控制台主聊天框(`Composer`)输入中文拼音,候选提示框出现时按 Enter,
      候选词被写入 textarea,`/api/sessions/:id/input` **不被调用**,消息不发送。
- [ ] 候选确认后(无 IME 提示框状态)再按 Enter,消息正常发送。
- [ ] Shift+Enter 仍然换行,不受影响。
- [ ] `AskFloat` 浮层(intake / plan / clarify / doc 四种模式)同样行为:IME 组合期 Enter 不创建
      session,候选词进 textarea;组合结束后再按 Enter 才提交。
- [ ] `pnpm test`(cwd=`apps/specops`)通过,无回归。

## Out of scope

- GUI 桌面端任何 IME 相关改动。
- 引入前端组件测试基建(如 vitest + @testing-library/svelte + jsdom 模拟 IME 事件)。
- 统一所有 SpecOps 输入框的键盘处理(本次只改有 bug 的两处)。
- IME 候选框的视觉样式或定位调整。

## Constitution conflicts

无。`.specops/constitution.md` 的 invariants(PTY lifecycle 独立句柄、backend 默认参数无 positional、
SpecOps run 在独立 worktree 隔离)均与前端输入框键盘处理无关。"GUI 终端渲染独立于 SpecOps 控制台渲染"
这一条恰好支持本次只改 SpecOps 前端、不触碰 GUI terminal 的边界划分。
