# SpecOps Frontend UI Code Exploration

**Project Location**: `/Users/marxwang/Projects/youtu/app/kode/apps/specops`  
**Date**: 2026-06-21  
**Status**: MVP development (Phase 1 framework complete, executing Phase 2-6 features)

---

## 1. What is SpecOps?

**SpecOps** is a **spec-driven execution console** integrated into the kode AI agent system. It serves as a control center for:

- **Specification Management**: Define, review, and maintain spec documents that describe system constraints
- **Gate Enforcement**: Automated compliance checking (spec/change binding, code drift detection)
- **Execution Orchestration**: Dispatch tasks to AI agents (via kode) and manage the complete workflow
- **Verification & Feedback Loop**: Semi-automatic verification with human-in-the-loop approval gates

### Key Architecture Points:

- **Dual Identity**: Works both as a kode feature (launched via ⌘S) AND as an independent engineering tool
- **Engine-Agnostic**: The core engine is a Node/TypeScript program that speaks HTTP + WebSocket (Phase 9 protocol)
- **Workspace-Centric**: One `specops serve` process per Git workspace; isolated Run worktrees prevent pollution of user code
- **Integration Point**: All execution happens through kode's Phase 9 protocol (REST + WS), not direct Rust/PTY coupling

### The Complete Workflow:

```
⌘S in kode GUI
  ↓
Select Git workspace → Init specops if needed
  ↓
Spawn `specops serve` (local HTTP server)
  ↓
Embed web console in kode GUI webview panel
  ↓
User: Select spec/change → Create spec or review task
  ↓
Trigger execution: specops creates isolated Git worktree
  ↓
Request kode to spawn codebuddy/claude tab (Phase 9)
  ↓
Agent executes tasks in worktree (isolated from user's working tree)
  ↓
Half-automatic verify: human clicks "Run verify" button
  ↓
Results: pass→approve, fail→human review + feedback loop
  ↓
Apply patch back to target branch (explicit user action)
```

---

## 2. Frontend UI Code Location & Tech Stack

### File Structure

```
apps/specops/
├── src/
│   ├── server/
│   │   ├── index.ts          ← HTTP server setup, routing, API endpoints
│   │   └── public/
│   │       ├── index.html    ← Main UI HTML structure
│   │       ├── app.js        ← Pure JavaScript frontend (no framework!)
│   │       └── styles.css    ← Vanilla CSS with dark/light theme
│   ├── domain/               ← Business logic (spec/gate/drift)
│   ├── cli/                  ← Command-line interface
│   ├── adapters/             ← kode bridge integration
│   ├── skills/               ← Agent capabilities
│   └── store/                ← Workspace state management
├── package.json              ← Dependencies (minimal: ws, yaml, smol-toml)
└── dist/                     ← Compiled output
```

### Tech Stack

| Layer | Technology | Details |
|-------|-----------|---------|
| **Runtime** | Node.js 20+ | TypeScript compiled to JavaScript |
| **Build** | TypeScript + Bun | `tsc` for compilation, `bun build` for bundling |
| **Frontend Framework** | **None** (Vanilla JS/HTML/CSS) | Pure DOM manipulation, no React/Vue/Svelte |
| **HTTP Server** | Node `http` module | Simple request routing, minimal framework |
| **WebSocket** | `ws` npm package | Event streaming (agent output, state changes) |
| **Configuration** | YAML + TOML | `yaml` and `smol-toml` packages |
| **Testing** | Vitest | TypeScript-aware test framework |

### Why Vanilla JavaScript?

- **No framework bloat**: Keeps bundle size and dependencies minimal
- **Direct DOM control**: Perfect for terminal-like interface
- **Simplicity**: Direct HTTP calls via Fetch API
- **Token injection**: Can read token from URL fragment without framework complexity

---

## 3. Frontend UI Components & Pages

### Main HTML Structure (`index.html`)

The UI follows a **3-column + header + overlay** layout:

```
┌─────────────────────────────────────────────────────┐
│  MASTHEAD (Header)                                  │
│  KODE / SPECOPS | Constraint workspace  [Health]   │
├──────────────┬──────────────────────────┬───────────┤
│              │                          │           │
│   RAIL       │     WORKSPACE            │ DIAGNOSTIC│
│   (Sidebar   │     (Main editor area)   │  (Right   │
│   Documents) │                          │   panel)  │
│              │                          │           │
├──────────────┴──────────────────────────┴───────────┤
│ CREATE OVERLAY (hidden until "+ Ask" clicked)      │
└─────────────────────────────────────────────────────┘
```

### 3.1 MASTHEAD (Top Header)

**Purpose**: Status and branding

**Components**:
- **Eyebrow text**: "KODE / SPECOPS" (metadata)
- **Title**: "Constraint workspace"
- **Health indicator**: 
  - Yellow dot (loading)
  - Green dot (ready)
  - Red dot (error)
  - Status text: "Loading workspace", "Ready", "Error: ..."

**Functionality**:
- Non-interactive (display-only)
- Real-time status updates

---

### 3.2 RAIL (Left Sidebar)

**Purpose**: Document navigation and actions

**Subcomponents**:

#### Rail Head
- **Label**: "Specs & Changes"
- **Buttons**:
  - **Rescan**: Refresh the spec list from filesystem
  - **+ Ask**: Create new spec (opens overlay)

#### Document List (`<nav id="documents">`)
Rendered as collapsible sections:

**Section 1: Specs**
- Shows all active spec documents
- Each spec is clickable
- Displays count

**Section 2: Changes**
- Proposed changes/implementations
- Can be expanded to show child files
- Nested structure: change folder → individual change files

**Section 3: Archive** (collapsible)
- Completed/archived specs
- Preserved for history
- Initially collapsed

**Document Item Styling**:
- Visual indicators for status (active/draft/archived)
- Hover highlight
- Selected state (bold/different background)
- ID and status metadata

---

### 3.3 WORKSPACE (Center Area)

**Purpose**: Primary editing and viewing area

#### Empty State (`#empty`)
```
S/O
Select a constraint
Inspect its source, verify bindings, and drift diagnostics.
```
Shown when no document is selected.

#### Editor Section (`#editor`)

When a document is selected:

**Header**:
- **Eyebrow**: Document kind/status/ID (e.g., "spec / active / auth-v2")
- **Title**: Document name
- **Actions**:
  - **Save State** label (shows "Saved source", "Unsaved changes", etc.)
  - **"Implement in isolated worktree"** button (starts Run)
  - **"Save changes"** button (write back to filesystem)

**Textarea** (`#content`):
- Full-width code editor
- Spellcheck disabled
- Syntax highlighting via CSS classes
- Supports multi-line Markdown + YAML frontmatter editing

---

### 3.4 DIAGNOSTICS (Right Sidebar)

**Purpose**: Show gate signals, run status, and verification controls

#### Diagnostics Header
- **Label**: "Gate signals"
- **Count**: Live count of issues (e.g., "3")

#### Diagnostic List (`#diagnostic-list`)
Renders as cards:

**Each diagnostic card contains**:
- **Code**: Error/warning code (e.g., "SPEC_BINDING_MISSING")
- **Severity**: Class name for styling (error/warning/info)
- **Message**: Human-readable explanation

**Empty state**: "No drift or gate errors."

#### Run Panel (Hidden until Run starts)

When a Run is active, shows:

**Run Status Section**:
- **"Active run"** label
- **State**: Current state (running, awaiting_review, completed, etc.)
- **Run ID**: Unique identifier (monospace display)

**Feedback Section** (only when state === "awaiting_review"):
- **Label**: "Review feedback"
- **Textarea**: 4-line feedback input
  - Placeholder: "Explain what must change"
  - Allows user to write rejection reason

**Action Buttons** (visibility depends on state):
- **"Run verify"**: visible when state is "running" or "awaiting_verify"
- **"Open terminal"**: visible when kode_session_id exists
- **"Send feedback"**: visible when state is "awaiting_review"
- **"Accept"**: visible when state is "awaiting_review"
- **"Apply patch"**: visible when state is "completed"

---

### 3.5 CREATE OVERLAY (Modal Form)

**Purpose**: Create new spec via natural language request

**Trigger**: Click "+ Ask" button in rail

**Structure** (`#create-overlay`):

**Header**:
- **Eyebrow**: "Skill-driven intake"
- **Title**: "What should change?"
- **Close button**: X button to dismiss

**Intro text**:
```
Describe the feature, bug, refactor, or question in your own words. 
An agent inspects the repository and creates the canonical SpecOps document. 
No worktree, implementation, or source-code changes are created during analysis.
```

**Form Fields** (`#create-form`):
- **Textarea** (`#intake-request`):
  - `required`, `maxlength="12000"`
  - Spellcheck enabled
  - Placeholder: "For example: session history search should support model and date filters, and remain fast with thousands of sessions."

**Status Display** (`#create-status`):
- Hidden until submission
- Shows "Analyzing...", "Creating spec...", etc.

**Error Display** (`#create-error`):
- Hidden unless error
- Role="alert" for accessibility
- Shows error messages

**Action Buttons**:
- **Cancel** (secondary button)
- **Analyze request** (primary button, type=submit)

---

## 4. Current UI Layout & Appearance

### Color Scheme (CSS Variables)

**Dark Mode (default)**:
```css
--void: #0d0f0e       /* Background */
--iron: #111413       /* Panels */
--steel: #181b19      /* Cards/buttons */
--line: #262b28       /* Borders */
--paper: #edefeb      /* Text color */
--muted: #70776f      /* Subdued text */
--cyan: #9fe870       /* Success/primary */
--signal: #e6b450     /* Warning */
--danger: #ff6b6b     /* Error */
```

**Light Mode** (via system preference or `data-theme="light"`):
```css
--void: #F7F7F3       /* Light background */
--iron: #ECEDE8
--paper: #171A18      /* Dark text */
--cyan: #216E45       /* Green success */
--signal: #B7791F     /* Orange warning */
--danger: #C24141     /* Red error */
```

### Layout Grid

```css
.shell {
  display: grid;
  grid-template: 
    64px minmax(0, 1fr) 
    / 270px minmax(420px, 1fr) 272px;
  /* Results in:
     64px = masthead height
     270px = rail width
     272px = diagnostics width
     Rest = flexible editor area
  */
}
```

### Font Stack

```css
font-family: "Avenir Next", "SF Pro Text", -apple-system, 
             BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

For monospace (code/IDs):
```css
--mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
```

### Component Styling Examples

**Buttons**:
- Border: 1px solid --line
- Border-radius: 6px
- Background: --steel
- Hover: slight color shift
- Primary button: additional --cyan background

**Textarea/Input**:
- Background: --steel
- Color: --paper
- Border: 1px solid --line
- Focus: outline-color --cyan

**Diagnostic Cards**:
- Classes: `diagnostic error` / `diagnostic warning` / `diagnostic info`
- Left border color indicates severity
- Padding and spacing for readability

---

## 5. JavaScript Frontend Logic (`app.js`)

### Core Functions

#### **Token Extraction & Persistence** (lines 1-4)
```javascript
const fragment = new URLSearchParams(location.hash.slice(1))
const token = fragment.get('token') || sessionStorage.getItem('specops-token') || ''
if (token) sessionStorage.setItem('specops-token', token)
history.replaceState(null, '', location.pathname) // Remove token from URL bar
```
- Reads token from URL fragment (injected by kode GUI)
- Falls back to sessionStorage (for page refresh)
- Clears fragment from URL for security

#### **Theme Management** (lines 6-20)
```javascript
function applyTheme(theme)
window.addEventListener('message', (event) => { ... })
```
- Reads `?theme=` URL param
- Listens for postMessage events from parent (kode GUI can change theme)
- Applies to `document.documentElement.dataset.theme`

#### **API Helper** (lines 44-52)
```javascript
async function api(path, options = {})
```
- Wraps Fetch API
- Injects Bearer token in Authorization header
- Sets Content-Type: application/json
- Throws on error status codes

#### **Rendering Diagnostics** (lines 54-74)
```javascript
function renderDiagnostics(items)
```
- Clears and rebuilds diagnostic list
- Updates count badge
- Creates diagnostic cards with severity coloring
- Shows "No drift or gate errors" when empty

#### **Opening Documents** (lines 76-104)
```javascript
async function openDocument(document, button)
async function openChangeFile(changeFolder, file, button)
```
- Fetches full document content from `/api/document?path=...`
- Updates UI (title, kind, content textarea)
- Tracks selected document for saving
- Shows editor, hides empty state

#### **Run Polling & Status** (lines 106-133)
```javascript
function showRun(run)
let pollTimer = null
function startRunPolling()
function stopRunPolling()
```
- Displays active Run in diagnostics panel
- Shows state transitions (running → awaiting_verify → awaiting_review → completed)
- Button visibility depends on state
- Polls `/api/runs/{run_id}` every 3s

#### **Document Rendering** (lines 135-175+)
```javascript
function renderDocuments(items)
function makeSection(kind, label, items, onClick)
function makeChangeSection(changes)
```
- Builds sidebar navigation from spec/change/archive groups
- Collapsible sections with counts
- Nested change files under change folders
- Event handlers for selection

### API Endpoints Called

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/document` | GET | Fetch document content by path |
| `/api/runs/{run_id}` | GET | Poll Run status |
| `/api/scans` | GET | Get spec list and structure |
| Various write/action endpoints | POST | (Server routes not fully visible in app.js) |

---

## 6. Server Integration (`server/index.ts`)

### Key HTTP Routes (partial visibility)

**Security**:
- Bearer token validation on all requests
- `Origin` header verification
- Body size limit: 1 MB
- `sec-fetch-site` CORS check for browser requests

**Static Files**:
- `/` → index.html
- `/styles.css` → CSS
- `/app.js` → JavaScript

**API Routes** (inferred from app.js calls):
- `GET /api/document?path=<encoded-path>` → Full document content
- `GET /api/scans` → Workspace scan results (spec list)
- `GET /api/runs/{run_id}` → Run status and results
- `POST /api/runs/<run_id>/feedback` → Submit human feedback (inferred)
- Various run control endpoints (verify, accept, apply, etc.)

### Ready Message Protocol

When `specops serve` starts, it outputs a structured JSON message to stdout:
```json
{
  "type": "ready",
  "origin": "http://127.0.0.1:12345",
  "token": "<random-32+-byte-hex-string>"
}
```

The kode GUI captures this and uses it to:
1. Inject token into iframe URL fragment
2. Inject theme via postMessage
3. Create Tauri webview window with the origin

---

## 7. Design Characteristics

### UI Philosophy

- **Terminal-like aesthetic**: Dark theme by default, monospace for IDs, clean typography
- **Minimal but complete**: Every UI element has clear purpose, no decorative fluff
- **Keyboard-friendly**: Collapsible sections, tab navigation, Enter to submit
- **Real-time**: Polling-based updates (upgradeable to WebSocket for v2)
- **Responsive**: Flexbox grid adapts (though min-widths prevent extreme shrinking)

### Accessibility

- Semantic HTML: `<nav>`, `<article>`, `<label>`, etc.
- ARIA labels: `aria-label="Spec documents"`, `role="alert"`
- Color + text for status (not color-only)
- Form validation (`required`, `maxlength`)

### No Existing Screenshots or Design Files

Search through the project found **no design files** (Figma exports, mockups, SVGs):
- No `.figma` files
- No `.sketch` files
- No `*.png` / `*.jpg` screenshots in the repo
- `docs/` directory contains only text ROADMAP (no visuals)

The UI is **pure code-driven design**, implemented directly in HTML/CSS/JS without intermediate design tools.

---

## 8. File Locations Summary

| File | Lines | Purpose |
|------|-------|---------|
| `/apps/specops/src/server/public/index.html` | 96 | Main UI structure, form fields, panels |
| `/apps/specops/src/server/public/app.js` | ~450+ | Frontend logic, DOM manipulation, API calls |
| `/apps/specops/src/server/public/styles.css` | ~400+ | Layout, colors, responsive grid, animations |
| `/apps/specops/src/server/index.ts` | ~500+ | HTTP server, routing, auth, API endpoints |
| `/apps/specops/src/domain/*.ts` | Various | Business logic (spec parsing, gate logic, drift detection) |
| `/apps/specops/src/adapters/kode.ts` | ~200 | Phase 9 protocol client for kode integration |
| `/apps/specops/package.json` | 35 | Dependencies, build scripts, version |

---

## 9. Tech Stack Hierarchy

```
User (opens kode GUI with ⌘S)
  ↓
kode Tauri App (apps/gui/)
  ├─ Spawns: specops serve [Node process]
  └─ Hosts: <iframe src="http://127.0.0.1:PORT/#token=...">
      ↓
      SpecOps Web UI (apps/specops/)
      ├─ HTML/CSS/JS (no framework)
      ├─ Fetches from: /api/* endpoints
      ├─ WebSocket: Status updates
      └─ Communicates with: SpecOps Node backend
          ↓
          SpecOps Node Server (TypeScript)
          ├─ HTTP routing & auth
          ├─ Domain logic (spec/gate/drift)
          ├─ Calls kode via Phase 9:
          │  └─ HTTP: POST /sessions (create tab)
          │  └─ WS: Connect to agent output stream
          └─ Manages: Git worktrees, Run lifecycle
```

---

## 10. Current Implementation Status

**Completed** ✅:
- HTML/CSS/JS skeleton (all UI components present)
- Document navigation and selection
- Spec/change/archive sections
- Create overlay form UI
- Diagnostics display
- Run status panel (UI structure)
- Token injection and auth flow
- Theme switching (dark/light)
- Basic API integration

**Partially Complete** 🟡:
- Run polling (structure ready, business logic pending)
- Feedback form (UI ready, submission logic pending)
- Action buttons (UI present, handlers being connected)

**Not Yet** ⏳:
- Full Run lifecycle UI updates
- Verification flow integration
- Patch application UI
- Error boundary/toast notifications
- Accessibility testing

---

## 11. Key Insights for Frontend Development

### Design Principles Observed

1. **Single-threaded state**: No state manager (Redux/Zustand) — plain JS variables
2. **Progressive enhancement**: Page works without JS but with reduced UX
3. **URL-based auth**: Token in fragment, not cookies (avoids CSRF, survives page reload)
4. **Polling over WebSocket**: MVP uses `setInterval` for updates (can upgrade later)
5. **Minimal framework**: Vanilla JS shows complexity is primarily in logic, not rendering

### Constraints

- **Token security**: Never logged, cleared from URL immediately
- **Loopback-only**: `127.0.0.1:random-port` prevents LAN exposure
- **Browser isolation**: iframe in kode GUI doesn't have access to kode's bridge token
- **Worktree isolation**: User's main working tree never directly modified

### Extension Points

- Replace polling with WebSocket for real-time updates
- Add offline-first state sync (currently in-memory only)
- Introduce component library for consistent UI (currently inline CSS)
- Add keyboard shortcuts (not currently implemented)
- Implement diff viewer (currently just text display)

---

## Conclusion

**SpecOps Frontend** is a **deliberately minimal, vanilla web interface** that prioritizes:
- **Simplicity** over framework complexity
- **Security** through loopback-only access and token injection
- **Responsiveness** with real-time updates (polling-based MVP, upgradeable)
- **Integration** with kode's existing ecosystem via Phase 9 protocol

The UI is **production-ready in structure** but still in **active development** for Run lifecycle features. No design files exist outside the code itself — the design is **native to the implementation**.

---
