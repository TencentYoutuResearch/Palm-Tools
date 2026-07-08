# Design — Create Overlay 提交后自动关闭

## 关键决策

### 决策 1:close 紧贴在 POST 成功之后,而不是在轮询就绪分支里

当前 `closeCreateForm()` 调用位置:

- direct intake:`app.js:1393`(在 `startIntakePolling` 内部,文档就绪分支)
- plan-first:`app.js:1525`(在 `startPlanIntakePolling` 内部,文档就绪分支)

新位置:**POST 成功返回之后立即调** — 在 `if (result.specops_session) showSession(result.specops_session)` 和 `await refreshSessionsOnly()` 之后,`startIntakePolling(result.intake_id)` / `startPlanIntakePolling(result.intake_id)` 之前。

**Trade-off**:这意味着文档没就绪前用户已经看不到轮询进度。但这本来就是后台异步任务 — session 面板(`showSession(result.specops_session)` + `refreshSessionsOnly()`)已经把进度展示在主界面了,模态框没必要继续挡住屏幕。用户可以从 session 面板继续观察进度。

### 决策 2:Clarify 模式不动

Clarify 模式 POST 成功后调 `showClarifyPanel(true)`,clarify 对话 transcript 就在这个模态框里:

```
<div class="clarify-panel" id="clarify-panel" hidden>
  <div class="clarify-transcript" id="clarify-transcript"></div>
  <textarea id="clarify-answer" ...></textarea>
  <div class="clarify-buttons">
    <button id="clarify-answer-btn">Send answer</button>
    <button id="clarify-promote-btn">Start intake</button>
  </div>
</div>
```

关掉模态框就等于关掉 clarify 对话 — 用户无处答问题。所以 clarify 模式必须保持打开,直到用户点 "Start intake" promote 进 intake 流程(promote 之后的 close 行为由现有 promote handler 决定,本变更不动)。

**Trade-off**:用户请求字面是"输入完之后就关闭",对 clarify 模式不适用 — 因为 clarify 的"输入"是 clarify answer,不是最外层 "What should change?" textarea。本变更只关最外层那次提交,clarify 内部的多轮问答不在 scope。

### 决策 3:轮询内部的 closeCreateForm() 保留作 no-op

`startIntakePolling`(`app.js:1375-1408`)和 `startPlanIntakePolling`(`app.js:1498-...`)的文档就绪分支里已有 `closeCreateForm()`。改成 POST 后立即 close 之后,这两处调用变成 no-op(模态框已关)。**保留**而不是删除,理由:

- 防御性:万一未来有人在 POST 成功和 `startIntakePolling` 之间插一段异步操作把模态框重新打开,这两处 close 仍能兜底
- 副作用安全:`closeCreateForm()`(`app.js:1249-1259`)只做 `hidden=true` / `createError.hidden=true` / `createSubmit.disabled=false` / label 复位 / 清 clarify timer — 对已关闭的模态框再调一次没有副作用

`createSubmit.disabled = false` 和 submit label 重置行也保留(不挪到 `closeCreateForm` 内部统一处理),因为:

- 现有代码这么写,改动最小
- `#new-spec` click handler(`app.js:1261-1276`)已经做了开模态框时的重置,这两处重置是冗余但不冲突
- 把重置挪进 `closeCreateForm()` 是合理优化但超出本变更的最小改动原则 — 留给后续 refactor

### 决策 4:DOM 测试用 fake api,不真打网络

`apps/specops/tests/console-assets.test.ts` 已有 DOM 测试模式。新增测试组在 jsdom 里 load `index.html` + `app.js`,monkey-patch `window.fetch` 或模块导出的 `api` 函数返回 fake response,模拟三种 mode 的 POST 成功/失败,断言 `#create-overlay.hidden` 和 `#clarify-panel.hidden`。

**Trade-off**:这测的是行为契约(POST 成功 → 模态框关),不是端到端 — 不打真 `/api/intakes`。对回归保护足够,CI 不依赖后端。
