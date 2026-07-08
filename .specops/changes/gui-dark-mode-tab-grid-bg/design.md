# Design

## 决策:用 stacking context 隔离,而非改装饰层

**选择**:方案 1(`.main { isolation: isolate }`)+ 方案 3(覆盖 `.xterm-viewport` 背景)。

**理由**:
- 网格 + 噪声是 `.root` 级的设计装饰(`App.svelte:1456-1467` 注释明确写「迁入 .root 以随圆角裁切」),把它拆到 `.sidebar` 会破坏圆角裁切意图,改动面大。
- 终端区域本身应该是"干净的画布",不应被任何装饰层穿透。`isolation: isolate` 是 CSS 标准手段,一行搞定,语义清晰。
- xterm.css 的 `.xterm-viewport { background-color: #000 }` 是上游默认(`node_modules/@xterm/xterm/css/xterm.css`),我们没改过。覆盖成 `var(--bg-base)` 是必要的兜底 —— 即使 stacking 隔离了,viewport gutter 仍需匹配主题底色,否则 dark 下会看到纯黑边条。

## 为什么不直接把网格色在 dark 下设为 0

治标不治本:噪声层 `.root::after`(z-index: 100,在终端之上)仍会叠加。而且如果未来有其他装饰层泄漏进终端,又要逐个调 alpha。从根上用 stacking isolation 切断才是稳的。

## 为什么不动 xterm theme

`Terminal.svelte:175-193` 的 `buildXtermTheme` 返回的 `background` 已经是 `#0D0F0E`(dark)/ `#F7F7F3`(light),与 `--bg-base` 一致。WebGL `RectangleRenderer` 确实把这个色画到 canvas cell 上(`node_modules/.../addon-webgl/src/RectangleRenderer.ts:179`)。问题不在 canvas,在 canvas **之外**的宿主区域。改 theme 不解决问题。

## 风险

- `isolation: isolate` 会创建新 stacking context,可能影响 `.main` 内部已有的 z-index 层级(如 term-wrapper visible/hidden 切换、overlay tooltip 等)。需在真终端目视回归 term 切换、scrollback overlay、Cmd 按住提示等交互。
- 覆盖 `.xterm-viewport` 背景在主题切换时需随 `--bg-base` 自动变(`var()` 会处理,无需 JS)。

## 不做的事

- 不加 UI 自动化测试(独立工作,见 roadmap;当前 UI 测试缺口是已知项)。
- 不重构主题系统。
- 不碰 TUI `src/ui/`(已冻结)。
