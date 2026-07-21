# Design

## 背景与现状

SpecOps Web 控制台源码在 `apps/specops/frontend/src/`(Svelte 5 + Vite),由
`apps/specops/frontend/vite.config.ts` 编译成单文件 bundle `apps/specops/src/server/public/app.js`。
本次改的是**源码**(`frontend/src/`),不是编译产物。

两个 `<textarea>` 的 `onkeydown` 处理器模式完全一致:

```svelte
onkeydown={(e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();  // 或 submit()
  }
}}
```

守卫检查了 `Enter` + 非 `Shift`,但**漏了 `e.isComposing`**。IME 组合期确认候选的 keydown:
`e.key === 'Enter'` 且 `e.isComposing === true`。当前代码把这个 Enter 当成"发送",`preventDefault()`
吞掉了浏览器本该把候选词写进 textarea 的默认行为,然后立刻调 `send()`/`submit()` 发送。

## 行为契约

```
用户打字(IME 未启用/英文) → keydown: key=Enter, isComposing=false, shiftKey=false
  → 发送消息 (现状 = 修复后)

用户打中文,IME 候选框出现 → keydown: key=Enter, isComposing=true, shiftKey=false
  → 不发送,让浏览器把候选词写进 textarea (现状:误发送;修复后:正确)

候选确认后,无 IME 提示框 → keydown: key=Enter, isComposing=false, shiftKey=false
  → 发送消息 (现状 = 修复后)

任何状态 + Shift → keydown: shiftKey=true
  → 换行,不发送 (现状 = 修复后)
```

## 选型:只用 `e.isComposing`,不引入 compositionstart/end 监听

### 决策

每个守卫加一个 `&& !e.isComposing`,1 行 / 每处,不引入任何新状态变量或事件监听器。

### 为什么 `isComposing` 足够

`KeyboardEvent.isComposing` 是 W3C UI Events 标准属性,所有 evergreen 浏览器自 ~2020 起完整支持。
本项目的目标平台是 macOS / Linux(`CODEBUDDY.md` 硬约束 #3),其上的 WKWebView / Chromium / Firefox
在 IME 组合期的 Enter keydown 上稳定报告 `isComposing === true`。这是浏览器厂商和 IME 实现协商好的
标准语义,直接用即可。

### 为什么不用 `compositionstart` / `compositionend` 计数器

备选方案:维护 `let composing = false`,在 `compositionstart` 置 true、`compositionend` 置 false,
Enter 守卫检查 `!composing`。否决理由:

- 代码量翻几倍(两个事件监听器 + 状态变量 + 生命周期管理)
- Svelte 5 runes 响应式下,手动事件监听器容易和组件生命周期错位(`$effect` 里绑/解绑)
- `isComposing` 已经封装了这层语义,重复造轮子
- 与 GUI 端 `apps/gui/src/lib/Terminal.svelte:480` 的做法保持一致(那里也只用 `isComposing`),
  全项目口径统一

### 为什么不用 `keyCode === 229` 兜底

`keyCode === 229` 是"该按键被 IME 吸收、不要当普通字符处理"的信号,主要给字母键用。确认候选的
那个 Enter 在多数浏览器里 `keyCode === 13`(普通 Enter),不是 229。加 `|| keyCode === 229` 不仅
没用,反而会让阅读者误以为 229 是"IME 中的 Enter"信号,引入认知歧义。现代浏览器直接读 `isComposing`
更准确。

## 关键实现细节

### 1. 守卫顺序

```svelte
onkeydown={(e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}}
```

顺序无所谓(都是短路 AND),但保持 `!e.shiftKey` 在 `!e.isComposing` 前面,跟现有代码风格一致
(先检查修饰键,再检查 IME 状态)。

### 2. 不要 `preventDefault` IME 期的 Enter

当前 bug 的一部分是 `preventDefault()` 吞掉了浏览器把候选词写进 textarea 的默认行为。修复后,
守卫在 `isComposing === true` 时直接不进入 if 分支,`preventDefault()` 不会被调用,浏览器照常
处理 IME 确认。无需手动 `stopPropagation` 或额外干预。

### 3. 两处必须同时改

`Composer.svelte` 和 `AskFloat.svelte` 的 `onkeydown` 是各自独立绑定的,没有共享逻辑。必须分别
修改,不能只改一处。两处的模式完全一致,改法也完全一致。

## 不做的事

- **不抽共享函数**:两处各一行 `&& !e.isComposing`,抽成 `isSendEnter(e)` 之类的 helper 反而增加
  跳转和认知成本。Svelte 5 的 `onkeydown` 内联箭头函数已经是项目惯用风格。
- **不加 `compositionstart`/`compositionend` 监听**:见上面选型理由。
- **不引入前端测试**:当前 `apps/specops/tests/` 只有 server 级 vitest 集成测试,没有前端组件
  测试 harness(无 jsdom / @testing-library/svelte)。引入测试基建是独立的大工作,且 IME 事件的
  jsdom 模拟本身就不可靠(浏览器行为差异大)。本次靠手动验证覆盖。
- **不动 GUI 终端**:用户明确"主要是指 specops",且 `Terminal.svelte` 已有 `isComposing` 守卫。

## 风险

- **`isComposing` 在极老浏览器上不支持**:本项目目标是 macOS/Linux 现代浏览器 + Tauri WKWebView,
  不承诺老浏览器。无风险。
- **某些冷门 IME 在确认候选瞬间 `isComposing` 报告不准**:W3C 规范和 Blink/WebKit 实现都已稳定
  多年,主流中文/日文/韩文 IME(搜狗、豆包、系统拼音、Google 日文输入等)在 macOS/Linux 上
  行为一致。若后续有用户报告特定 IME 的边缘 case,再考虑加 `compositionstart/end` 兜底,但本次
  不预支复杂度。
- **现有 `pnpm test` 不会覆盖此改动**:因为测试是 server 级的,前端组件无测试。Acceptance criteria
  里已明确要求手动验证。
