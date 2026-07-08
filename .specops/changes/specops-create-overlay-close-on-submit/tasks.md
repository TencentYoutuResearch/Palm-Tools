# Tasks

- [ ] **task-1-direct-intake-close-on-submit**:在 `apps/specops/src/server/public/app.js` 的 direct intake 分支(约 1353-1373 行),把 `closeCreateForm()` 调用从 `startIntakePolling` 的就绪分支(约 1393 行)挪到 POST 成功之后立即调用 — 在 `if (result.specops_session) showSession(result.specops_session)` 之后、`await refreshSessionsOnly()` 之后、`startIntakePolling(result.intake_id)` 之前
- [ ] **task-2-plan-first-close-on-submit**:在 plan-first 分支(约 1301-1322 行),同样在 POST 成功之后(`if (result.specops_session) showSession(...)` + `await refreshSessionsOnly()` 之后)立即调 `closeCreateForm()`,再 `startPlanIntakePolling(result.intake_id)`
- [ ] **task-3-clarify-keep-open**:clarify 分支(约 1324-1351 行)不动 — 保持现有的 `showClarifyPanel(true)` + 不关模态框的行为;加一行注释说明为何不关("clarify 对话在模态框内进行,关闭会丢失对话")
- [ ] **task-4-polling-cleanup-noop**:`startIntakePolling` 和 `startPlanIntakePolling` 内部的 `closeCreateForm()` 调用保留(防御性 no-op,模态框已关时再关无害);`createSubmit.disabled = false` 和 submit label 重置保留(下次打开模态框时 `#new-spec` 已重置,此处保留不影响)
- [ ] **task-5-dom-tests**:在 `apps/specops/tests/console-assets.test.ts` 加测试组 `Create Overlay submit close behavior`:
  - direct intake 提交成功 → `createOverlay.hidden === true`
  - plan-first 提交成功 → `createOverlay.hidden === true`
  - clarify 提交成功 → `createOverlay.hidden === false` 且 `clarifyPanel.hidden === false`
  - direct intake 提交失败(API reject)→ `createOverlay.hidden === false` 且 `createError.hidden === false`
  - 用 fake `api`/fetch 注入,不真打网络
- [ ] **task-6-manual-verify**:本地启动 specops webapp,手测三种 mode — direct intake 提交后模态框立即关闭且 session 在列表出现;plan-first 同样;clarify 提交后模态框保持打开并显示 clarify panel
