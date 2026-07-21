---
schema_version: 1
id: fix-migrate-docs-proposal-staleness
kind: change
title: Fix stale proposal references and missing-frontmatter crash on tasks.md/design.md
status: proposed
verifies:
  - specops
paths:
  - apps/specops/src/server/index.ts
  - apps/specops/src/domain/spec.ts
  - .specops/changes/migrate-docs-to-specops/
---

# Fix stale proposal references and missing-frontmatter crash on tasks.md/design.md

## Bug 1: `/api/document` crashes on `tasks.md` / `design.md` with "missing YAML frontmatter"

### Reproduction

1. Open SpecOps UI, click `migrate-docs-to-specops` in the Changes list
2. UI calls `GET /api/document?path=.specops/changes/migrate-docs-to-specops/tasks.md`
3. Server crashes: `missing YAML frontmatter`

### Root cause

`GET /api/document` at `apps/specops/src/server/index.ts:220-224` calls `parseDocument()` on every file served through the endpoint. `parseDocument()` at `apps/specops/src/domain/spec.ts:91-112` requires YAML frontmatter (`---\n...\n---`). But `tasks.md` and `design.md` are plain markdown checklists — they intentionally have no frontmatter.

The Skill definition (`specops.intake.md`) explicitly says `tasks.md` is just a checklist:
```markdown
- [ ] Add theme context and CSS variables
```

### Why it surfaces now

The new change folder `fix-migrate-docs-proposal-staleness` added `tasks.md` and `design.md` alongside `proposal.md`. When the UI tries to display these files (via `openChangeFile` in `app.js:92`), the `/api/document` endpoint rejects them.

The existing `migrate-docs-to-specops` change folder also has `tasks.md` and `design.md`, so this bug is latent — it would crash if the UI ever tried to display those files.

### Fix

`GET /api/document` should detect whether the requested file is `proposal.md` (with frontmatter) or an auxiliary file like `tasks.md` / `design.md` (plain markdown), and skip `parseDocument()` for plain files:

**Option A (minimal)**: In `server/index.ts`, check if the requested path ends with `proposal.md` — only parse frontmatter for proposals, serve raw content for everything else.

**Option B (cleaner)**: Add a helper `isProposalDoc(path)` and branch the `/api/document` handler.

## Bug 2: Stale references in `migrate-docs-to-specops` proposal body

### Symptom

The `migrate-docs-to-specops` change is the only entry in the SpecOps UI "Changes" list. Its `proposal.md` body references resources that don't exist on disk:

| Reference | Status |
|---|---|
| `migrate-design-docs-to-specops/` | Never created |
| `migrate-roadmap-to-specops/` | Never created |
| `specops-theme-follows-kode.md` | Never created |

### Root cause

The proposal was written as a forward-looking plan by an intake agent. The migration was never executed (all tasks in `tasks.md` are unchecked). The proposal describes target state, not current state.

### Why rescan doesn't fix it

`scanWorkspace()` re-reads `proposal.md` from disk and returns its content as-is. There is no validation step that cross-references body claims against the filesystem.

### Fix

- Remove the three phantom rows from the "Existing `.specops/changes/` cleanup" table in `proposal.md`
- Add a status note at the top of the proposal body: "This migration has not been executed"

## Tasks

See `tasks.md`.

## Scope

### In scope
- Fix `/api/document` to not require YAML frontmatter for non-proposal files in change folders
- Remove stale references from `migrate-docs-to-specops/proposal.md`
- Add implementation status note to `migrate-docs-to-specops/proposal.md`

### Out of scope
- Actually performing the document migration
- Adding proposal-body validation to `scanWorkspace()` / `driftWorkspace()`
