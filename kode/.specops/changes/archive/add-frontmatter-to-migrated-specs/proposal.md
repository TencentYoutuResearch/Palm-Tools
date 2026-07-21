---
schema_version: 1
id: add-frontmatter-to-migrated-specs
kind: bug
title: Add YAML frontmatter to 11 migrated spec docs that are missing it
status: proposed
verifies:
  - specops
paths:
  - .specops/specs/roadmap.md
  - .specops/specs/roadmap-phase-0-7.md
  - .specops/specs/roadmap-phase-11.md
  - .specops/specs/memory-design.md
  - .specops/specs/memory-git-sync.md
  - .specops/specs/memory-quickstart.md
  - .specops/specs/remote-protocol.md
  - .specops/specs/specops-engine-roadmap.md
  - .specops/specs/specops-engine-cli.md
  - .specops/specs/specops-engine-perf.md
  - .specops/specs/specops-engine-security.md
---

# Add YAML frontmatter to 11 migrated spec docs that are missing it

## Bug: SpecOps UI crashes with "missing YAML frontmatter" on migrated docs

### Reproduction

1. Open SpecOps UI, click on any of the 11 migrated spec files
2. UI calls `GET /api/document?path=.specops/specs/<name>.md`
3. Server crashes: `missing YAML frontmatter`

### Root cause

Commit `71d9e61` ("refactor: update docs") executed the `migrate-docs-to-specops` plan, moving 11 documents from `ROADMAP.md`, `docs/`, `docs/roadmap/`, and `apps/specops/docs/` into `.specops/specs/` using `git mv`. These documents were originally plain Markdown (README-style docs, design notes, roadmap pages) with no YAML frontmatter.

The SpecOps server's `parseDocument()` at `apps/specops/src/domain/spec.ts:91-112` requires all files under `.specops/specs/` to start with `---\n<yaml>\n---`. Since the migrated files have no frontmatter, any attempt to display them in the SpecOps UI crashes.

### Affected files (11 total)

Files migrated without frontmatter in `71d9e61`:

| File | Original location | Missing frontmatter? |
|---|---|---|
| `.specops/specs/roadmap.md` | `ROADMAP.md` | YES |
| `.specops/specs/roadmap-phase-0-7.md` | `docs/roadmap/phase-0-7-tui-to-gui.md` | YES |
| `.specops/specs/roadmap-phase-11.md` | `docs/roadmap/phase-11-remote-backend.md` | YES |
| `.specops/specs/memory-design.md` | `docs/MEMORY_DESIGN.md` | YES |
| `.specops/specs/memory-git-sync.md` | `docs/MEMORY_GIT_SYNC.md` | YES |
| `.specops/specs/memory-quickstart.md` | `docs/MEMORY_QUICKSTART.md` | YES |
| `.specops/specs/remote-protocol.md` | `docs/PROTOCOL.md` | YES |
| `.specops/specs/specops-engine-roadmap.md` | `apps/specops/docs/ROADMAP.md` | YES |
| `.specops/specs/specops-engine-cli.md` | `apps/specops/docs/CLI.md` | YES |
| `.specops/specs/specops-engine-perf.md` | `apps/specops/docs/PERFORMANCE.md` | YES |
| `.specops/specs/specops-engine-security.md` | `apps/specops/docs/SECURITY.md` | YES |

### Files already with frontmatter (4 — unaffected)

These were created by the SpecOps intake skill and already have valid YAML frontmatter:

- `project-overview.md`
- `pty-lifecycle.md`
- `backend-default-args.md`
- `specops-run-isolation.md`

### Why the existing fix didn't cover this

Commit `d351f0d` ("fix(specops): handle non-frontmatter files in change folders") added the `isSpecDocumentPath()` guard to skip `parseDocument()` for `tasks.md`/`design.md` inside change folders. This was a server-side fix that only addressed auxiliary files in change folders — it did NOT address spec files under `.specops/specs/`, which are expected to have frontmatter per the SpecOps design.

### Why the migration didn't add frontmatter

The `migrate-docs-to-specops` change folder's `tasks.md` listed `git mv` operations but never mentioned adding YAML frontmatter to the moved files. The migration was a mechanical file move, not a format conversion. The intake skill (`specops.intake.md`) requires frontmatter for spec files, but the migration plan was written before this constraint was fully understood.

## Scope

### In scope

- Add YAML frontmatter to all 11 migrated spec files under `.specops/specs/`
- Each frontmatter block must include: `schema_version`, `id`, `kind: spec`, `title`, `status`, and appropriate `paths`

### Out of scope

- Changing the file content beyond adding frontmatter
- Modifying the SpecOps server's `parseDocument()` (the server behavior is correct — spec files must have frontmatter)
- Moving files back to original locations
- Adding frontmatter to `.specops/archive/` files (archive files are not parsed by SpecOps)

## Risks

- **Minimal**: Frontmatter is metadata prepended to existing content; no content is removed or altered
- **`paths` field accuracy**: The `paths` field should reference the source code paths that the spec governs. For migrated docs like `roadmap.md` that describe project-wide plans, the appropriate `paths` may be broader than a single source file. Use judgment.
