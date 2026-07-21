---
schema_version: 1
id: specops-dialog-frontdesign-redesign
kind: feature
title: SpecOps 对话框 frontdesign 重构 — 按钮常驻、滚动入框、选项竖排
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/server/public/index.html
  - apps/specops/src/server/public/styles.css
  - apps/specops/src/server/public/app.js
  - apps/specops/tests/console-assets.test.ts
---

# SpecOps 对话框 frontdesign 重构 — 按钮常驻、滚动入框、选项竖排

用户请求:

> specops的对话框,下面的按钮内容要始终显示出来,滚动条在对话框里,你用frontdesign来优化设计下,尽量简洁明了。然后plan或者问答选择内容换行依次展示,不要平铺

## Motivation

SpecOps webapp(`apps/specops/src/server/public/`)三类对话框/动作区都有布局缺陷,核心症状是用户描述的「按钮被推走 + 内容平铺不换行」:

1. **Create Overlay 模态框**(`index.html:170-239`,`styles.css:1793-1958`)
   - `.create-sheet` 是 `overflow:hidden`,`.create-body` 没设 overflow
   - 当 prompt 长 + clarify Q&A 多轮时,整个 sheet 撑高超过 viewport,Cancel/Analyze 按钮被推出可视区
2. **Clarify 面板**(`index.html:214-222`,`styles.css:2065-2084`)
   - transcript 有内部 scroll,但 Send answer / Start intake 按钮被嵌入 `.create-body`
   - clarify 长起来同样会跟着撑长,连带把 create-footer 顶出可视区
3. **Session Status 面板里的 composer-actions**(`index.html:131`,`app.js:598-743`,`styles.css:1516-1543`)
   - AskUserQuestion 选项、Approve plan / Revise、Verify、Accept / Apply & Verify、Apply 全用 `display:flex; flex-wrap:wrap` 横向平铺成 chips
   - 这些 chips 又在 `.run-panel-body`(`overflow-y:auto`)的滚动区里,跟 transcript 一起滚,没有 sticky footer
   - plan markdown 用 `.composer-plan` 有 240px 内部 scroll,但 Approve/Revise chips 在它外面平铺,视觉割裂
4. **Action Card 完全无样式**(`index.html:127`,`app.js:889-931`):`.action-card` / `.action-title` / `.action-copy` / `.action-buttons` 在 styles.css 里没有任何规则,渲染成裸 block div

用户拍板的三条要求:
- 「下面的按钮内容要始终显示出来」→ sticky footer by structure
- 「滚动条在对话框里」→ body 内部 overflow,不在 sheet 上
- 「plan或者问答选择内容换行依次展示,不要平铺」→ 竖排,不要 flex-wrap

## Scope

### In scope

1. 抽共用 **dialog 骨架** CSS 类 `.sp-overlay / .sp-sheet / .sp-head / .sp-body / .sp-foot`,只复用现有 design tokens(`--acc/--acc-soft/--acc-hover/--fg-on-accent/--bg-card/--bg-elevated/--bd-default/--sh-modal/--st-warn-soft/--st-err-soft/--st-info-soft`),不引入新 token、不加 emoji、不写 hardcode 颜色
2. **Create Overlay** 改 flex column + `max-height:90vh` + `.create-body` `overflow-y:auto`,footer `flex-shrink:0` 维持在外部 — 滚动条出现在 body 内,Cancel/Analyze 永远可见
3. **Clarify 面板** transcript max-height 改成 `clamp(160px,32vh,360px)` 与骨架视觉对齐,answer 输入 + Send/Start intake 留在 transcript 外不滚
4. **Session Status 面板** 拆出 sticky footer:
   - 把 `#composer-actions` 从 `.run-panel-body` 内移到 `.run-panel` 下与 `.run-panel-body` 同级的 `.run-panel-actions`(sticky bottom)
   - `#session-composer` 也搬到 `.run-panel-actions`,跟 composer-actions 一起做 sticky footer
   - 保持 `app.js` 的 selector 不变(`#composer-actions` / `#session-composer` / `#action-card`)
5. **`renderComposerActions()` 重构** 改输出竖排 `.composer-option-row`,覆盖所有 required_action:
   - `answer` (AskUserQuestion):每个选项一行 `.composer-option-row > (.composer-option-label + .composer-option-desc? + button)`
   - `plan_review`:plan markdown 作为 `.composer-plan-row`(无 button)+ Approve plan / Revise 作为 `.composer-option-row`(各带 button)竖排
   - `verify` / `review` / `apply_patch` / recovery(`applying` / `applied_failed`):全部竖直堆叠的按钮行,不再 wrap chips
6. **Action Card** 补 `.action-card/.action-title/.action-copy/.action-buttons` 基础样式,`cli_error_decision` 的按钮也走竖排
7. **DOM 测试** 在 `apps/specops/tests/console-assets.test.ts` 加断言,覆盖:
   - create-sheet 的 flex column + body overflow 结构
   - `#composer-actions` 在 `.run-panel-actions` 下(不在 `.run-panel-body` 下)
   - `renderComposerActions` 输出竖排 `.composer-option-row`(七种 required_action)

### Out of scope

- 后端逻辑、API 路由、IPC 协议不变
- `app.js` 的状态机和事件 handler 逻辑不动,只改渲染输出 DOM 和 class
- TUI 侧 `apps/gui/src/App.svelte` 的 SpecOps 启动失败 toast(不在本次范围)
- 不引入 Svelte/React,仍用 vanilla JS + `el()` helper
- 不动 design tokens 数值本身
- 不动 SpecOps webapp 的 rail / workspace / masthead 布局
- 不引入新依赖

## Acceptance criteria

1. Create Overlay 模态框:输入 200 行 prompt + clarify 多轮 Q&A 后,Cancel / Analyze 按钮始终在 viewport 底部可见,滚动条出现在 `.create-body` 内
2. Clarify 面板:transcript 滚动条在 transcript 内,Send answer / Start intake 在 transcript 下方不滚动
3. Session Status 面板:plan_review 长 plan(>240px)时,Approve plan / Revise 仍可见;AskUserQuestion 4 个选项竖直堆叠展示,非横向 chips
4. Action Card(`cli_error_decision` 等)有完整视觉样式
5. `pnpm --filter specops test` 全绿,新增 DOM 测试覆盖七种 required_action(answer / plan_review / verify / review / apply_patch / applying / applied_failed)
6. 无新增 hardcode 颜色(仅 `--acc/--acc-soft/--acc-hover/--fg-on-accent/--bg-card/--bg-elevated/--bd-default/--sh-modal/--st-warn-soft/--st-err-soft/--st-info-soft` 等 tokens)

## Constitution conflicts

无。`.specops/constitution.md` 声明的三条 invariant(PTY lifecycle、backend default args、SpecOps run isolation)与本 UI 重构无关。`GUI terminal rendering is independent from SpecOps console rendering` 这条反而被尊重 — 本改动只动 SpecOps webapp,不碰 `apps/gui/src/` 的终端渲染。
