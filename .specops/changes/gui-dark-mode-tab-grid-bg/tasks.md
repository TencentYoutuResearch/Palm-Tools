# Tasks

- [ ] 在真终端 dark 模式下复现:打开 kode GUI,新建一个 codebuddy tab,目视确认终端区域可见 40px 网格纹理(对照 `App.svelte:1456-1467` 的 `background-size: 40px 40px`)。
- [ ] 选定实现策略(见 proposal.md「备选实现方向」)。推荐:方案 1(stacking isolation)+ 方案 3(堵 xterm 缝隙)组合。
- [ ] `apps/gui/src/App.svelte` — 给 `.main`(约 2278 行)加 `isolation: isolate` 或显式 `z-index: 1`,确保 `.root::before`(网格, z-index:0)与 `.root::after`(噪声, z-index:100)不再绘制到终端列之上。
- [ ] `apps/gui/src/lib/Terminal.svelte` — 在 `<style>` 里加 `:global(.xterm-viewport) { background-color: var(--bg-base); }`,堵住 xterm.css 默认 `#000` gutter 与 canvas 边缘缝隙。
- [ ] 视需要在 `.term-host` 加 `isolation: isolate` 作为双保险。
- [ ] 真终端目视验证:dark 模式下终端 tab 无网格;light 模式不退化;sidebar/inspector 网格 + 噪声保留。
- [ ] 验证 xterm 行为未退化:scrollback 滚动、alt-screen(进子 TUI 如 codebuddy/claude)、光标闪烁、ANSI 颜色、selection 高亮。
- [ ] `cargo test -- --test-threads=1` 保持绿。
- [ ] (可选)如改动涉及 `--grid-line` token,在 `apps/gui/index.html` 的 `:root` 与 light override 里补齐。
