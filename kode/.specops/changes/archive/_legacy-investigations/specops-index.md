# SpecOps Frontend UI - Complete Exploration Index

This directory contains comprehensive documentation about the SpecOps frontend UI code discovered and analyzed on 2026-06-21.

## Summary

**SpecOps** is a **spec-driven execution console** for the kode AI agent system. It enables users to:
- Define specs (constraints/requirements) for Git repositories
- Enforce compliance gates (automatic validation)
- Orchestrate AI agent execution in isolated worktrees
- Review and approve changes with human-in-the-loop verification

**Status**: MVP development (Phases 1-6 active)  
**Technology**: Node/TypeScript backend, vanilla HTML/CSS/JavaScript frontend (no frameworks)  
**Entry Point**: Launched from kode GUI via ⌘S keyboard shortcut

---

## Documentation Files

### 1. SPECOPS_QUICK_REFERENCE.md (START HERE)
**Best for**: Quick overview, common tasks, key files, design system  
**Size**: 11KB  
**Contains**:
- Executive summary
- Layout diagram (3-column grid)
- Main UI components breakdown
- Color/typography system
- JavaScript architecture overview
- Run lifecycle (MVP semi-automatic flow)
- Common tasks (view spec, create spec, execute)
- Development priorities

**Read this first if you want**: A quick understanding of what SpecOps does and how the UI is organized

### 2. SPECOPS_FRONTEND_EXPLORATION.md (COMPREHENSIVE)
**Best for**: Deep dive into architecture, design, and implementation details  
**Size**: 20KB  
**Contains**:
- Detailed "What is SpecOps?" section with full workflow
- Complete tech stack breakdown
- Detailed component descriptions (MASTHEAD, RAIL, WORKSPACE, DIAGNOSTICS, CREATE OVERLAY)
- Layout specifications and grid system
- Color scheme (dark/light modes)
- JavaScript logic breakdown (all major functions)
- Server integration details
- Design philosophy and accessibility
- Current implementation status (completed/partial/pending features)
- Key insights for developers
- Future extension points

**Read this if you want**: Complete understanding of the architecture, design decisions, and current state

### 3. SPECOPS_FRONTEND_COMPONENTS.md (REFERENCE)
**Best for**: Component-by-component breakdown, HTML structure, event handlers  
**Size**: 10KB  
**Contains**:
- File locations (absolute paths)
- Detailed UI component breakdown with HTML examples
- JavaScript state variables
- CSS grid layout specifications
- Color variables reference table
- API endpoints reference
- Theme switching mechanism
- Security features breakdown

**Read this if you want**: To understand specific UI components or look up details (like "where is the health indicator?")

### 4. SPECOPS_ANALYSIS.md (EXISTING)
**Best for**: Integration points, kode GUI interaction, protocol details  
**Size**: 15KB  
**Contains**:
- File locations in kode GUI and SpecOps apps
- Frontend integration with kode GUI
- Backend integration with Phase 9 protocol
- Issue analysis (token encoding, iframe sandbox, etc.)
- Data flow diagrams
- Security considerations
- Recommendations for bug fixes

**Read this if you want**: To understand how SpecOps integrates with the larger kode system

---

## Quick Navigation

### I want to... | Read...
---|---
Understand what SpecOps does in 2 minutes | SPECOPS_QUICK_REFERENCE.md (Executive Summary)
Understand the UI layout | SPECOPS_QUICK_REFERENCE.md (Layout section) or SPECOPS_FRONTEND_EXPLORATION.md (section 3)
Find a specific UI component | SPECOPS_FRONTEND_COMPONENTS.md
Understand JavaScript functions | SPECOPS_FRONTEND_EXPLORATION.md (section 5)
Check the design system | SPECOPS_QUICK_REFERENCE.md (Design System) or SPECOPS_FRONTEND_COMPONENTS.md (Color Variables)
Understand API endpoints | SPECOPS_FRONTEND_COMPONENTS.md (API Endpoints Called)
Learn about Run lifecycle | SPECOPS_QUICK_REFERENCE.md (Run Lifecycle) or SPECOPS_FRONTEND_EXPLORATION.md (section 6)
Understand security model | SPECOPS_FRONTEND_COMPONENTS.md (Security Features)
See development roadmap | SPECOPS_QUICK_REFERENCE.md (Next Steps)
Understand kode integration | SPECOPS_ANALYSIS.md

---

## Key File Locations (Absolute Paths)

| File | Lines | Purpose |
|------|-------|---------|
| `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/index.html` | 96 | UI HTML structure |
| `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/app.js` | 450+ | Frontend JavaScript logic |
| `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/public/styles.css` | 400+ | CSS styling |
| `/Users/marxwang/Projects/youtu/app/kode/apps/specops/src/server/index.ts` | 500+ | HTTP server & routing |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ User (opens kode GUI with ⌘S)                           │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
    ┌────────────────────────────┐
    │ kode Tauri GUI (apps/gui)  │
    │ • File picker              │
    │ • Spawns specops serve     │
    │ • Hosts iframe             │
    └─────┬──────────────────────┘
          │
          ▼
    ┌─────────────────────────────┐
    │ SpecOps Web UI (embedded)   │
    │ • HTML/CSS/JavaScript       │
    │ • 3-column grid layout      │
    │ • Vanilla (no framework)    │
    └─────┬───────────────────────┘
          │ HTTP/WS
          ▼
    ┌─────────────────────────────┐
    │ SpecOps Backend (Node/TS)   │
    │ • HTTP server               │
    │ • Business logic            │
    │ • Phase 9 client            │
    └─────┬───────────────────────┘
          │ Phase 9 protocol
          ▼
    ┌─────────────────────────────┐
    │ kode Bridge (agent backend) │
    │ • Create tabs               │
    │ • Stream output             │
    └─────────────────────────────┘
```

---

## Design Philosophy

**SpecOps Frontend** is deliberately **minimal and vanilla**:

- **No framework**: Pure HTML/CSS/JavaScript (no React, Vue, Svelte)
- **Direct DOM control**: Simple `.textContent` updates, no virtual DOM
- **Terminal-like aesthetic**: Dark theme, monospace IDs, clean typography
- **Security-first**: Token in URL fragment, immediate cleanup, loopback-only
- **Single-threaded state**: Global variables, no Redux/Zustand
- **Code-driven design**: No Figma exports, design lives in CSS/HTML

---

## UI Layout

**Main Grid** (3 columns × 2 rows):

```
┌─────────────────────────────────────────┐
│         MASTHEAD (64px)                 │
├──────────┬──────────────────┬──────────┤
│  RAIL    │   WORKSPACE      │ DIAGNOSTICS
│ (270px)  │ (flexible, min   │ (272px)
│          │  420px)          │
│ Specs    │                  │ Gate
│ Changes  │ Editor           │ signals
│ Archive  │                  │
│          │                  │ Run panel
│ Buttons  │                  │ (hidden)
└──────────┴──────────────────┴──────────┘
```

---

## Color System

**Dark Mode** (default):
- Background: #0d0f0e (--void)
- Panels: #111413 (--iron)
- Text: #edefeb (--paper)
- Accents: #9fe870 (--cyan)

**Light Mode** (system preference or `?theme=light`):
- Colors invert (light backgrounds, dark text)

---

## Run Lifecycle (MVP - Semi-Automatic)

```
User clicks "Implement in isolated worktree"
  → SpecOps creates Git worktree
  → Requests kode to spawn agent tab
  → Agent executes in worktree
  → [state: "running"]
  → User clicks "Run verify" (manual in MVP)
  → Run gate/test verification
  → [state: "awaiting_review"]
  → User reviews results
  → Click Accept or Send feedback
  → [state: "completed"]
  → Click "Apply patch" to merge
```

**Key Limitation**: Full auto is v2 (currently user must click "Run verify")

---

## Technology Stack

| Layer | Tech | Reason |
|-------|------|--------|
| **Runtime** | Node.js 20+ | TypeScript compiled target |
| **Frontend Framework** | None (vanilla) | Minimal bundle, direct control |
| **HTTP** | Node http module | Simplicity, no Express overhead |
| **WebSocket** | ws package | Event streaming |
| **Config** | YAML + TOML | User config, language-neutral |
| **Build** | TypeScript + Bun | Fast compilation, bundling |
| **Test** | Vitest | TypeScript-aware |

---

## No Design Files

This is **important**: There are NO design files (Figma, Sketch, SVG, PNG) in the repository.

- UI is **100% code-driven**
- Design lives in CSS variables and HTML structure
- Easy to understand by reading source
- Easy to fork or replicate by copying HTML/CSS

---

## Current Implementation Status

### Completed ✅
- HTML/CSS/JS skeleton (all UI present)
- Document navigation & selection
- Create overlay form
- Diagnostics display
- Token injection & auth
- Theme switching
- Basic API integration

### In Progress 🟡
- Run polling (structure ready, handlers pending)
- Feedback form (UI ready, submission pending)
- Action buttons (UI present, logic pending)

### Not Yet ⏳
- Full Run lifecycle handlers
- Verification flow integration
- Patch application UI
- Error boundaries/toast notifications
- Accessibility testing

---

## Security Model

1. **Token Handling**:
   - Passed via URL fragment (not sent to server on subsequent requests)
   - Immediately cleared: `history.replaceState()`
   - Stored in sessionStorage for page refresh
   - Sent as Bearer token for API calls

2. **Network**:
   - Loopback-only: 127.0.0.1:random-port
   - Origin header validation
   - CORS checks via sec-fetch-site

3. **XSS Prevention**:
   - `.textContent` for all updates (not `.innerHTML`)
   - No eval() or dynamic code
   - CSS as single source of truth

---

## Next Steps

### For Understanding
1. Read SPECOPS_QUICK_REFERENCE.md (5 min overview)
2. Read SPECOPS_FRONTEND_EXPLORATION.md (detailed dive)
3. Browse SPECOPS_FRONTEND_COMPONENTS.md for specifics
4. Look at source files:
   - `/apps/specops/src/server/public/index.html` (structure)
   - `/apps/specops/src/server/public/app.js` (logic)
   - `/apps/specops/src/server/public/styles.css` (design)

### For Development
1. Complete Run lifecycle button handlers
2. Implement verification flow (Run verify button)
3. Add feedback submission loop
4. Build patch application UI
5. Upgrade to WebSocket (v2)
6. Add diff viewer (v2)

---

## Questions?

Refer to the specific document that matches your question type:
- **"What is SpecOps?"** → SPECOPS_QUICK_REFERENCE.md
- **"How does X component work?"** → SPECOPS_FRONTEND_COMPONENTS.md
- **"What's the overall architecture?"** → SPECOPS_FRONTEND_EXPLORATION.md
- **"How does it integrate with kode?"** → SPECOPS_ANALYSIS.md

---

**Created**: 2026-06-21  
**Total Documentation**: 57KB across 4 comprehensive guides  
**Coverage**: Complete frontend UI, integration points, design system, development roadmap

