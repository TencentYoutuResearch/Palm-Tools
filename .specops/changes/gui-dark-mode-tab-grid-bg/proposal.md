---
schema_version: 1
id: gui-dark-mode-tab-grid-bg
kind: bug
title: GUI 终端 tab 在 dark 模式下背景透出网格
status: proposed
verifies:
  - rust
paths:
  - apps/gui/src/App.svelte
  - apps/gui/src/lib/Terminal.svelte
  - apps/gui/index.html
---

# GUI 终端 tab 在 dark 模式下背景透出网格

> 用户原始请求:
> "你看看为啥kode guid的tab在dark模式下背景是网格的"

## Motivation

kode GUI 在 dark 模式下,终端 tab 区域可见网格状背景纹理,影响观感且与"零渲染问题"这一硬约束相违(见 `CODEBUDDY.md` 硬约束 #2「不闪烁、不撕裂、不丢字符、不破坏子 TUI 的光标/颜色/alt-screen」的延伸 —— 宿主背景不应干扰终端视觉)。

根因调查结论(代码定位到行):

1. **网格源**:`apps/gui/src/App.svelte:1456-1467` 的 `.root::before` 定义了双层 `linear-gradient` 网格:
   ```css
   background-image:
     linear-gradient(rgba(159, 232, 112, 0.02) 1px, transparent 1px),
     linear-gradient(90deg, rgba(159, 232, 112, 0.02) 1px, transparent 1px);
   background-size: 40px 40px;
   ```
   `inset: 0; z-index: 0` → 覆盖整个 `.root`,包括终端所在 `.main` 列。

2. **噪声层叠加**:`App.svelte:1471-1481` 的 `.root::after` 用 SVG `feTurbulence` 噪声,`z-index: 100`,**位于终端内容之上**,进一步叠加纹理。

3. **终端容器栈层级未隔离**:
   - `.main`(`App.svelte:2278-2287`)只有 `position: relative`,无显式 `z-index`,与 `.root::before`(`z-index: 0`)同处一个 stacking context。`.main` 背景虽为 `var(--bg-base)`(`#0D0F0E` dark,不透明),理论上能盖住网格 —— 但 xterm.js 的 WebGL canvas 只覆盖**字符单元格区域**,不覆盖 `.term-host` 全部像素。
   - `.xterm-viewport`(xterm.css 默认 `background-color: #000`,见 `node_modules/@xterm/xterm/css/xterm.css`)的滚动条 gutter 与 canvas 边缘 padding 区域形成缝隙,`.root::before` 网格从这些缝隙透出。
   - `.term-host`(`Terminal.svelte:1196-1200`)虽设了 `background: var(--bg-base)`,但**未对 `:global(.xterm-viewport)` 覆盖背景色**,也未给 `.term-host` 建立独立 stacking context(`isolation: isolate`)。

4. **dark 模式更明显的原因**:网格色 `rgba(159, 232, 112, 0.02)` 是固定值,**未随主题切换**。dark 下终端底色 `#0D0F0E` 近黑,2% 绿色网格肉眼可辨;light 下底色 `#F7F7F3` 把网格洗掉,几乎看不见。这是用户只在 dark 模式报告问题的直接原因。

5. **xterm theme 背景**(`Terminal.svelte:175-193` `buildXtermTheme`):dark = `#0D0F0E`,light = `#F7F7F3`,与 `--bg-base` 一致 —— 主题配置本身正确,问题不在 xterm theme,而在**宿主容器的装饰层泄漏进终端区域**。

### Constitution conflicts

无。本变更不违反 `.specops/constitution.md` 任何 invariant:
- 不涉及 PTY child lifecycle(`pty-lifecycle.md`)。
- 不改 backend default args(`backend-default-args.md`)。
- 不涉及 SpecOps Run isolation(`specops-run-isolation.md`)。
- "GUI terminal rendering is independent from SpecOps console rendering" 原则**仍然遵守** —— 本变更只改 GUI 终端宿主 CSS,不碰 SpecOps。

## Scope

**改什么**:
- `apps/gui/src/App.svelte` — `.root::before` 网格 / `.root::after` 噪声的覆盖范围或层级,使其不渗入 `.main` 终端列。
- `apps/gui/src/lib/Terminal.svelte` — `.term-host` 建立 stacking context,并显式覆盖 `:global(.xterm-viewport)` 背景为 `var(--bg-base)`,堵住 canvas 缝隙。
- 视实现策略,可能微调 `apps/gui/index.html` 的 `--bg-base` 相关 token(非必须)。

**不改什么**:
- xterm `buildXtermTheme` 的色值(已正确)。
- xterm.js / addon-webgl 版本。
- PTY、session、config.rs 等 TUI 共享代码。

## Acceptance criteria

- [ ] dark 模式下终端 tab 区域**目视无网格**背景纹理(真终端目视验证,因无 UI 渲染测试 —— 见 `CODEBUDDY.md`「测试覆盖现状」UI 缺口)。
- [ ] light 模式下终端 tab 区域外观不退化。
- [ ] sidebar / inspector 等非终端区域的网格 + 噪声装饰**保留**(这是设计意图,只在终端区域消除)。
- [ ] xterm canvas、scrollback 滚动、alt-screen 切换、光标闪烁、颜色渲染均不受影响。
- [ ] `cargo test -- --test-threads=1` 仍绿(回归保护)。

## Out of scope

- 给 GUI 加 UI 渲染层自动化测试(独立工作,见 roadmap)。
- 重做整套主题系统 / design token。
- 调整网格密度、噪声强度等装饰参数(仅当为实现手段时才动)。
- TUI v0.1(`src/ui/`)—— 已冻结,不碰。

## 备选实现方向(供 implementer 决策)

1. **给终端列建立隔离层**:`.main { isolation: isolate; }` 或 `.term-wrapper.visible { z-index: 1; }` 配合 `.main { position: relative; z-index: 1; }`,让 `.root::before/::after` 不再绘制到终端之上。**最小侵入,推荐优先尝试**。
2. **把网格/噪声作用域收窄**:把 `.root::before` 改挂到 `.sidebar` / `.inspector` 等具体装饰目标上,而非整个 `.root`。
3. **堵 xterm 缝隙**:在 `Terminal.svelte` 加 `:global(.xterm-viewport) { background-color: var(--bg-base); }` 和 `.term-host { isolation: isolate; }`,作为方案 1 的补充保险。
4. **网格色主题化**:把 `rgba(159, 232, 112, 0.02)` 改为 `var(--grid-line)` 并在 dark 下降到更低 alpha 或 0 —— 治标不治本,不单独使用。
