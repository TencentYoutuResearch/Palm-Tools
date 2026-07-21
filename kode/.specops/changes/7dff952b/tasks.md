# Tasks

- [ ] 复核现状:`grep -c "gui-dark-mode-tab-grid-bg\|terminal-bg-isolation" .specops/state/registry.json .specops/state/SPEC-LINKS.md` 应为 0,确认仍然孤立。
- [ ] 运行 SpecOps `scan` 命令重生成索引(`specops.list-documents` 技能 / `apps/specops/src/domain/commands.ts:382-431` 的 scan 实现);**不手工编辑 registry.json / SPEC-LINKS.md**。
- [ ] 确认 scan 过程无 error 级 diagnostics —— 否则 `commands.ts:416` 的守卫会跳过落盘,索引不会更新;若有 error,先修对应文档再重跑。
- [ ] 校验 `registry.json`:`documents[]` 含 `gui-dark-mode-tab-grid-bg`(kind `bug`,带 files[])与 `terminal-bg-isolation`(kind `spec`)两条;`generated_at` 已刷新到本次时间。
- [ ] 校验 `SPEC-LINKS.md`:Canonical documents 列表出现 `- [gui-dark-mode-tab-grid-bg](.specops/changes/gui-dark-mode-tab-grid-bg)`。
- [ ] 跑 `pnpm test`(cwd `apps/specops`,即 `verify.specops`)确认绿。
- [ ] (可选)提交时把重生成后的 registry.json / SPEC-LINKS.md 一并纳入,避免再次出现「变更已提交但索引未同步」的孤立。
