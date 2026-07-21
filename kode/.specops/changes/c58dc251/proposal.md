---
schema_version: 1
id: c58dc251
kind: investigation
title: 排查 changes 里 dark gui 变更为何「异常」——孤立于 SpecOps 索引之外
status: completed
verifies: []
paths:
  - .specops/changes/gui-dark-mode-tab-grid-bg
  - .specops/state/registry.json
  - .specops/state/SPEC-LINKS.md
  - .specops/state/intakes/01f7c58e-912a-483a-9c0f-56803af747af.json
---

# 排查 changes 里 dark gui 变更为何「异常」——孤立于 SpecOps 索引之外

> 用户原始请求:
> "你看看为啥changes里面的 dark gui问题为啥异常了"

## Motivation

`changes` 目录里跟 "dark gui" 相关的变更是 `.specops/changes/gui-dark-mode-tab-grid-bg`(标题《GUI 终端 tab 在 dark 模式下背景透出网格》)。用户感觉它「异常」。本次调查定位了根因。

### 结论(一句话)

变更文件夹本身内容完整、代码分析正确,**「异常」不在文档质量,而在它被孤立于 SpecOps 状态索引之外** —— 它存在于磁盘与 git,却没有出现在 `.specops/state/registry.json` 与 `.specops/state/SPEC-LINKS.md` 里,因此 SpecOps console / gate / drift 分析器都看不见它。

### 证据链(已逐项核对)

1. **intake 已完成**:`.specops/state/intakes/01f7c58e-912a-483a-9c0f-56803af747af.json` 的 `status: "completed"`,`primary` 指向 `.specops/changes/gui-dark-mode-tab-grid-bg`,documents 列出 proposal/tasks/design + delta spec。说明 intake 这一步正常落盘。

2. **文件夹已进 git**:`git log` 显示它在 HEAD 提交 `8ab8aaa`(2026-06-29 21:19 +0800,标题 "SpecOps: add gui-dark-mode-tab-grid-bg change, fix bridge session monitoring, UI refresh")中被新增,含 proposal.md / tasks.md / design.md / specs/terminal-bg-isolation/spec.md。

3. **索引里查无此项**:`grep "gui-dark-mode-tab-grid-bg\|terminal-bg-isolation"` 在 `registry.json` 和 `SPEC-LINKS.md` 中**零命中**。registry 的 `generated_at` 是 `2026-06-29T11:59:03Z`,**早于**变更文件夹被创建/提交的时间(21:19 +0800 ≈ 13:19Z)。即:索引是变更落盘之前生成的旧快照,从未重生成。

4. **同一提交未更新索引**:`git show HEAD --name-only -- .specops/state/registry.json .specops/state/SPEC-LINKS.md` 为空 —— 添加变更文件夹的那次提交**没有同时重生成索引**。这是孤立的直接成因。

5. **delta spec 同样隐形**:变更自带的 delta spec `terminal-bg-isolation`(`specs/terminal-bg-isolation/spec.md`)也不在 registry/SPEC-LINKS,所以它声明的不变量不会被纳入一致性/漂移检查。

### 文档质量本身没问题(已验证,非「异常」来源)

变更里引用的代码行号经过比对**仍与当前源码一致**:
- 网格定义:`apps/gui/src/App.svelte:1457` 起 `.root::before`,`linear-gradient(rgba(159, 232, 112, 0.02) ...)`,`background-size: 40px 40px`(1464-1466 行)。
- 噪声层:`App.svelte:1471` `.root::after`。
- `.main`:`App.svelte:2279`。
- `Terminal.svelte`:`.term-host`(1196)、`:global(.xterm-viewport)`(764 行处查询)、`buildXtermTheme`(175)。

所以根因分析没有过时,问题纯粹是**索引漂移(staleness)**,正是 `.specops/constitution.md` 末条 guardrail 警告的那类情况(参见 `cleanup-specops-document-staleness`)。

### Constitution conflicts

无。本调查只在 `.specops/` 下写文档,不碰源码、不改 backend args、不涉及 PTY 生命周期、不涉及 Run isolation,亦不耦合 GUI 终端渲染与 SpecOps console。

## Scope

**本次调查回答的问题**:
- 「dark gui 变更为何异常」的根因定位(索引孤立,非内容缺陷)。
- 给出可执行的修复方向(重生成索引),但**不在本调查里执行修复**(实现需独立审批)。

**调查覆盖的产物**:
- `.specops/changes/gui-dark-mode-tab-grid-bg/`(被调查对象,只读)。
- `.specops/state/registry.json`、`.specops/state/SPEC-LINKS.md`(索引现状,只读)。
- `.specops/state/intakes/01f7c58e-...json`(intake 收据,只读)。
- 关联源码 `apps/gui/src/App.svelte`、`apps/gui/src/lib/Terminal.svelte`(仅用于核对行号,只读)。

## Acceptance criteria

- [x] 明确指出「异常」= `gui-dark-mode-tab-grid-bg` 及其 delta spec `terminal-bg-isolation` 未进入 `registry.json` / `SPEC-LINKS.md`。
- [x] 给出时间线证据:registry `generated_at` (11:59:03Z) 早于变更提交 `8ab8aaa` (21:19 +0800);添加变更的提交未同步重生成索引。
- [x] 确认变更文档的代码行号引用仍与当前源码一致,排除「内容过时」这一可能。
- [x] 给出修复方向(重生成 registry/SPEC-LINKS),并说明本调查不执行修复。

## Out of scope

- **执行**索引重生成 / 修复孤立(需走独立 change + 审批;本调查只诊断)。
- 实际修复 dark 模式网格泄漏(那是 `gui-dark-mode-tab-grid-bg` 自己的职责,不在本调查内)。
- 改 SpecOps 引擎让 intake 自动重生成索引(若要做,应独立立项,可参考 `cleanup-specops-document-staleness` / `fix-gate-errors-and-intake-ordering`)。
- 碰任何源码、TUI `src/ui/`(已冻结)。

## 修复方向(供后续独立 change 决策,本调查不执行)

1. **重生成索引(治标,最小)**:重跑 SpecOps 的索引生成步骤,让 `registry.json` 与 `SPEC-LINKS.md` 纳入 `gui-dark-mode-tab-grid-bg` 与 `terminal-bg-isolation`,使其对 console/gate/drift 可见。
2. **补提交规约(治本之一)**:任何新增/修改 `.specops/changes` 或 `.specops/specs` 的提交,必须在同一提交内重生成并提交索引,避免 registry 快照落后于磁盘。
3. **引擎侧自动化(治本之二)**:让 intake 完成时自动触发索引重生成,而非依赖人工。需独立立项评估。
