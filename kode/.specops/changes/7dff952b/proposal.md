---
schema_version: 1
id: 7dff952b
kind: bug
title: 修复 dark gui tab 变更「异常」——重生成 SpecOps 索引让其重新可见
status: completed
verifies:
  - specops
paths:
  - .specops/state/registry.json
  - .specops/state/SPEC-LINKS.md
  - .specops/changes/gui-dark-mode-tab-grid-bg
---

# 修复 dark gui tab 变更「异常」——重生成 SpecOps 索引让其重新可见

> 用户原始请求(逐字引用):
> "修复dark gui tab异常问题，changes里面已经提到了"

## Motivation

`changes` 里与 "dark gui tab" 相关的变更是 `.specops/changes/gui-dark-mode-tab-grid-bg`(《GUI 终端 tab 在 dark 模式下背景透出网格》)。它的「异常」**不在文档质量,而在它被孤立于 SpecOps 状态索引之外** —— 这一结论已由前一次 investigation `.specops/changes/c58dc251`(《排查 changes 里 dark gui 变更为何「异常」》)逐项核对确认。本次变更负责把那次诊断落地为修复。

经核对(2026-06-29),根因与证据如下:

1. **变更在磁盘与 git 都存在**:`.specops/changes/gui-dark-mode-tab-grid-bg/` 含 `proposal.md` / `tasks.md` / `design.md` 及 delta spec `specs/terminal-bg-isolation/spec.md`,且已随提交 `8ab8aaa`(2026-06-29 21:19 +0800)进入 git。

2. **索引里查无此项**:在 `.specops/state/registry.json` 与 `.specops/state/SPEC-LINKS.md` 中,对 `gui-dark-mode-tab-grid-bg` / `terminal-bg-isolation` 的检索**零命中**(本次重新核对仍为 0)。

3. **索引是变更落盘前的旧快照**:`registry.json` 的 `generated_at` 为 `2026-06-29T11:59:03.441Z`,**早于**变更被创建/提交的时间(约 13:19Z),且添加变更的那次提交**没有同时重生成索引**,此后从未重生成。

4. **后果**:registry / SPEC-LINKS 是 SpecOps console、gate、drift 分析器读取的权威索引(见 `apps/specops/src/domain/gate.ts:99` 直接从 `scan.data.documents` 构建 registry map)。索引里没有该变更,意味着 console 列不出它、gate 的引用校验看不见它、它自带的 delta spec `terminal-bg-isolation` 声明的不变量也不会进入一致性/漂移检查 —— 这就是用户感知到的「异常」。

### 修复手段(一句话)

重新运行 SpecOps 的 `scan` 命令(`specops.list-documents` 技能暴露,实现于 `apps/specops/src/domain/commands.ts:382-431`)。`scan` 会扫描 `.specops/` 下全部文档,按 mtime 重排,原子写出新的 `registry.json` 和 `SPEC-LINKS.md`。重生成后 `gui-dark-mode-tab-grid-bg` 与 `terminal-bg-isolation` 自动入索引,孤立消除。

> 注意:`scan` 仅在「无 error 级 diagnostics」时才落盘(`commands.ts:416`)。本次需确认重生成时不出现阻断性 error,否则索引不会更新。

### Constitution conflicts

无。本变更不违反 `.specops/constitution.md` 任何 invariant:
- 不涉及 PTY child lifecycle(`pty-lifecycle.md`)。
- 不改 backend default args(`backend-default-args.md`)。
- 不涉及 SpecOps Run isolation(`specops-run-isolation.md`)—— 仅重生成索引文件,不创建 Run、不进 worktree。
- "GUI terminal rendering is independent from SpecOps console rendering" 原则不受影响 —— 本变更只动 SpecOps 状态索引,不碰 GUI 终端渲染。

## Scope

**改什么**:
- `.specops/state/registry.json` — 通过运行 `scan` 重生成,使其包含 `gui-dark-mode-tab-grid-bg`(kind `bug`)与 delta spec `terminal-bg-isolation`(kind `spec`)条目,并刷新 `generated_at`。
- `.specops/state/SPEC-LINKS.md` — 同次 `scan` 重生成,在「Canonical documents」列表补上对应链接。

**怎么改**:运行 SpecOps `scan` 命令(`specops.list-documents` 技能 / `apps/specops/src/domain/commands.ts` 的 scan 实现)重生成,**不手工编辑索引 JSON/MD**(手编会与生成器漂移,且下次 scan 会被覆盖)。

**不改什么**:
- `gui-dark-mode-tab-grid-bg` 变更文档内容(已验证完整、分析正确,非异常来源)。
- GUI 源码(`apps/gui/**`)—— 本变更不实施那条 CSS 视觉修复。
- SpecOps 引擎代码(`apps/specops/**`)—— scan 行为本身正常,本次只是触发它。

## Acceptance criteria

- [ ] 重生成后 `.specops/state/registry.json` 的 `documents[]` 中存在 `id: gui-dark-mode-tab-grid-bg`(kind `bug`)条目,且其 `files[]` 含 proposal/tasks/design。
- [ ] 重生成后 registry 中存在 delta spec `terminal-bg-isolation`(kind `spec`)条目。
- [ ] `.specops/state/SPEC-LINKS.md` 的 Canonical documents 列表含 `gui-dark-mode-tab-grid-bg` 链接。
- [ ] `registry.json` 的 `generated_at` 晚于 `gui-dark-mode-tab-grid-bg` 文件夹的最新提交时间(2026-06-29 13:19Z),证明确实重生成。
- [ ] 重生成过程无 error 级 diagnostics(否则按 `commands.ts:416` 不会落盘)。
- [ ] `pnpm test`(`apps/specops`,即 `verify.specops`)保持绿。

## Out of scope

- **实施 GUI dark 模式网格视觉修复**(那是 `gui-dark-mode-tab-grid-bg` 的职责,本变更只让它重新可见,不替它写 CSS)。
- 修改 scan 生成器逻辑或为其加测试。
- 给「添加变更时未同步重生成索引」加自动化防回归(治本工作,见 design.md「后续」,本次不做)。
- 其它孤立文档的排查(本次只针对 dark gui tab 这一条)。
- TUI v0.1(`src/ui/`)—— 已冻结,不碰。
