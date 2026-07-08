# 设计说明

## 问题本质

"全局上下滚动" vs "每个区域独立上下滚动" 的区别,取决于**滚动容器在哪一层**:

- 若布局外壳(`body` / `.shell`)可以被内容撑高 → 滚动发生在 `body` 这一最外层 →
  表现为整页一起滚动(masthead、rail、workspace 全被一起推走)= 全局滚动。
- 若布局外壳高度被锁死在视口内、`overflow: hidden` → 外壳永远不滚动 →
  每个区域必须用自己的 `overflow-y: auto` 容纳超高内容 = 区域独立滚动。

## 当前状态

`apps/specops/src/server/public/styles.css`:

- `body { min-height: 100vh; }`(`:216`)→ 高度可被撑大,是全局滚动的源头。
- `.shell { min-height: 100vh; display: grid; grid-template: 56px minmax(0, 1fr) / 260px minmax(0, 1fr) minmax(300px, 340px); }`(`:224-228`)→ 同样是 `min-height`,无 `overflow: hidden`,会被内容撑过一屏。
- `.rail { display: flex; flex-direction: column; overflow: hidden; }`(`:282-288`)+
  `#documents { flex: 1; overflow-y: auto; }`(`:380-384`)、
  `#sessions`(`:531-535`)→ **左栏已经是正确的独立滚动范式**,可作为其它区域的样板。
- `.workspace { min-width: 0; min-height: 0; display: flex; flex-direction: column; }`(`:737-744`)→
  有 `min-height: 0`(允许在 grid 行内收缩),但**缺 `overflow`**,所以内容溢出时不在自身滚动。

## 方案

1. **锁定外壳高度**:`body` 与 `.shell` 用 `height: 100vh`(而非 `min-height`),
   `body` 加 `overflow: hidden`,确保最外层永不滚动。grid 行 `56px minmax(0, 1fr)`
   会把第二行(内容区)限制在"视口高度 − 56px masthead"之内,为内部区域提供有界高度。
2. **区域各自滚动**:`.workspace`(或其内部主内容容器)补 `overflow-y: auto`;
   inspector 区域同样保证 `overflow-y: auto` + `min-height: 0`。rail 维持现状。
3. **沿用左栏范式**:rail 的 `overflow: hidden` 外壳 + 内部 `overflow-y: auto` 是已验证可行的写法,
   workspace / inspector 按同一思路落地,保持一致。

## 取舍

- 优先用 `height: 100vh` + `overflow: hidden` 锁外壳,而不是给 `body` 直接加 `overflow-y: auto`——
  后者只是把全局滚动换了个位置,仍不是"区域独立"。锁外壳才能把滚动职责下放给各区域。
- 只动 CSS,不改 `index.html`/`app.js`:现有 DOM 已是三栏 grid + 内部可滚动节点,
  结构足够,问题纯属滚动归属与外壳高度,无需改标记或脚本。
- `grid-template` 中第二行用 `minmax(0, 1fr)` 已具备"可收缩"的前提,这是区域内部
  `overflow-y: auto` 能生效的关键(否则 1fr 默认 `min-height: auto` 会拒绝收缩,
  内容仍会撑高外壳)。
