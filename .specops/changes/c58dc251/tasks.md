# Tasks

> 本条目是 investigation,任务即「调查动作」,已全部完成(见下方勾选)。
> 修复动作刻意留空 —— 修复需独立立项 + 审批,不在本调查内执行。

## 调查(已完成)

- [x] 在 `.specops/changes` 下定位 "dark gui" 对应变更:`gui-dark-mode-tab-grid-bg`。
- [x] 读 proposal.md / tasks.md / design.md / specs/terminal-bg-isolation/spec.md,确认文档结构完整。
- [x] 查 intake 收据 `01f7c58e-...json`:`status=completed`,primary 正确。
- [x] `git log`/`git show` 确认变更在 HEAD `8ab8aaa` 入库,时间 2026-06-29 21:19 +0800。
- [x] grep `registry.json` + `SPEC-LINKS.md`:确认 `gui-dark-mode-tab-grid-bg` 与 `terminal-bg-isolation` **均不在索引内**。
- [x] 比对 registry `generated_at`(11:59:03Z)与变更提交时间,确认索引为变更落盘前的旧快照。
- [x] `git show HEAD --name-only` 确认添加变更的提交未同步重生成索引。
- [x] 比对 proposal 引用的 `App.svelte` / `Terminal.svelte` 行号与当前源码,确认内容未过时。

## 修复(不在本调查范围 —— 需独立 change + 审批)

- [ ] (后续 change)重生成 `registry.json` 与 `SPEC-LINKS.md`,纳入 `gui-dark-mode-tab-grid-bg` 与 delta spec `terminal-bg-isolation`。
- [ ] (后续 change)确立「改 .specops/changes|specs 的提交须同提交重生成索引」的规约,防止再次漂移。
