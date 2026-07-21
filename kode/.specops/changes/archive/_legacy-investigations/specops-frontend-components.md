# SpecOps Frontend UI - Component Reference

## File Locations (Absolute Paths)

- **HTML Structure**: `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/index.html`
- **JavaScript Logic**: `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/app.js`
- **Styles**: `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/styles.css`
- **Server**: `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/index.ts`

---

## UI Components Breakdown

### 1. MASTHEAD (Header Bar)

**HTML Element**: `<header class="masthead">`

**Subcomponents**:
- Left section:
  - Eyebrow: `<p class="eyebrow">KODE / SPECOPS</p>`
  - Title: `<h1>Constraint workspace</h1>`
- Right section:
  - Health indicator: `<div class="health" id="health">`
    - Status dot: `<span></span>` (color indicates state)
    - Status text: "Loading workspace", "Ready", or error message

**Styling**:
- Height: 64px
- Background: `color-mix(in srgb, var(--iron) 86%, var(--void))`
- Border-bottom: `1px solid var(--line)`
- Flexbox layout with space-between

**JavaScript**: No direct handlers (status updated via `health.classList.add/remove('ready'|'error')`)

---

### 2. RAIL (Left Sidebar)

**HTML Element**: `<aside class="rail">`

#### 2.1 Rail Head
**HTML**: `<div class="rail-head">`
- Label: `<span>Specs & Changes</span>`
- Actions container: `<div class="rail-actions">`
  - Button: `#scan` (text: "Rescan")
  - Button: `#new-spec` (text: "+ Ask")

**Event Handlers**:
- `#scan`: Calls API to refresh spec list
- `#new-spec`: Shows `#create-overlay` modal

#### 2.2 Document List
**HTML**: `<nav id="documents" aria-label="Spec documents"></nav>`

**Rendered Structure**:
```html
<div class="doc-section" data-kind="spec">
  <div class="section-header">
    <span>Specs</span>
    <span class="section-count">N</span>
  </div>
  <!-- Spec items -->
  <button class="doc">Spec Name</button>
</div>

<div class="doc-section" data-kind="change">
  <div class="section-header">...</div>
  <!-- Change folder items with nested files -->
  <div class="change-folder">
    <button class="change-header">Change Name</button>
    <button class="child-file">file.ts</button>
  </div>
</div>

<div class="doc-section" data-kind="archive" class="collapsed">
  <!-- Archived items (initially collapsed) -->
</div>
```

**Event Handlers**:
- Section header click: Toggle `.collapsed` class
- Doc button click: `openDocument(doc, button)`
- Change file click: `openChangeFile(changeFolder, file, button)`

---

### 3. WORKSPACE (Center Area)

**HTML Element**: `<main class="workspace">`

#### 3.1 Empty State
**HTML Element**: `<section class="empty" id="empty">`
```html
<p class="index">S/O</p>
<h2>Select a constraint</h2>
<p>Inspect its source, verify bindings, and drift diagnostics.</p>
```

**Visibility**: Shown by default, hidden when document selected

#### 3.2 Editor Section
**HTML Element**: `<section class="editor" id="editor" hidden>`

**Header**:
```html
<div class="editor-head">
  <div>
    <p class="eyebrow" id="doc-kind"></p>
    <h2 id="doc-title"></h2>
  </div>
  <div class="actions">
    <span id="save-state"></span>
    <button id="run" class="run-action" type="button">
      Implement in isolated worktree
    </button>
    <button id="save" type="button">Save changes</button>
  </div>
</div>
```

**Content Editor**:
```html
<textarea id="content" spellcheck="false" aria-label="Spec source"></textarea>
```

**JavaScript Updates**:
- `#doc-title`: Set to document name
- `#doc-kind`: Set to "spec / active / id" (kind/status/id)
- `#content`: Populated with full document content (Markdown + YAML)
- `#save-state`: Updated to show "Saved source" or "Unsaved changes"

---

### 4. DIAGNOSTICS (Right Sidebar)

**HTML Element**: `<aside class="diagnostics">`

#### 4.1 Diagnostics Header
**HTML**: `<div class="diag-head">`
```html
<span>Gate signals</span>
<strong id="diag-count">0</strong>
```

#### 4.2 Diagnostic List
**HTML Element**: `<div id="diagnostic-list"></div>`

**Rendered Cards**:
```html
<article class="diagnostic error">
  <strong>SPEC_BINDING_MISSING</strong>
  <p>Spec ID not found in commit message</p>
</article>

<article class="diagnostic warning">
  <strong>CODE_DRIFT</strong>
  <p>Implementation diverged from spec</p>
</article>
```

**Severity Classes**: `error`, `warning`, `info`

**Empty State**: 
```html
<p class="clear">No drift or gate errors.</p>
```

#### 4.3 Run Panel
**HTML Element**: `<section class="run-panel" id="run-panel" hidden>`

**Status Section**:
```html
<p class="eyebrow">Active run</p>
<strong id="run-state"></strong>
<code id="run-id"></code>
```

**Feedback Section** (hidden when state != "awaiting_review"):
```html
<label>
  Review feedback
  <textarea id="feedback" rows="4" placeholder="Explain what must change"></textarea>
</label>
```

**Action Buttons** (visibility driven by run state):
```html
<div class="run-buttons">
  <button id="verify" type="button">Run verify</button>
  <button id="open-terminal" type="button">Open terminal</button>
  <button id="feedback-send" type="button">Send feedback</button>
  <button id="accept" type="button">Accept</button>
  <button id="apply" type="button">Apply patch</button>
</div>
```

**Button Visibility Logic**:
| Button | Visible When |
|--------|------|
| #verify | state="running" or "awaiting_verify" |
| #open-terminal | kode_session_id exists |
| #feedback-send | state="awaiting_review" |
| #accept | state="awaiting_review" |
| #apply | state="completed" |

---

### 5. CREATE OVERLAY (Modal)

**HTML Element**: `<div class="create-overlay" id="create-overlay" hidden>`

**Form Structure**:
```html
<form class="create-sheet" id="create-form">
  <!-- Header -->
  <div class="create-heading">
    <div>
      <p class="eyebrow">Skill-driven intake</p>
      <h2>What should change?</h2>
    </div>
    <button class="icon-button" id="create-cancel-x" aria-label="Close">×</button>
  </div>

  <!-- Introduction -->
  <p class="create-intro">
    Describe the feature, bug, refactor, or question in your own words...
  </p>

  <!-- Input Field -->
  <label>
    <span>Your request</span>
    <textarea id="intake-request" name="request" required maxlength="12000" 
              spellcheck="true" placeholder="For example: ..."></textarea>
  </label>

  <!-- Status Messages -->
  <p class="create-status" id="create-status" hidden></p>
  <p class="create-error" id="create-error" role="alert" hidden></p>

  <!-- Action Buttons -->
  <div class="create-actions">
    <button id="create-cancel" type="button">Cancel</button>
    <button class="primary" id="create-submit" type="submit">Analyze request</button>
  </div>
</form>
```

**Event Handlers**:
- `#create-form` submit: Post to `/api/create-spec` endpoint
- `#create-cancel` click: Hide overlay
- `#create-cancel-x` click: Hide overlay
- `#new-spec` click: Show overlay

**Status Updates**:
- `#create-status`: Shows "Analyzing...", "Creating spec...", etc.
- `#create-error`: Shows error message if submission fails

---

## JavaScript State Variables

**Global (no framework state management)**:
```javascript
const token = '...' // From URL fragment or sessionStorage
let selectedPath = '' // Currently selected document path
let selectedVersion = '' // Document version (for conflict detection)
let selectedDocument = null // Full document metadata
let activeRun = null // Current Run object {run_id, state, ...}
let intakeTimer = null // Timer for create form debouncing
let pollTimer = null // Timer for Run status polling (3s interval)
```

---

## CSS Grid Layout

**Main Grid**:
```css
.shell {
  grid-template: 
    64px minmax(0, 1fr) 
    / 270px minmax(420px, 1fr) 272px;
}
```

**Column Widths**:
- Rail: 270px (fixed)
- Workspace: minmax(420px, 1fr) (flexible, min 420px)
- Diagnostics: 272px (fixed)

**Row Heights**:
- Masthead: 64px (fixed)
- Rest: minmax(0, 1fr) (flexible)

---

## Color Variables

**Dark Mode (default)**:
```css
--void: #0d0f0e       /* Main background */
--iron: #111413       /* Panel backgrounds */
--steel: #181b19      /* Button/card backgrounds */
--line: #262b28       /* Border color */
--line-strong: #3a413c /* Strong border */
--paper: #edefeb      /* Text color (foreground) */
--muted: #70776f      /* Muted text */
--secondary: #a8aea7  /* Secondary text */
--signal: #e6b450     /* Warning/status */
--cyan: #9fe870       /* Success/primary */
--cyan-soft: rgba(159, 232, 112, .12) /* Soft cyan background */
--danger: #ff6b6b     /* Error/danger */
--mono: [monospace font stack]
```

**Light Mode** (applied when `@media (prefers-color-scheme: light)` or `data-theme="light"`):
Colors invert (light backgrounds, dark text)

---

## API Endpoints Called

| Function | Method | Endpoint | Purpose |
|----------|--------|----------|---------|
| `openDocument()` | GET | `/api/document?path=<encoded>` | Fetch full document |
| `renderDocuments()` | GET | `/api/scans` | Get spec list |
| `startRunPolling()` | GET | `/api/runs/{run_id}` | Poll run status (3s) |
| Feedback submit | POST | `/api/runs/{run_id}/feedback` | Submit feedback (inferred) |
| Create spec | POST | `/api/create-spec` | Submit intake form (inferred) |

**Authentication**: All requests include `Authorization: Bearer {token}` header

---

## Theme Switching

**Mechanism**:
1. URL param: `?theme=light|dark`
2. postMessage from parent (kode GUI):
   ```javascript
   window.postMessage({type: 'specops.theme', theme: 'light'|'dark'}, '*')
   ```
3. Applied to `document.documentElement.setAttribute('data-theme', theme)`

**CSS Hooks**:
```css
:root[data-theme="light"] { /* light mode styles */ }
:root[data-theme="dark"] { /* dark mode styles */ }
:root:not([data-theme]) { /* system preference */ }
```

---

## Security Features

1. **Token Handling**:
   - Read from URL fragment (not sent to server)
   - Immediately cleared from URL via `history.replaceState()`
   - Stored in sessionStorage for page refresh
   - Sent in Authorization header for API calls

2. **CORS Protection**:
   - Origin header validation
   - sec-fetch-site checks (browser requests only)
   - Loopback-only listening (127.0.0.1)

3. **XSS Prevention**:
   - Textual content set via `.textContent` (not `.innerHTML`)
   - No `eval()` or string-to-code compilation
   - CSS classes as single source of styling truth

---

