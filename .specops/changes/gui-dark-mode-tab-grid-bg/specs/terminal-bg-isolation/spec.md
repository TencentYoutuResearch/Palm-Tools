---
schema_version: 1
id: terminal-bg-isolation
kind: spec
title: GUI 终端 tab 背景与 .root 装饰层 stacking 隔离
status: active
verifies:
  - rust
paths:
  - apps/gui/src/App.svelte
  - apps/gui/src/lib/Terminal.svelte
---

# GUI 终端背景隔离

> GUI 终端 tab 区域必须与 .root 装饰层(网格/噪声)stacking 隔离,且 .xterm-viewport 背景须跟随 --bg-base,保证 dark/light 模式下终端背景纯净无纹理泄漏

## 不变量

1. **终端宿主区域不得被 `.root` 级装饰层(网格 `::before`、噪声 `::after`)穿透**。
   - 实现手段:宿主 `.main`(终端列)或 `.term-host` 必须建立独立 stacking context(`isolation: isolate` 或等价的 `position: relative; z-index: <auto 以上>`)。
   - 验证:dark 模式下终端 tab 目视无 40px 网格纹理。

2. **`.xterm-viewport` 的背景色必须跟随 `--bg-base`**,不得使用 xterm.css 上游默认的 `#000`。
   - 实现手段:在 `Terminal.svelte` `<style>` 里 `:global(.xterm-viewport) { background-color: var(--bg-base); }`。
   - 理由:WebGL canvas 只覆盖字符单元格区域,viewport gutter 与 canvas 边缘缝隙由 `.xterm-viewport` 填充;若用默认 `#000`,dark 模式下会出现纯黑边条,light 模式下会出现黑色割裂。

3. **装饰层(网格/噪声)保留在 sidebar / inspector 等非终端区域**,不因本隔离而全局移除。
   - 这是设计意图(`App.svelte:1456` 注释:「迁入 .root 以随圆角裁切」),只消除终端区域的泄漏,不破坏其它区域的视觉。

## 上下文

- 网格定义:`apps/gui/src/App.svelte` `.root::before`,`background-size: 40px 40px`,`rgba(159, 232, 112, 0.02)`。
- 噪声定义:`apps/gui/src/App.svelte` `.root::after`,`z-index: 100`。
- xterm theme 背景:`Terminal.svelte` `buildXtermTheme` 返回 `background` = `#0D0F0E`(dark)/ `#F7F7F3`(light),与 `--bg-base` 一致 —— 本 spec 不改 theme,只改宿主 CSS。
- Constitution「GUI terminal rendering is independent from SpecOps console rendering」仍然成立:本 spec 只约束 GUI 终端宿主,不碰 SpecOps console。
