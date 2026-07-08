# SpecOps Frontend - Quick Reference Guide

## Executive Summary

SpecOps is an AI-powered **spec-driven execution console** that:
- Lets users define specs (constraints) for Git repositories
- Automatically enforces gates (compliance checking)
- Orchestrates agent execution via isolated worktrees
- Provides human-in-the-loop verification and approval

**Tech**: Node/TypeScript backend, vanilla HTML/CSS/JS frontend (no framework)  
**Integration**: Launched from kode GUI (⌘S), embedded as webview iframe  
**Status**: MVP development (Phase 1-6 active)

---

## Key Files (Absolute Paths)

| File | Purpose |
|------|---------|
| `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/index.html` | UI Structure (96 lines) |
| `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/app.js` | Frontend Logic (450+ lines) |
| `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/styles.css` | Styling (400+ lines) |
| `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/index.ts` | Backend (500+ lines) |

## Layout (3-Column Grid)

```
┌─── MASTHEAD (64px height, full width) ────────────────┐
│ KODE/SPECOPS | Constraint workspace | [Health Status] │
├─────────────┬──────────────────────┬─────────────────┤
│ RAIL        │ WORKSPACE            │ DIAGNOSTICS     │
│ (270px)     │ (flexible, min 420px)│ (272px)         │
│             │                      │                 │
│ • Specs     │ Empty state or:      │ Gate signals    │
│ • Changes   │ • Document editor    │ (error cards)   │
│ • Archive   │ • Save button        │                 │
│             │ • Run button         │ Run panel:      │
│ + Ask btn   │                      │ • Status        │
│ Rescan btn  │                      │ • Feedback form │
│             │                      │ • Action buttons│
└─────────────┴──────────────────────┴─────────────────┘
```

## Main UI Components

### 1. MASTHEAD
- Branding: "KODE / SPECOPS"
- Title: "Constraint workspace"
- Health indicator: Loading (yellow) → Ready (green) or Error (red)

### 2. RAIL (Sidebar)
- **Rail Head**: "Specs & Changes" with Rescan + Ask buttons
- **Doc Sections**: Specs, Changes (with nested files), Archive
- **Each doc**: Clickable button with status/ID metadata

### 3. WORKSPACE (Center)
- **Empty State**: "Select a constraint..." prompt
- **Editor**: Markdown + YAML frontmatter textarea
- **Header**: Document kind/status/ID, Save & Run buttons
- **Save State**: Shows "Saved source" or "Unsaved changes"

### 4. DIAGNOSTICS (Right Panel)
- **Gate Signals**: Error/warning/info cards
- **Run Panel** (when active):
  - Current state (running, awaiting_review, completed)
  - Run ID (unique identifier)
  - Feedback textarea (awaiting_review only)
  - Context buttons: Verify, Terminal, Send Feedback, Accept, Apply

### 5. CREATE OVERLAY (Modal)
- **Trigger**: Click "+ Ask" button
- **Form**: Natural language request (max 12,000 chars)
- **Submission**: "Analyze request" button
- **Feedback**: Status and error messages

---

## Design System

### Colors (Dark Mode Default)

| Variable | Hex | Usage |
|----------|-----|-------|
| --void | #0d0f0e | Main background |
| --iron | #111413 | Panel backgrounds |
| --steel | #181b19 | Buttons/cards |
| --line | #262b28 | Borders |
| --paper | #edefeb | Text (foreground) |
| --cyan | #9fe870 | Success/primary action |
| --signal | #e6b450 | Warning/status |
| --danger | #ff6b6b | Error state |
| --muted | #70776f | Secondary text |

**Light Mode**: System preference or `?theme=light` parameter (colors invert)

### Typography

- **Body**: "Avenir Next", "SF Pro Text", system sans-serif
- **Monospace**: "SF Mono", "JetBrains Mono", Menlo
- **Eyebrow**: 9px, uppercase, monospace, muted color
- **Headings**: 19px h1, 600 weight

---

## JavaScript Architecture

### State Management (Global Variables, No Framework)

```javascript
const token          // From URL fragment, then sessionStorage
let selectedPath     // Currently viewed document path
let selectedVersion  // For conflict detection
let selectedDocument // Full metadata
let activeRun        // {run_id, state, ...}
let pollTimer        // Run status polling (3s)
```

### Core Functions

| Function | Purpose |
|----------|---------|
| `api(path, options)` | Fetch wrapper (adds token header) |
| `openDocument(doc, btn)` | Load and display spec/change |
| `renderDocuments(items)` | Rebuild sidebar (specs, changes, archive) |
| `showRun(run)` | Update run panel with latest state |
| `startRunPolling()` / `stopRunPolling()` | Poll `/api/runs/{id}` every 3s |
| `renderDiagnostics(items)` | Render gate signal cards |
| `applyTheme(theme)` | Apply light/dark mode |

### API Calls

| Endpoint | Method | Triggered By |
|----------|--------|------|
| `/api/document?path=<encoded>` | GET | Click spec/change button |
| `/api/scans` | GET | Page load, click Rescan |
| `/api/runs/{run_id}` | GET | Poll every 3s during active run |
| `/api/runs/{run_id}/feedback` | POST | Click "Send feedback" (inferred) |
| `/api/create-spec` | POST | Submit intake form (inferred) |

**Auth**: All requests include `Authorization: Bearer {token}`

---

## Security Features

1. **Token Injection**:
   - Passed via URL fragment (not query string, not body)
   - Immediately cleared from address bar: `history.replaceState()`
   - Stored in sessionStorage for page refresh
   - Sent as Bearer token in Authorization header

2. **Network**:
   - Loopback-only: `127.0.0.1:random-port`
   - Origin header validation
   - sec-fetch-site CORS checks

3. **XSS Prevention**:
   - `.textContent` for all text (not `.innerHTML`)
   - No eval() or dynamic code execution
   - CSS classes as single source of truth

---

## Run Lifecycle (MVP - Semi-Automatic)

```
User clicks "Implement in isolated worktree"
  ↓
SpecOps creates Git worktree (isolated from user's working tree)
  ↓
SpecOps requests kode to spawn codebuddy/claude tab (Phase 9)
  ↓
Agent executes tasks in worktree
  ↓
[State: "running"]
User sees "Run verify" button appears
  ↓
User clicks "Run verify" button (manual trigger, MVP limitation)
  ↓
SpecOps runs gate/test verification in worktree
  ↓
Results: Green (pass) or Red (fail)
  ↓
If pass: [State: "awaiting_review"] → User accepts
If fail: [State: "awaiting_review"] → User provides feedback
  ↓
If accepted: [State: "completed"] → "Apply patch" button appears
  ↓
User clicks "Apply patch" to merge changes into main working tree
```

**Key MVP Compromise**: Human clicks "Run verify" button (full auto is v2 feature)

---

## Common Tasks

### View a Spec
1. Click spec name in RAIL (left sidebar)
2. Spec appears in WORKSPACE (center)
3. Read markdown content + YAML frontmatter
4. Gate signals appear in DIAGNOSTICS (right)

### Create a New Spec
1. Click "+ Ask" button in RAIL head
2. Type description in textarea (max 12,000 chars)
3. Click "Analyze request"
4. Agent creates spec document

### Execute a Spec
1. Select spec (see "View a Spec" above)
2. Click "Implement in isolated worktree" button
3. Wait for Run to appear in DIAGNOSTICS
4. Monitor run status (running → awaiting_verify → ...)
5. Click "Run verify" when ready
6. Review results and click Accept or provide feedback

### Switch Themes
- System preference (light/dark) applies automatically
- URL param `?theme=light` or `?theme=dark` overrides
- Parent (kode GUI) can send `postMessage({type: 'specops.theme', theme: '...'})`

---

## File Structure at a Glance

```
apps/specops/
├── src/
│   ├── server/
│   │   ├── index.ts             HTTP server, routing, auth
│   │   └── public/              Web files (embedded in dist)
│   │       ├── index.html       UI structure
│   │       ├── app.js           Frontend logic
│   │       └── styles.css       Styling
│   ├── domain/                  Business logic
│   │   ├── spec.ts              Spec parsing
│   │   ├── gate.ts              Gate enforcement
│   │   ├── run-loop.ts          Execution loop
│   │   ├── run.ts               Run lifecycle
│   │   └── intake.ts            Spec creation flow
│   ├── adapters/
│   │   └── kode.ts              Phase 9 protocol client
│   ├── cli/
│   │   └── main.ts              Command-line interface
│   ├── skills/                  Agent capabilities
│   └── store/                   Workspace state
├── tests/                       Vitest tests
├── dist/                        Compiled output
├── package.json                 Dependencies, build scripts
└── vitest.config.ts             Test configuration
```

---

## Development Notes

### No Framework Philosophy
- **Why**: Minimal bundle, direct DOM control, terminal-like simplicity
- **Trade-off**: Manual state management vs. framework overhead
- **Alternative**: Could be migrated to SvelteKit, Vue, React (but currently vanilla by design)

### Polling vs. WebSocket
- **MVP**: 3-second polling for run status (`GET /api/runs/{id}`)
- **v2 Plan**: Switch to WebSocket for real-time updates
- **Benefit**: Lower latency, reduced polling load

### No Design Files
- UI is **code-driven** (no Figma/Sketch exports)
- Design is part of CSS variables and HTML structure
- Easy to fork/copy design by reading source files

---

## Next Steps for Development

### Immediate Priorities (In Progress)
1. **Complete Run lifecycle UI** - Button handlers, state transitions
2. **Verification flow** - Manual "Run verify" button → auto in v2
3. **Feedback loop** - Rejection feedback → re-prompt same agent session
4. **Patch application** - Export/apply changes to main branch

### Medium-term (v2)
1. **WebSocket upgrade** - Real-time run status, eliminate polling
2. **Diff viewer** - Side-by-side changes (currently plain textarea)
3. **Keyboard shortcuts** - Ctrl+Enter submit, etc.
4. **Error boundaries** - Toast notifications, graceful failures
5. **Offline support** - State sync when connection restored

### Long-term (v3+)
1. **Multi-agent orchestration** - Squad mode
2. **Custom skills** - User-defined agent capabilities
3. **Cross-host runners** - Support remote execution
4. **Full automation** - Complete hands-free verification

---

## Reference Documents

- **Detailed Exploration**: `SPECOPS_FRONTEND_EXPLORATION.md` (this directory)
- **Component Reference**: `SPECOPS_FRONTEND_COMPONENTS.md` (this directory)
- **Architecture Analysis**: `SPECOPS_ANALYSIS.md` (existing)
- **ROADMAP**: `apps/specops/docs/ROADMAP.md` (Phases 0-8)

---

