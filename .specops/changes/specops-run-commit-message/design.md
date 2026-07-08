# Design

## 背景

`collectRunPatch`（`apps/specops/src/domain/run.ts:217-235`）把 agent 在 Run
worktree 里的工作 `git commit` 到 Run 分支上，commit message 硬编码为：

```ts
await execFile('git', ['-C', run.worktree_path, 'commit', '-q', '--allow-empty',
  '-m', `specops(run): ${run.run_id}`], { encoding: 'utf8' }).catch(() => undefined)
```

`run.run_id` 是 UUID，对人无意义。本仓库其余提交均遵循 Conventional Commits
（`feat:` / `fix:` / `refactor:` / `chore:` …），且 `specops.toml` 的
`[gate.suppress]` 已经把 `chore/feat/fix/refactor/test/debug/docs` 列入
`suppress_commit_types` —— gate 不会拦这些 type，改造后无需动 `specops.toml`。

## 决策

### 1. message 生成抽成 helper

新增 `runCommitMessage(run: RunRecord): Promise<string>`，放 `run.ts` 内私有作用域。
理由：

- `collectRunPatch` 已经够长，把「拼字符串 + 读文件」拆出来更好测
- helper 纯函数（除读 proposal 文件外无副作用），单测可直接断言字符串
- `collectRunPatch` 调用点不变，最小侵入

### 2. type 从 proposal `kind` 推断

映射表（见 proposal.md「设计说明」）。`spec` / 空 / 未知 → `chore`。

不引入 Conventional Commits 的 `(scope)` 段：SpecOps Run 跨 `apps/specops`、
`apps/gui`、`crates/` 等多个子模块，固定 scope 反而误导。用户如果想知道影响范围，
读 body 里的 `Task:` trailer 即可。

### 3. subject 来源优先级

1. `run.change_id` → 读 `.specops/changes/<change_id>/proposal.md` 的 frontmatter
   `title`
2. `run.tasks[run.current_task]?.title`
3. 字面量 `specops run <short-id>`

第一优先级复用 `parseDocument`（`apps/specops/src/domain/spec.ts`），不手写 YAML
解析 —— 避免和 frontmatter schema 漂移。

### 4. short-id 复用 `branchNameFor` 的算法

`run.run_id.replace(/-/g, '').slice(0, 8)` —— 与 `branchNameFor()`
（`run.ts:104-107`）一致，避免出现两种「Run 短 ID」。

### 5. body 用 trailer 而非自由文本

```
Run-Id: <full uuid>
Change-Id: <change_id 或 "quick-run">
Task: <current task title>
```

trailer（`Key: Value` 行）是 Git 社区惯例，`git log --format=%b` 可直接 grep，
也方便未来写工具解析。**不**把 UUID 塞回首行 —— 首行只留人读信息。

### 6. 首行长度约束

首行 ≤ 72 字符（Conventional Commits 惯例）。超长按字符截断到 71 再加 `…`。不
做智能词边界换行 —— SpecOps Run 的 subject 来自 proposal title，偶尔截断可接受，
不值得为此引入换行逻辑。

## 备选方案

### A. 在 `specops.toml` 加 `[commit]` 模板配置

rejected：YAGNI。当前只有一个 commit 生成点（`collectRunPatch`），硬编码 helper
足够。等出现第二种 Run 提交场景（如 `specops plan` 也走 worktree）再抽配置。

### B. 让用户在创建 Run 时手填 commit message

rejected：SpecOps 的产品哲学是「用户给一句话，AI 全自动产出」，让用户填 commit
message 违背设计。且 Run 创建时 subject 可读性差正是本提案要解决的。

### C. 保留 `specops(run):` prefix，只把 UUID 换成 title

```
specops(run): feat: Add dark mode
```

rejected：双重 type 前缀（`specops(run):` + `feat:`）丑且不符合 Conventional
Commits 字面规范。`feat:` 前缀已经足够标识这是 SpecOps 产出（body 里的
`Run-Id:`/`Change-Id:` trailer 会说明来源）。

## 风险

- **proposal 文件不存在**：legacy Run 或手改过的 run.json 可能 `change_id` 指向已
  删除的 change 文件夹。helper 必须容错（`exists()` 检查 + try/catch 回退到
  task title），不能让 `collectRunPatch` 因读 proposal 失败而崩 —— 这条路径已有
  `.catch(() => undefined)` 兜底 commit 失败，但 helper 抛异常会绕过兜底，需
  在 helper 内部吞掉。

- **proposal frontmatter schema 漂移**：`parseDocument` 已经处理 frontmatter 解析
  失败，复用它而非手写解析即可。

- **测试隔离**：现有 `run.test.ts` 用 `gitWorkspace()` 帮手搭临时仓库，新测试同
  样用 `fixture()` 模式，不动 helpers.js。
