# Design

## 决策 1：纯函数分组，保留输入顺序

`groupMonitorSessions` 使用 Map 记录 cwd 首次出现顺序，不使用字母排序，也不
在组内重排会话。这样目录和行顺序都直接跟随 Worker 返回的列表。

## 决策 2：路径显示与 Worker 模式保持一致

group 标题显示目录 basename；同名目录显示父路径提示。路径拆分同时兼容 `/`
和 `\`，因此 Windows Worker 不会把完整 `D:\path` 当作目录名。

## 决策 3：仅多目录时显示 header

单目录仍保持扁平列表，避免额外视觉层级；多目录时渲染可折叠 header 和数量，
compact sidebar 保持原有 tile 布局。

## Verification

- `pnpm --dir apps/gui test:monitor-groups`
- `pnpm --dir apps/gui check`
- `pnpm --dir apps/gui build`
