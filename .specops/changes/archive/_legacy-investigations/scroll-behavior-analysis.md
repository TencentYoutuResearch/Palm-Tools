# GUI Frontend Scroll-to-Bottom Behavior Analysis

## Project: Tauri + SvelteKit + xterm.js

This document maps out the complete scroll-to-bottom flow in the Kill la Code GUI.

---

## 1. TAB CLICK EVENT HANDLERS

### File: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/App.svelte`

**Tab Click Handler (Line 617)**
```javascript
<div
  class="tab"
  class:active={t.id === $activeId}
  ...
  onclick={() => selectTab(t.id)}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTab(t.id) } }}
>
```

**What Happens When Tab Is Clicked:**
1. `selectTab(t.id)` is called
2. Triggers `Terminal.svelte` `visible` prop to change
3. Emits the $effect that calls `scheduleResize(true)` with `stickToBottom=true`

---

## 2. TAB SELECTION LOGIC

### File: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/sessions.ts`

**selectTab() Function (Lines 123-131)**
```typescript
export function selectTab(id: SessionId) {
  activeId.set(id)
  // 切到当前 tab → 仅清未读(普通流量)。
  // **不**清 attention:必须真正回答 prompt(Rust 端 scan_loop 检测到屏幕清掉后会
  // emit session-attention-clear)attention 才会消失。否则用户随便点一下 tab 就
  // 误以为"已处理",再忘了去回答。
  tabs.update((arr) => arr.map((t) => (t.id === id ? { ...t, unread: false } : t)))
  touchMounted(id)
}
```

**Key Steps:**
1. Sets `activeId` store to the clicked tab's id
2. Clears unread flag for that tab
3. Calls `touchMounted(id)` to update LRU cache

---

## 3. SCROLL-TO-BOTTOM ORCHESTRATION

### File: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/Terminal.svelte`

#### A. Reactive Effect on Tab Visibility Change (Lines 896-898)
```typescript
// 父组件 visible 变化时调一下 fit(从隐藏切回显示后,字号可能变了)。
// 传 stickToBottom=true:fit 完成后强制把 viewport 推回底部。
// 不能在这里直接调 term.scrollToBottom() —— scheduleResize 内部 50ms 后才 fit,
// 现在调会被 fit 重置,所以让 scheduleResize 在 fit 之后自己滚。
$effect(() => {
  if (visible) scheduleResize(true)
})
```

**Trigger Flow:**
1. User clicks tab → `selectTab()` → `activeId` store updates
2. App.svelte renders new `.term-wrapper.visible={isActive}` class
3. Terminal.svelte receives updated `visible` prop = true
4. $effect fires → calls `scheduleResize(true)` with `stickToBottom=true`

#### B. scheduleResize() Function (Lines 738-796)

**Function Signature:**
```typescript
let pendingStick = false
function scheduleResize(stickToBottom = false) {
  if (stickToBottom) pendingStick = true
  if (resizeTimer != null) clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    // ... fit logic ...
    if (shouldStick && !cmdHeld) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          forceSyncViewport()
          try { term?.scrollToBottom() } catch {}
        })
      })
    } else {
      requestAnimationFrame(() => forceSyncViewport())
    }
  }, 50)
}
```

**Key Points:**
- 50ms debounce before fit
- Double rAF: first for xterm buffer refresh, second for DOM stability
- **Critical:** Calls `forceSyncViewport()` then `scrollToBottom()`
- **Guard:** Only scrolls if `!cmdHeld` (cmd key not pressed)

#### C. forceSyncViewport() Function (Lines 706-730)

**Purpose:** Fix xterm viewport scroll-area height desync when switching tabs

```typescript
function forceSyncViewport() {
  if (!term) return
  try {
    const vp = (term as any)._core?.viewport
    if (vp) {
      if (typeof vp._refresh === 'function') {
        vp._refresh(true)      // Force xterm to recalc scroll-area height
        return
      }
      if (typeof vp.syncScrollArea === 'function') {
        vp.syncScrollArea()
        return
      }
    }
  } catch (e) {
    console.warn('[term] viewport refresh failed:', e)
  }
  // Fallback: bump scrollback to trigger official onSpecificOptionChange → syncScrollArea
  try {
    const cur = (term.options as any).scrollback ?? 5000
    term.options.scrollback = cur + 1
    term.options.scrollback = cur
  } catch {}
}
```

**Why This Exists:**
- When inactive tab is `display:none`, xterm's viewport offsetHeight = 0
- Incoming bytes trigger xterm's `Viewport.syncScrollArea()` with height = 0
- When tab becomes visible again, fitAddon.fit() might not detect size changes
- xterm's short-circuit prevents scroll-area from being recalculated
- Result: scrollbar disappears but content still exists
- Solution: Force viewport to recalculate

---

## 4. KEYBOARD EVENT HANDLERS

### File: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/Terminal.svelte`

#### A. Modifier Key Patch (Lines 287-327)

**Problem:** xterm automatically calls `scrollToBottom()` on every keydown, even for modifier-only keys (Cmd/Ctrl/Alt/Shift). This breaks user scrollback browsing.

**Solution:** Wrap xterm's scrollToBottom method:

```typescript
const origScrollToBottom = term.scrollToBottom.bind(term)
let _modifierKeyHeld = false

const _onModKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
    _modifierKeyHeld = true
  } else {
    // Non-modifier key added (e.g., Cmd+K), allow scroll
    _modifierKeyHeld = false
  }
}

const _onModKeyUp = (e: KeyboardEvent) => {
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') {
    _modifierKeyHeld = false
  }
}

window.addEventListener('keydown', _onModKeyDown, { capture: true })
window.addEventListener('keyup', _onModKeyUp, { capture: true })

;(term as any).scrollToBottom = function () {
  if (_modifierKeyHeld) return        // SKIP if modifier-only
  origScrollToBottom()
}
```

#### B. PTY Override Keys (Lines 376-406)

**Special keyboard shortcuts that translate to PTY control sequences:**

```typescript
function ptyKeyOverride(e: KeyboardEvent): string | null {
  const meta = e.metaKey
  const opt = e.altKey
  const ctrl = e.ctrlKey
  const shift = e.shiftKey
  const k = e.key

  // Cmd+← / Cmd+→ → 行首 / 行尾 (readline: Ctrl-A / Ctrl-E)
  if (meta && !ctrl && !opt) {
    if (k === 'ArrowLeft') return '\x01'   // ^A
    if (k === 'ArrowRight') return '\x05'  // ^E
    if (k === 'Backspace') return '\x15'   // ^U  删到行首
    if (k === 'Delete') return '\x0b'      // ^K  删到行尾
  }

  // Option+← / Option+→ → 按词跳 (ESC b / ESC f)
  if (opt && !meta && !ctrl) {
    if (k === 'ArrowLeft') return '\x1bb'
    if (k === 'ArrowRight') return '\x1bf'
    if (k === 'Backspace') return '\x17'   // ^W  删词
    if (k === 'Delete') return '\x1bd'     // ESC d  向后删词
  }

  // Esc: IME 没在组合时直接送 \x1b
  if (k === 'Escape' && !meta && !ctrl && !opt && !shift && !(e as any).isComposing) {
    return '\x1b'
  }

  return null
}
```

#### C. Key Capture Handler (Lines 407-472)

**Runs before xterm's keydown handler (capture phase)**

```typescript
const onKeyCapture = (e: KeyboardEvent) => {
  if ((e as any).isComposing || (e as KeyboardEvent & { keyCode: number }).keyCode === 229) {
    return  // Let IME handle composition
  }

  // (B) Clipboard operations
  // Cmd+C: copy if selected; prevent if not (WKWebView undo-focus)
  // Cmd+V: paste from clipboard
  
  // (C) Font scaling
  // Cmd+= / Cmd+Shift+= / Cmd++ → increase
  // Cmd+- → decrease
  // Cmd+0 → reset
  
  // (A) PTY control sequence translation
  const seq = ptyKeyOverride(e)
  if (seq == null) return
  e.preventDefault()
  e.stopPropagation()
  const bytes = new TextEncoder().encode(seq)
  ipc.writeInput(sessionId, bytes).catch(console.error)
}

containerEl.addEventListener('keydown', onKeyCapture, { capture: true })
```

#### D. Cmd Key Visual Feedback (Lines 650-669)

**Shows pointer cursor when Cmd is held to indicate clickable links:**

```typescript
_onCmdDown = (e: KeyboardEvent) => {
  if (e.key === 'Meta') {
    cmdHeld = true
    containerEl.classList.add('cmd-held')
  }
}

_onCmdUp = (e: KeyboardEvent) => {
  if (e.key === 'Meta') {
    cmdHeld = false
    containerEl.classList.remove('cmd-held')
  }
}

window.addEventListener('keydown', _onCmdDown)
window.addEventListener('keyup', _onCmdUp)
```

**CSS Effect:**
```css
.term-host.cmd-held {
  cursor: pointer;
}
```

---

## 5. INPUT BOX / TEXTAREA FOCUS/INPUT HANDLERS

### File: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/Terminal.svelte`

#### A. xterm's Built-in Textarea (Line 349-352)

```typescript
term.onData((data: string) => {
  const bytes = new TextEncoder().encode(data)
  ipc.writeInput(sessionId, bytes).catch(console.error)
})
```

**Flow:**
1. User types in xterm (handled by xterm's internal textarea)
2. `term.onData()` callback fires with character
3. Converts to UTF-8 bytes → sends to PTY via IPC

#### B. IME Composition Fix (Lines 238-286)

**Issue:** Some IME (Douyin, Sogou) in English mode drop second character

```typescript
const core: any = (term as any)._core
const compHelper = core?._compositionHelper
const origInputEvent = core?._inputEvent?.bind(core)

if (core && compHelper && origInputEvent) {
  core._inputEvent = function (ev: InputEvent): boolean {
    const composing = !!(compHelper._isComposing || compHelper._isSendingComposition)
    if (
      ev.data &&
      ev.inputType === 'insertText' &&
      !composing &&
      !core.optionsService.rawOptions.screenReaderMode
    ) {
      // Handle non-composition text directly
      core.coreService.triggerDataEvent(ev.data, true)
      try { core.textarea.value = '' } catch {}  // Clear to prevent double-emit
      try { (ev as any).preventDefault?.() } catch {}
      try { (ev as any).stopPropagation?.() } catch {}
      return true
    }
    return origInputEvent(ev)
  }
}
```

---

## 6. KEYBOARD SHORTCUTS IN APP.SVELTE

### File: `/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/App.svelte`

**Global Keyboard Handler (Lines 328-419)**

```typescript
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (paletteOpen) { paletteOpen = false; e.preventDefault(); return }
    if (renameOpen) { renameOpen = false; e.preventDefault(); return }
    // ... other modals
  }
  
  if (e.key === 'F2' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault()
    if ($activeTab) renameOpen = true
    return
  }
  
  if (!e.metaKey && !e.ctrlKey) return

  const k = e.key
  if (k === 't' || k === 'T') {
    e.preventDefault()
    chooserOpen = true                    // Cmd+T: New tab
  } else if (k === 'w' || k === 'W') {
    closeTab($activeId)                   // Cmd+W: Close tab
  } else if (k === ']') {
    selectTab(arr[(idx + 1) % arr.length].id)   // Cmd+]: Next tab
  } else if (k === '[') {
    selectTab(arr[(idx - 1 + arr.length) % arr.length].id)  // Cmd+[: Prev tab
  } else if (/^[1-9]$/.test(k)) {
    selectTab($tabs[Number(k) - 1].id)   // Cmd+1..9: Jump to tab
  } else if (k === 'p' || k === 'P') {
    paletteOpen = true                    // Cmd+P: Command palette
  } else if (k === 'b' || k === 'B') {
    cycleSidebar()                        // Cmd+B: Toggle sidebar
  }
  
  // Prevent WKWebView default for unhandled Cmd/Ctrl keys
  if ($activeId != null && !paletteOpen && !renameOpen && !chooserOpen && !memoryPanelOpen) {
    e.preventDefault()
  }
}
```

---

## 7. COMPLETE FLOW DIAGRAM

```
User clicks tab in sidebar
         ↓
App.svelte line 617: onclick={() => selectTab(t.id)}
         ↓
sessions.ts line 124: export function selectTab(id)
         ├─ activeId.set(id)
         └─ touchMounted(id)
         ↓
App.svelte: activeId store changes
         ↓
App.svelte line 766: isActive = id === $activeId && !chooserOpen
         ↓
App.svelte line 769: <div class="term-wrapper" class:visible={isActive}>
                     class changes from hidden to visible
         ↓
Terminal.svelte prop: visible changes to true
         ↓
Terminal.svelte line 896-898: $effect(() => {
                               if (visible) scheduleResize(true)
                               })
         ↓
Terminal.svelte line 738: scheduleResize(stickToBottom = true)
         ├─ Set pendingStick = true
         └─ setTimeout 50ms
         ↓
After 50ms:
  ├─ fitAddon.fit() → xterm recalculates cols/rows
  ├─ ipc.resizeSession() → send new size to backend PTY
  ├─ requestAnimationFrame × 2 (xterm buffer + DOM ready)
  ├─ forceSyncViewport() → fix scroll-area height
  └─ term.scrollToBottom() [if !cmdHeld]
         ↓
xterm viewport scrolls to bottom
```

---

## 8. KEY CONSTRAINTS & EDGE CASES

### Constraint 1: Modifier-Only Keys Don't Scroll
**Lines 287-327 in Terminal.svelte**
- Cmd/Ctrl/Alt/Shift alone: DON'T trigger scrollToBottom
- Reason: User might be in scrollback history; shouldn't be yanked to bottom
- Fix: Wrap term.scrollToBottom() to check _modifierKeyHeld flag

### Constraint 2: Cmd Held Prevents Scroll
**Line 782 in Terminal.svelte**
```typescript
if (shouldStick && !cmdHeld) {
  // scroll
}
```
- When Cmd is held (for Cmd+Click), don't scroll to bottom
- Reason: User is trying to click links, not interact with terminal

### Constraint 3: Container Size Must Be Valid
**Lines 753-773 in Terminal.svelte**
- MIN_COLS = 20, MIN_ROWS = 5
- If container is 0-sized or fit results < min: skip resize
- Reason: Prevent PTY from being resized to 1 column (rows get wrapped, unrecoverable)

### Constraint 4: Viewport Sync on Every Tab Switch
**Lines 779-791 in Terminal.svelte**
- Even if shouldStick=false, still call forceSyncViewport()
- Reason: xterm has short-circuit logic; if buffer/viewport height unchanged, it skips sync
- Result: scroll-area height stays at "0" from display:none period

### Constraint 5: Double rAF for Stability
**Lines 783-788 in Terminal.svelte**
```typescript
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    forceSyncViewport()
    try { term?.scrollToBottom() } catch {}
  })
})
```
- First rAF: xterm internal buffer refresh
- Second rAF: DOM paint complete, scroll position stable

---

## 9. FILE LOCATIONS SUMMARY

| Component | Path | Line Range | Purpose |
|-----------|------|------------|---------|
| **App.svelte** | `/apps/gui/src/App.svelte` | 1-1702 | Main window, tab list, active tab switching |
| **Terminal.svelte** | `/apps/gui/src/lib/Terminal.svelte` | 1-922 | xterm.js container, scroll orchestration, keyboard handling |
| **sessions.ts** | `/apps/gui/src/lib/sessions.ts` | 1-280 | Tab state management, selectTab(), LRU mount cache |

---

## 10. KEY TAKEAWAYS

1. **Scroll-to-bottom is triggered by tab visibility change** — Not by clicking the tab directly, but by the reactive effect that fires when `visible` prop changes from false to true.

2. **scheduleResize() is the orchestrator** — It delays 50ms, ensures container has layout, calls fit(), syncs viewport, and finally scrolls.

3. **Modifier keys are guarded** — Pure Cmd/Ctrl/Alt/Shift presses won't scroll (preserves scrollback history). Combined keys like Cmd+K will.

4. **xterm viewport sync is critical** — When a tab is hidden (display:none), its xterm gets confused about scroll-area height. forceSyncViewport() forces a recalculation.

5. **Double rAF ensures DOM stability** — First frame for xterm's internal updates, second for browser paint completion.

6. **cmdHeld flag blocks scroll** — When Cmd is pressed (for link clicking), don't auto-scroll.

