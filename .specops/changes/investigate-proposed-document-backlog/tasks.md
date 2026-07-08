# Tasks

## Phase 1: 标记已完成的 proposals 为 completed

- [x] `fix-gate-errors-and-intake-ordering` → `status: completed`，勾选已完成 tasks
- [x] `fix-specops-session-expand-control-location` → `status: completed`
- [x] `workspace-panel-expand-button` → `status: completed`
- [x] `fix-gui-remote-memory-not-visible` → `status: completed`
- [x] `fix-specops-session-resume` → `status: completed`
- [x] `7dff952b` → `status: completed`
- [x] `c58dc251` → `status: completed`
- [x] `specops-branch-based-apply` → `status: completed`
- [x] `fix-specops-post-merge-status-transition` → `status: completed`

## Phase 2: 清理过时 proposal

- [x] 确认 `fix-migrate-docs-proposal-staleness` 在 `changes/archive/` 下有完整副本
- [x] active 目录下已无 `fix-migrate-docs-proposal-staleness`（此前已被移走）

## Phase 3: 更新部分完成的 proposals

- [x] `cleanup-specops-document-staleness` → 勾选已完成 tasks（Phase 1-2 archive 操作、Phase 5 constitution populate），保留 `proposed`
- [ ] `gui-dark-mode-tab-grid-bg` → CSS 修复未完全应用，保留 `proposed`
- [ ] `fix-gui-status-bar-vertical-center` → 无 run commit，保留 `proposed`

## Phase 4: 验证

- [x] `pnpm test`（apps/specops）全绿（147/147 passed）
- [ ] 确认 `registry.json` 反映新的 status 值
