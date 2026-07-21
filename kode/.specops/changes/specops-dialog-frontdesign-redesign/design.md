# Design — SpecOps 对话框 frontdesign 重构

## 关键决策

### 决策 1:抽共用 `.sp-*` 骨架,而不是逐处加 overflow

`apps/specops/src/server/public/styles.css` 当前没有任何共用 dialog 基类,`.create-overlay` 是事实上的 dialog 模板但只此一处。Session Status 不是 modal 而是常驻侧栏,不能直接套同一 class。

抽出 `.sp-*` 作为视觉规范,Create Overlay 和未来可能的 dialog 直接复用;Session Status 用 `.run-panel-actions` 这一专用 sticky footer 概念对齐思路,不强行套 `.sp-sheet`。

**Trade-off**:多一层概念,但避免把"模态 sheet"语义塞进常驻面板造成后续误读。

### 决策 2:`.create-sheet` 改 flex column + max-height,而不是给 `.create-body` 单独写 overflow

```css
.create-sheet {
  display: flex;
  flex-direction: column;
  max-height: 90vh;
  /* 已有 border/radius/background/shadow 保留 */
}
.create-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.create-footer {
  flex-shrink: 0;
  /* 已有 padding/border-top 保留 */
}
```

flex column + `max-height:90vh` + body `flex:1; overflow-y:auto` + footer `flex-shrink:0` 是最稳的 sticky-footer-by-structure 模式,不依赖 `position:sticky`,跟现有 `--sh-modal` 阴影配合无割裂。

**Trade-off**:viewport 极矮(<400px)时 sheet 会变很挤,但 SpecOps webapp 本身是桌面工具,可接受。

### 决策 3:AskUserQuestion 选项竖排成 row,而不是改回原 chips

用户原话「换行依次展示,不要平铺」明确要竖排。每行结构:

```
.composer-option-row
├── .composer-option-label  (opt.label)
├── .composer-option-desc?  (opt.description,可选)
└── button.run-btn.accept-btn  (单选/多选统一行式)
```

对齐 codebuddy/claude 原生 AskUserQuestion 弹窗的竖排选项观感,也方便后续给每行加描述/图标。

**Trade-off**:选项多时会变长 — 由 sticky footer + body scroll 兜底。

### 决策 4:plan_review 的 plan markdown 跟 Approve/Revise 一起走竖排,不再让 plan 单独 240px 滚

plan 块自己在小窗里滚 + 外面 chips 平铺,视觉割裂。改成:

- plan markdown 作为 `.composer-plan-row`(无 button,沿用 `.chat-bubble` 样式,移除 240px max-height 改为随外层 body 滚动)
- Approve/Revise 作为两个 `.composer-option-row`(各带 button)竖排在外层 body scroll 里

plan markdown 很长时会占满 body 高度 — 由 `.run-panel-body` 的 `flex:1; overflow-y:auto` 兜底,composer-actions 走 sticky footer 仍可见。

**关键**:Approve/Revise 放 inline row(随 body 滚),不放 sticky footer。因为它们是 plan_review 的"主动作"而非全局动作;sticky footer 留给 composer 输入区(Send/Stop)。

### 决策 5:不动 `app.js` selector,只改 DOM 结构

`app.js` 大量用 `document.querySelector('#composer-actions')` / `#session-composer` / `#action-card`。移动 DOM 位置但保留 id,避免连锁改动。

**Trade-off**:DOM 树跟原本的 HTML 文档结构不完全对齐(原 HTML 里 composer-actions 是 `.run-panel-body` 子节点),但 selector 不变 = 回归风险低。`console-assets.test.ts` 已有的断言(如 `expect(indexHtml).toContain('id="composer-actions"')`)仍能通过。

### 决策 6:frontdesign token 来源不动,沿用现有 SpecOps-only `--st-*-soft`

复用 `--acc/--acc-soft/--fg-on-accent` 做主动作按钮,`--st-warn-soft/--st-err-soft/--st-info-soft` 做次级状态色,不引入新 token,不写 hardcode 颜色。Token 来源:`apps/gui/index.html :root`(source of truth)→ 已 mirror 到 `apps/specops/src/server/public/styles.css:9-99`。

## 完整 CSS 新增段落(伪代码)

```css
/* === SpecOps Dialog Skeleton (frontdesign) === */
.sp-overlay { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 24px; background: var(--bg-modal-backdrop); backdrop-filter: blur(12px) saturate(0.7); }
.sp-sheet { display: flex; flex-direction: column; max-height: 90vh; border: 1px solid var(--bd-strong); border-radius: var(--rad-lg); background: var(--bg-elevated); box-shadow: var(--sh-modal); overflow: hidden; }
.sp-head { flex-shrink: 0; display: flex; align-items: flex-start; justify-content: space-between; padding: 20px 20px 16px; background: var(--bg-card); border-bottom: 1px solid var(--bd-default); }
.sp-body { flex: 1; overflow-y: auto; min-height: 0; padding: 18px 20px; }
.sp-foot { flex-shrink: 0; display: flex; align-items: center; gap: 8px; justify-content: flex-end; padding: 14px 20px; border-top: 1px solid var(--bd-default); background: var(--bg-sidebar); }

/* Create Overlay 复用骨架 */
.create-sheet { /* 改成 flex column max-height:90vh */ }
.create-body { /* 加 flex:1; overflow-y:auto; min-height:0 */ }
.create-footer { /* 加 flex-shrink:0; gap:8px */ }

/* Clarify 面板 */
.clarify-panel { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 10px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); }
.clarify-transcript { max-height: clamp(160px, 32vh, 360px); overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.clarify-buttons { display: flex; flex-direction: column; gap: 6px; }

/* Session Status sticky actions footer */
.run-panel { /* 已有 flex column */ }
.run-panel-body { /* 已有 overflow-y:auto, 移除 composer-actions/composer 子节点后更纯净 */ }
.run-panel-actions { flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--bd-default); background: var(--bg-card); }

/* Vertical option rows (composer-actions 输出) */
.composer-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 0; }  /* 不再 wrap */
.composer-actions:empty { display: none; }
.composer-option-row { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-elevated); }
.composer-option-row:hover { border-color: var(--acc); background: var(--acc-soft); }
.composer-option-label { font: var(--fw-med) var(--fs-md)/1.3 var(--font-ui); color: var(--fg-primary); }
.composer-option-desc { font: var(--fw-reg) var(--fs-sm)/1.4 var(--font-ui); color: var(--fg-secondary); }
.composer-option-row .run-btn { align-self: flex-start; }
.composer-plan-row { flex-basis: 100%; max-width: 100%; /* 移除 240px max-height, 随 body 滚 */ }

/* Action Card 基础样式 */
.action-card { padding: 10px 12px; margin-top: 8px; border: 1px solid var(--bd-default); border-left: 3px solid var(--st-info); border-radius: var(--rad-md); background: var(--bg-elevated); }
.action-title { font: var(--fw-semi) var(--fs-md)/1.3 var(--font-ui); color: var(--fg-primary); }
.action-copy { font: var(--fw-reg) var(--fs-sm)/1.5 var(--font-ui); color: var(--fg-secondary); margin-top: 4px; }
.action-buttons { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
```

## `renderComposerActions` 改造后的伪代码

```js
function renderComposerActions(session, run) {
  const stack = document.querySelector('#composer-actions')
  stack.replaceChildren()
  const action = session?.required_action
  const phase = session?.phase
  const runState = run?.state

  const addOptionRow = (label, desc, btnClass, onClick) => {
    const row = el('div', 'composer-option-row')
    const lab = el('span', 'composer-option-label'); lab.textContent = label; row.append(lab)
    if (desc) { const d = el('span', 'composer-option-desc'); d.textContent = desc; row.append(d) }
    const btn = el('button', `run-btn ${btnClass}`); btn.type = 'button'; btn.textContent = 'Select'
    btn.addEventListener('click', async () => { try { await onClick() } catch (e) { showError(e) } })
    row.append(btn)
    stack.append(row)
  }
  const addActionButton = (label, btnClass, onClick) => {
    // 单按钮 row, 无 label/desc
    const row = el('div', 'composer-option-row')
    const btn = el('button', `run-btn ${btnClass}`); btn.type = 'button'; btn.textContent = label
    btn.addEventListener('click', async () => { try { await onClick() } catch (e) { showError(e) } })
    row.append(btn)
    stack.append(row)
  }

  if (action?.kind === 'answer' && Array.isArray(action.options)) {
    if (action.prompt) {
      const q = el('div', 'composer-question'); q.textContent = action.prompt; stack.append(q)
    }
    action.options.forEach((opt, idx) => {
      addOptionRow(opt.label, opt.description, 'accept-btn', async () => {
        await api(`/api/sessions/${session.id}/answer`, { method: 'POST', body: JSON.stringify({ question_id: action.question_id, choice_index: idx, label: opt.label }) })
        if (activeSession) await openSession(activeSession.id)
        await refreshSessionsOnly()
      })
    })
  }
  if (action?.kind === 'plan_review') {
    if (action.markdown) {
      const planBox = el('div', 'composer-plan-row chat-bubble')
      renderMarkdownInto(planBox, action.markdown)
      stack.append(planBox)
    }
    addActionButton('Approve plan', 'accept-btn', async () => { /* … 原 handler … */ })
    addActionButton('Revise', 'ghost-btn', async () => { /* … 原 handler … */ })
  }
  // verify / review / apply_patch / applying / applied_failed
  // — 全部走 addActionButton 单行竖排
}
```

## 风险与回归点

1. **已有 `console-assets.test.ts` 断言**:`expect(indexHtml).toContain('id="composer-actions"')` / `expect(appScript).toContain("api('/api/sessions')")` — 保留 id 和 api 调用即不破坏。
2. **DOM 位置变化**:`#composer-actions` 从 `.run-panel-body` 子节点移到 `.run-panel-actions` 子节点。`app.js` 用 `querySelector` 而非相对父查找,无影响。
3. **plan markdown 移除 240px 内部 scroll**:plan 极长时会撑长 `.run-panel-body` 滚动区 — 这是预期行为(用户要的就是"统一在对话框里滚"),sticky footer 仍可见。
4. **CSS 体积**:新增 ~30 行骨架类 + ~15 行 option-row 样式,无体积压力。
