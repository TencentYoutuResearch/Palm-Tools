---
schema_version: 1
id: specops-create-overlay-close-on-submit
kind: feature
title: Create Overlay 提交后自动关闭 — "What should change?" 对话框
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/server/public/app.js
  - apps/specops/tests/console-assets.test.ts
---

# Create Overlay 提交后自动关闭 — "What should change?" 对话框

用户请求(原文):

> specops 里面对话What should change? 输入完之后就关闭吧

## Motivation

SpecOps webapp 的 Create Overlay(`apps/specops/src/server/public/index.html:175-245` 的 `#create-overlay`)是 "What should change?" 模态框。`apps/specops/src/server/public/app.js:1286` 的 submit handler 当前**只在 direct intake 文档就绪后**(`app.js:1393`)和**plan-first 文档就绪后**(`app.js:1525`)才调 `closeCreateForm()`。

三种 create mode 行为:

1. **Direct intake**(`app.js:1353-1373`):点 "Analyze request" → POST `/api/intakes` 成功后开始 `startIntakePolling`,模态框**保持打开**,直到 2.5s 轮询拿到文档才关。期间用户被锁在模态框里,既看不到刚出现的 session 面板,也无法操作左侧文档列表。
2. **Plan-first**(`app.js:1301-1322`):POST `/api/intakes?pre_plan=true` 成功后开始 `startPlanIntakePolling`,同样锁住模态框,即使 plan 已经 draft 好等用户去 session 面板 review,模态框还在屏幕上。
3. **Clarify**(`app.js:1324-1351`):POST 成功后调 `showClarifyPanel(true)` 进入 clarify 对话阶段 — 这个**需要保持模态框打开**,因为 clarify 对话就在模态框里进行。

用户的痛点是 1 和 2:**提交完一个分析请求后,模态框不应该继续挡住屏幕**。session 已经在右侧/底部列表出现了,继续留在 "What should change?" 模态框里是无效等待 — 用户既看不到后台进度,也做不了别的。

Clarify 模式排除在外,因为它的 clarify 对话面板就在这个模态框里,关掉就无处对话了。

## Scope

### In scope

1. **Direct intake 模式**(`app.js:1353-1373`):POST `/api/intakes` 成功后(`if (result.specops_session) showSession(result.specops_session)` 之后、`await refreshSessionsOnly()` 之后)立即调 `closeCreateForm()`,再 `startIntakePolling(result.intake_id)`。轮询拿到文档后通过 `refresh()` 在后台列表里高亮新文档(已有的逻辑保留)。
2. **Plan-first 模式**(`app.js:1301-1322`):POST 成功后同样立即调 `closeCreateForm()`,再 `startPlanIntakePolling(result.intake_id)`。Plan review 在 session 面板里继续做,不在模态框里做。
3. **Clarify 模式保持不变**:POST 成功后仍然 `showClarifyPanel(true)` + 保留模态框,等用户答完问题 → 点 "Start intake" 走 promote 流程。promote 之后的 intake 轮询是否关闭由 promote handler 的现有行为决定,本变更不动。
4. **轮询逻辑清理**:`startIntakePolling`(`app.js:1375-1408`)和 `startPlanIntakePolling`(`app.js:1498-...`)里的 `closeCreateForm()` 调用保留作为防御性 no-op(模态框已关时再关一次无害),但 `createSubmit.disabled = false` 和 `submitLabel.textContent = 'Analyze request'` 这两行依然有用 — 因为下次打开模态框时 `#new-spec` click handler 会重置,留着不冲突;不过为了简洁,可以把这两个 submit-label 重置行移到 `closeCreateForm()` 内部统一处理(可选优化,不是必须)。
5. **DOM 测试** 在 `apps/specops/tests/console-assets.test.ts` 加断言:
   - 模拟 direct intake 提交成功(fake `api` 返回 `{ intake_id, session: { id }, specops_session }`),断言 `createOverlay.hidden === true`
   - 模拟 plan-first 提交成功,断言同上
   - 模拟 clarify 提交成功,断言 `createOverlay.hidden === false`(模态框仍开)且 `clarifyPanel.hidden === false`
   - 测试覆盖 #1/#2/#3 三种 mode

### Out of scope

- 不动 clarify 模式的 clarify 对话交互(POST `/api/clarifies` 之后的 `showClarifyPanel(true)` / `startClarifyPolling` 行为)
- 不动 promote-from-clarify 之后的 intake 轮询行为
- 不动后端 `/api/intakes` / `/api/clarifies` API
- 不动 Create Overlay 的样式、布局(那是 `specops-dialog-frontdesign-redesign` 已经覆盖的 scope)
- 不动 Session Status 面板的渲染
- 不引入新依赖、不引入新 design token
- 不动 TUI 侧 `apps/gui/src/`

## Acceptance criteria

1. Direct intake:点 "Analyze request" → API 成功返回 → 模态框立即关闭(`#create-overlay` `hidden === true`),后台轮询继续在 2.5s 间隔拉 `/api/intakes/<id>` 直到文档就绪,文档就绪后 `refresh()` + 高亮新文档(已有逻辑保留)
2. Plan-first:点 "Analyze request" → API 成功返回 → 模态框立即关闭,plan-first 轮询继续在后台跑,plan draft 好之后用户去 session 面板 review/approve
3. Clarify:点 "Analyze request" → API 成功返回 → 模态框保持打开,`#clarify-panel` 显示,transcript 出现 "Clarify session started..." 消息
4. 提交失败时(API 抛错)模态框保持打开,`#create-error` 显示错误,submit 按钮重新启用,label 复位 "Analyze request"(已有逻辑)
5. `pnpm --filter specops test` 全绿,新增 DOM 测试覆盖三种 mode 的 close-or-stay-open 行为

## Constitution conflicts

无。`.specops/constitution.md` 的三条 invariant(PTY lifecycle / backend default args / SpecOps run isolation)与这个 webapp 前端 UX 调整无关。`GUI terminal rendering is independent from SpecOps console rendering` 这条也被尊重 — 本变更只动 `apps/specops/src/server/public/`,不碰 `apps/gui/src/`。
