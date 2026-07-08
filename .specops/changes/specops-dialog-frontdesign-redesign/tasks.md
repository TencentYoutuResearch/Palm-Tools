# Tasks

- [ ] **task-1-extract-dialog-skeleton**:在 `apps/specops/src/server/public/styles.css` 末尾加共用 dialog 骨架类 `.sp-overlay/.sp-sheet/.sp-head/.sp-body/.sp-foot`,只复用现有 design tokens(不引入新 token、不加 emoji、不写 hardcode 颜色)
- [ ] **task-2-create-overlay-scroll**:`.create-sheet` 改 `display:flex; flex-direction:column; max-height:90vh`;`.create-body` 加 `flex:1; overflow-y:auto; min-height:0`;`.create-footer` 加 `flex-shrink:0` 维持 sticky by structure
- [ ] **task-3-clarify-panel-align**:`.clarify-transcript` max-height 改成 `clamp(160px,32vh,360px)`;`.clarify-panel` 用 flex column,gap 与 `.sp-body` 视觉对齐;`.clarify-buttons` 改竖排(`flex-direction:column; gap:6px`)
- [ ] **task-4-run-panel-sticky-actions**:在 `index.html` 把 `#composer-actions` 和 `#session-composer` 从 `.run-panel-body` 内移到 `.run-panel` 下与 `.run-panel-body` 同级的 `.run-panel-actions`;CSS 给 `.run-panel-actions` `flex-shrink:0; border-top:1px solid var(--bd-default); padding:8px 10px; background:var(--bg-card)`
- [ ] **task-5-vertical-option-stack**:`app.js::renderComposerActions` 改输出 `.composer-option-row`(每行 label + 描述? + button,`display:flex; flex-direction:column; gap:4px`);AskUserQuestion 每个选项一行;plan markdown 走 `.composer-plan-row`(无 button),Approve/Revise 各占一行;verify/review/apply/recovery chips 全部竖排
- [ ] **task-6-action-card-styles**:补 `.action-card/.action-title/.action-copy/.action-buttons` 样式,与 dialog 骨架视觉一致;`cli_error_decision` 的按钮走竖排
- [ ] **task-7-dom-tests**:在 `apps/specops/tests/console-assets.test.ts` 加断言:create-sheet 是 flex column + body overflow;`#composer-actions` 在 `.run-panel-actions` 下;`renderComposerActions` 在七种 required_action(answer/plan_review/verify/review/apply_patch/applying/applied_failed)下输出竖排 `.composer-option-row`
- [ ] **task-8-visual-verify**:本地启动 specops webapp 手测三种路径 — Create Overlay 长 prompt + clarify Q&A 多轮;session 面板 plan_review 长 plan markdown;AskUserQuestion 4 选项竖排
