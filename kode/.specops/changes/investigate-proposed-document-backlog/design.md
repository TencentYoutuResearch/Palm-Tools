# Design decisions

## 交叉验证方法

通过以下数据源交叉验证每个 proposal 的实际完成状态：

1. **Git log**：搜索与 proposal 主题匹配的 commit（如 `specops(plan):`、`specops(run):`、`feat:` 前缀）
2. **Session 文件**（`.specops/state/sessions/*.json`）：检查 `document_path` 字段是否指向某个 change folder
3. **Run 文件**（`.specops/state/runs/*/run.json`）：检查 run 是否 completed + merged
4. **Source code**：检查 proposal 描述的实现是否存在于当前代码中
5. **tasks.md**：检查哪些 task 已被勾选

### 信任优先级

- **Git merge commit > plan commit > tasks.md 勾选状态**
- 如果代码已合入 main，即使 tasks.md 未勾选，也认为工作**已完成**
- 如果只有 plan commit 没有 run commit，工作视为**部分完成**（设计已有，实施可能合入其他 commit）

## 为什么 11 个 proposal 已完成但状态未更新

| 原因 | 数量 | 示例 |
|---|---|---|
| 通过 `specops(plan):` commit 直接完成 | 5 | `fix-gui-status-bar-vertical-center`, `workspace-panel-expand-button` 等 |
| 通过 SpecOps Run 完成但 `proposed→completed` 未实现 | 3 | `fix-gui-remote-memory-not-visible`, `7dff952b`, `fix-specops-post-merge-status-transition` |
| 通过直接 commit 完成（无 run） | 3 | `fix-specops-session-expand-control-location`, `fix-specops-session-resume`, `specops-branch-based-apply` |

**核心原因**：`fix-specops-post-merge-status-transition` 直到 commit `75d07d1` → merge `1663010` 才合入，此前任何 Run 完成都不会更新 proposal 状态。

## 未来防护

`fix-specops-post-merge-status-transition` 已在 main 上，从此以后：
- 通过 SpecOps Run 完成的 change，apply 时自动 `proposed → completed`
- `RunRecord.change_id` 字段建立了 Run↔Change 的关联
- 但**直接 commit 完成的工作**（不经过 Run）仍不会自动更新 proposal 状态 — 需要开发者自觉维护
