---
schema_version: 2
id: fix-specops-independent-region-scroll
kind: bug
document_class: work_item
work_type: bugfix
title: SpecOps 每个区域独立上下滚动，消除全局上下滚动
status: cancelled
verifies: []
paths:
  - apps/specops/src/server/public/styles.css
---

# SpecOps 每个区域独立上下滚动，消除全局上下滚动

> 原始请求(逐字引用):
> Specops, 每个区域都是独立上下滚动，不要有全局的上下滚动

## Motivation

SpecOps 的 Web UI(`apps/specops/src/server/public/`)采用三栏布局:左侧 rail
(`.rail`,Documents/Sessions 列表)、中间工作区(`.workspace`)、右侧 inspector
(第三个 grid 列)。当任一区域内容超出可视高度时,整页(`<body>`)会出现一个**全局
上下滚动条**,而不是让出问题的区域**在自己内部独立滚动**。这导致:

- 滚动中间工作区时,左侧 rail / masthead 也会跟着一起被推走,布局不稳定。
- 三个区域无法各自保持视口内固定可见,体验不符合"每个区域独立上下滚动"的预期。

根因在布局外壳没有把高度锁死在视口内,而是允许内容把外壳撑高:

- `body` 用的是 `min-height: 100vh`(`apps/specops/src/server/public/styles.css:216`),
  不是固定高度,内容超出时整个 body 会变高并产生页面级滚动。
- `.shell` 同样用 `min-height: 100vh`(`apps/specops/src/server/public/styles.css:225`),
  且没有 `overflow: hidden`,所以子内容可以把 grid 外壳撑过一屏。
- 中间工作区 `.workspace`(`apps/specops/src/server/public/styles.css:737-744`)是
  `display: flex; flex-direction: column`,但**没有设置 `overflow`**(默认 `visible`),
  内容溢出时不会在自己内部滚动,而是把外壳/页面撑高。

对照可见:左侧 rail(`.rail`,`:282-288`)已经是 `overflow: hidden` + 内部
`#documents`/`#sessions` 用 `overflow-y: auto` 独立滚动(`:380-384`、`:531-535`),
方向是对的;问题主要出在外壳没锁高度、以及 `.workspace` 没有自己的滚动容器。

## Scope

仅修改 `apps/specops/src/server/public/styles.css` 的布局外壳与区域滚动相关样式:

- 将外壳高度从"可被内容撑高"改为"锁定在视口内":
  - `body` / `.shell` 改用固定视口高度(`height: 100vh`,配合 `overflow: hidden`),
    确保页面本身不再出现全局上下滚动条。
- 让中间工作区 `.workspace` 成为独立滚动容器:补上 `min-height: 0` 已有的基础上,
  为其(或其内部主内容区)设置 `overflow-y: auto`,使其内容超出时只在自己内部上下滚动。
- 确认/补齐右侧 inspector 区域同样是独立滚动容器(自身 `overflow-y: auto`、
  `min-height: 0`),与 rail、workspace 三者各自独立滚动、互不牵连。
- 保留 rail 现有的独立滚动行为(`.rail` + `#documents`/`#sessions` 的
  `overflow-y: auto`)不被破坏。

## Acceptance criteria

- 在 SpecOps Web UI 中,无论哪个区域内容多到超出视口,**整个页面(body)都不再出现
  全局上下滚动条**。
- rail、workspace、inspector 三个区域各自在内容超高时,**只在该区域内部上下滚动**,
  滚动其中一个不会带动 masthead 或其它区域一起移动。
- masthead(顶栏)始终固定可见,不随任何区域内容滚动而被推走。
- 现有功能、交互、配色、各区域宽度(`grid-template` 的 260px / 1fr / 300–340px)、
  现有的 rail 内部滚动条样式保持不变,只改滚动归属与外壳高度。
- 改动范围仅限 `apps/specops/src/server/public/styles.css`,不触碰其它源文件、
  不改 `index.html` 结构、不改 `app.js` 逻辑。

## Out of scope

- 不改三栏的列宽配置、`grid-template` 结构或 masthead 高度(56px)。
- 不改各区域内部已有的滚动条外观(`scrollbar-width` / `::-webkit-scrollbar` 等)
  超出"使其归属正确"所需的范围。
- 不涉及 kode 主 GUI(`apps/gui/src/App.svelte`),只针对 SpecOps Web UI。
- 不重写 DOM 结构、不改 `index.html` / `app.js`,不做与滚动无关的样式重构或视觉调整。
- 不处理横向(左右)滚动行为(`min-width: 760px` 等)的既有逻辑。
