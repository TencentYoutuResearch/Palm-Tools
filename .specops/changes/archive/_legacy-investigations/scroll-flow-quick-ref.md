# Scroll-to-Bottom: Quick Reference

## Three Main Triggers

### 1. TAB CLICK (Primary)
**App.svelte:617** → User clicks tab card
```
onclick={() => selectTab(t.id)}
```
↓ calls **sessions.ts:124**
```typescript
export function selectTab(id: SessionId) {
  activeId.set(id)  // ← store update
  touchMounted(id)
}
```
↓ triggers reactive binding in **App.svelte:766**
```typescript
isActive = id === $activeId && !chooserOpen
```
↓ updates prop in **App.svelte:769**
```html
<div class="term-wrapper" class:visible={isActive}>
```
↓ Terminal.svelte receives `visible={true}`

**Terminal.svelte:896** $effect fires:
```typescript
$effect(() => {
  if (visible) scheduleResize(true)  // ← stickToBottom=true
})
```

### 2. KEYBOARD TAB NAVIGATION (Primary)
**App.svelte:357-372** handles Cmd+] / Cmd+[ / Cmd+1..9
```typescript
selectTab(nextTabId)  // ← same as above
```

### 3. KEYBOARD ONLY (No Scroll)
**Terminal.svelte:287-327** Modifier key press
- Cmd/Ctrl/Alt/Shift alone → **SKIP scrollToBottom**
- Reason: Don't interrupt user's scrollback browsing

---

## Core Orchestration: scheduleResize()

**Location:** Terminal.svelte:738-796

```
scheduleResize(stickToBottom: boolean)
    ↓
    Set pendingStick = true  (if stickToBottom=true)
    ↓
    setTimeout 50ms
    ↓
    fitAddon.fit()  (recalculate cols/rows)
    ↓
    ipc.resizeSession()  (send to PTY)
    ↓
    requestAnimationFrame ×2
    │ 
    ├─ 1st rAF: xterm buffer refresh
    └─ 2nd rAF: DOM stable, then:
       ├─ forceSyncViewport()  (fix scroll-area height)
       └─ term.scrollToBottom()  [IF !cmdHeld]
    ↓
    ✓ Viewport at bottom
```

**Key Guards:**
- `cmdHeld` = false (not in link-clicking mode)
- `containerEl.offsetWidth > 0` (container has real layout)
- `term.cols >= MIN_COLS` (20) and `term.rows >= MIN_ROWS` (5)

---

## forceSyncViewport() Purpose

**Problem:** xterm viewport scroll-area desync during tab switch

When tab is inactive (`display:none`):
- xterm container height = 0
- Incoming bytes trigger `Viewport.syncScrollArea()` with height = 0
- scroll-area height set to 0
- When tab becomes visible, `fitAddon.fit()` doesn't detect size changes
- xterm short-circuit skips scroll-area recalc
- Result: scrollbar gone but content exists

**Solution (Terminal.svelte:706-730):**
```typescript
const vp = term._core?.viewport
if (vp._refresh) vp._refresh(true)  // Force recalc
```

---

## Keyboard & Scroll Interaction

### Modifier-Only Keys (Don't Scroll)
Lines 287-327

```typescript
_modifierKeyHeld = true  // when: Cmd, Ctrl, Alt, Shift alone
_modifierKeyHeld = false // when: any other key pressed (e.g., Cmd+K)

term.scrollToBottom = function () {
  if (_modifierKeyHeld) return  // ← SKIP
  origScrollToBottom()
}
```

### Cmd Key for Links
Lines 650-669

```typescript
_onCmdDown: cmdHeld = true → add class "cmd-held"
_onCmdUp: cmdHeld = false → remove class "cmd-held"
```

**CSS Impact:**
```css
.term-host.cmd-held { cursor: pointer; }
```

**Scroll Impact (line 782):**
```typescript
if (shouldStick && !cmdHeld) {
  // scroll to bottom
}
```

### PTY Override Keys (Don't Trigger Scroll)
Lines 376-406 — These are handled before xterm sees them:
- Cmd+← / Cmd+→ → readline ^A / ^E
- Option+← / Option+→ → word jump
- Cmd+C / Cmd+V → clipboard
- Cmd+= / Cmd+- → font size

---

## File Quick Links

| Task | File | Lines |
|------|------|-------|
| Tab click handler | App.svelte | 617 |
| selectTab() | sessions.ts | 123-131 |
| Visibility prop | App.svelte | 766 |
| term-wrapper class | App.svelte | 769 |
| $effect on visible | Terminal.svelte | 896-898 |
| scheduleResize() | Terminal.svelte | 738-796 |
| forceSyncViewport() | Terminal.svelte | 706-730 |
| Modifier key patch | Terminal.svelte | 287-327 |
| Cmd key visual | Terminal.svelte | 650-669 |
| PTY key override | Terminal.svelte | 376-406 |
| Key capture handler | Terminal.svelte | 407-472 |
| App-level shortcuts | App.svelte | 328-419 |

---

## Absolute Paths (macOS)

```
/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/App.svelte
/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/Terminal.svelte
/Users/marxwang/Projects/youtu/app/nocode/apps/gui/src/lib/sessions.ts
```

