# Design

## 决策:用 `scan` 重生成,而非手工补索引

**选择**:运行 SpecOps `scan` 命令(`apps/specops/src/domain/commands.ts:382-431`)重生成 `registry.json` + `SPEC-LINKS.md`。

**理由**:
- `registry.json` / `SPEC-LINKS.md` 是**派生产物**,不是手写源文件。生成器会扫描 `.specops/` 全部文档、按 mtime 重排、原子写出(`atomicWrite`,`commands.ts:417`/`429`)。手工编辑 JSON/MD 会与生成器输出格式漂移,且**下一次 scan 会无条件覆盖**手工内容 —— 等于白做。
- 让生成器跑一遍能同时把**所有**自上次快照(`generated_at: 2026-06-29T11:59:03Z`)以来变动的文档一并纳入,而不仅是 dark gui 这一条,索引整体回到一致状态。
- `gui-dark-mode-tab-grid-bg` 的 delta spec `terminal-bg-isolation` 也会在同一次 scan 中被识别为 kind `spec` 入索引(生成器对 changes 折叠 spec 的处理统一),无需单独操作。

## 关键约束:scan 的落盘守卫

`commands.ts:416` 有守卫:`if (!diagnostics.some(d => d.severity === 'error'))` 才写盘。也就是说,若 `.specops/` 下任一文档触发 error 级 diagnostic,scan 会**返回结果但不更新索引** —— 表面跑了、实际没改,孤立依旧。

因此 acceptance 必须显式校验 `generated_at` 已刷新,不能只看命令退出码。若发现没刷新,先定位并修掉那个 error 文档,再重跑。

## 为什么不直接改 GUI 网格 CSS

用户本次诉求经澄清确认是「SpecOps 索引孤立」这一**流程异常**,不是终端网格那个**视觉 bug**。视觉 bug 由 `gui-dark-mode-tab-grid-bg` 自己负责(它的 proposal/tasks/design 已写全)。本变更的职责边界:让那条变更在索引里重新可见,使 console/gate/drift 能看到它 —— 修好可见性后,视觉 bug 才能正常走后续 SpecOps 流程被实施。两者是「先让它可见」与「再实施它」的接力关系,不应混在一个 change 里。

## 风险

- **低**。只重生成两个派生索引文件,不改任何源码、不动 GUI、不创建 Run、不进 worktree。
- 唯一隐患是上面的「落盘守卫」:若存在前置 error 文档导致索引没真正更新,会造成「以为修了其实没修」的假象。靠 acceptance 里校验 `generated_at` + grep 命中来兜底。

## 后续(本次 out of scope)

「添加/提交变更文件夹时未同步重生成索引」是这次孤立的制度性成因(诊断见 `c58dc251`)。治本方向是在 intake/commit 流程里加一道「scan 后索引须随变更一同提交」的约束或自动化,但那是独立工作,本变更不承担。

## 不做的事

- 不手工编辑 registry.json / SPEC-LINKS.md。
- 不改 scan 生成器逻辑。
- 不实施 GUI dark 模式网格修复。
- 不碰 TUI `src/ui/`(已冻结)。
