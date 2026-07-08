---
schema_version: 1
id: migrate-docs-to-specops
kind: change
title: Migrate scattered .md docs into SpecOps structure
status: completed
verifies:
  - specops
paths:
  - ROADMAP.md
  - docs/
  - .specops/
  - SPECOPS_FRONTEND_COMPONENTS.md
  - SPECOPS_FRONTEND_EXPLORATION.md
  - SPECOPS_INDEX.md
  - SPECOPS_QUICK_REFERENCE.md
---

# Migrate scattered .md docs into SpecOps structure

> **Status**: Phase 1-4 file moves were executed (all tasks checked). All 11 docs were `git mv`'d to `.specops/specs/` and stale analysis files were archived. Frontmatter was not added during this migration — that was handled separately by `specs-frontmatter-batch`.

## Motivation

The kode repository has accumulated `.md` files at multiple levels (root, `docs/`, `docs/roadmap/`, `apps/specops/docs/`) without a consistent organization. SpecOps provides a canonical home for specs, design documents, and roadmap archives. This refactor consolidates everything except agent instructions and READMEs into `.specops/`.

Key issues:

- **Two truths problem**: `ROADMAP.md` references `docs/roadmap/phase-0-7-tui-to-gui.md` and `docs/roadmap/phase-11-remote-backend.md`, while these are sub-documents that should live alongside the main roadmap.
- **Stale analysis files**: Root-level reports (`FLUTTER_DIAGNOSIS.md`, `RESUME_BUG_ANALYSIS.md`, etc.) document past investigations whose conclusions have either been acted on or superseded. They clutter the root directory.
- **Design docs under `docs/`**: `MEMORY_DESIGN.md`, `MEMORY_GIT_SYNC.md`, `PROTOCOL.md`, `MEMORY_QUICKSTART.md` are all design specs or contracts that belong under `.specops/specs/`.
- **Sub-project `apps/specops/docs/`**: SpecOps' own docs (`ROADMAP.md`, `CLI.md`, `PERFORMANCE.md`, `SECURITY.md`) live outside `.specops/` despite being about SpecOps itself.

## Scope

### In scope
- Move roadmap sub-documents from `docs/roadmap/` into `.specops/specs/`
- Move design docs from `docs/` into `.specops/specs/`
- Archive stale root-level analysis files under `.specops/archive/`
- Decide whether `apps/specops/docs/` should stay or move into `.specops/specs/specops-engine/`
- Add redirect notes or deprecation markers in old locations

### Out of scope
- `CODEBUDDY.md`, `CLAUDE.md`, `AGENTS.md` — agent instructions, stay put
- `README.md` — project README, stay put
- `apps/mobile/README.md`, `services/kode-server-go/README.md` — sub-project READMEs, stay put
- `.codebuddy/skills/*.md` — skill definitions, stay put
- Existing `.specops/specs/*.md` — already canonical, no changes

## Classification of all .md files

### ROADMAP DOCS → `.specops/specs/`

| Current path | Proposed path | Rationale |
|---|---|---|
| `ROADMAP.md` | `.specops/specs/roadmap.md` | Primary roadmap; leave a one-line redirect at root |
| `docs/roadmap/phase-0-7-tui-to-gui.md` | `.specops/specs/roadmap-phase-0-7.md` | Archived phase detail |
| `docs/roadmap/phase-11-remote-backend.md` | `.specops/specs/roadmap-phase-11.md` | Active phase detail |

### DESIGN DOCS → `.specops/specs/`

| Current path | Proposed path | Rationale |
|---|---|---|
| `docs/MEMORY_DESIGN.md` | `.specops/specs/memory-design.md` | Design contract for kode-memory |
| `docs/MEMORY_GIT_SYNC.md` | `.specops/specs/memory-git-sync.md` | Design contract for git sync |
| `docs/PROTOCOL.md` | `.specops/specs/remote-protocol.md` | Cross-implementation contract |
| `docs/MEMORY_QUICKSTART.md` | `.specops/specs/memory-quickstart.md` | User-facing spec for memory onboarding |

### STALE ANALYSIS → `.specops/archive/`

| Current path | Rationale |
|---|---|
| `FLUTTER_DIAGNOSIS.md` | Diagnostics from initial Flutter-Bridge integration; fixes applied |
| `FLUTTER_FIXES.md` | Fix proposals for Flutter integration; fixes applied |
| `INVESTIGATION_REPORT.md` | Resume flow investigation (2026-06-19); bug understood, root cause documented |
| `RESUME_BUG_ANALYSIS.md` | Detailed resume flow analysis; conclusion reached |
| `RESUME_BUG_SUMMARY.md` | Summary of same investigation |
| `SPECOPS_ANALYSIS.md` | Pre-build analysis of SpecOps; superseded by actual implementation |
| `memory_browser_exploration.md` | Code exploration notes from memory browser work; transient |
| `SPECOPS_FRONTEND_COMPONENTS.md` | **(NEW)** Exploration notes on SpecOps frontend component reference; transient, captured in session 2026-06-21 |
| `SPECOPS_FRONTEND_EXPLORATION.md` | **(NEW)** Deep-dive exploration of SpecOps frontend code; transient analysis, conclusions absorbed into implementation |
| `SPECOPS_INDEX.md` | **(NEW)** Index/overview of SpecOps frontend exploration session; transient, superseded by actual code |
| `SPECOPS_QUICK_REFERENCE.md` | **(NEW)** Quick-reference card from SpecOps frontend exploration; transient, could live as code comment |

### REFERENCE (keep or archive based on utility)

| Current path | Disposition | Rationale |
|---|---|---|
| `SCROLL_BEHAVIOR_ANALYSIS.md` | Archive | Detailed scroll analysis, but scroll behavior is well-understood now |
| `SCROLL_FLOW_QUICK_REF.md` | Archive | Quick reference; useful but could live as a code comment |

### SUB-PROJECT DOCS → stay or internal move

| Current path | Proposed path | Rationale |
|---|---|---|
| `apps/specops/docs/ROADMAP.md` | `.specops/specs/specops-engine-roadmap.md` | SpecOps engine roadmap; belongs in canonical specops |
| `apps/specops/docs/CLI.md` | `.specops/specs/specops-engine-cli.md` | CLI reference |
| `apps/specops/docs/PERFORMANCE.md` | `.specops/specs/specops-engine-perf.md` | Performance baseline |
| `apps/specops/docs/SECURITY.md` | `.specops/specs/specops-engine-security.md` | Security model |

### EXISTING `.specops/changes/` cleanup

None needed — the sub-change folders previously referenced (`migrate-design-docs-to-specops/`, `migrate-roadmap-to-specops/`) were never created. The `specops-theme-follows-kode.md` change was also never created.

## Risks

- **Broken links**: `ROADMAP.md` and `CODEBUDDY.md` contain relative links to `docs/roadmap/` and `docs/MEMORY_DESIGN.md`. After migration, redirect stubs must be left at old paths, or links updated.
- **Git history**: Moving files via `git mv` preserves history; plain moves do not. Recommend `git mv` for all active docs.
- **External references**: `docs/PROTOCOL.md` is referenced by `docs/protocol-smoke.sh`. The smoke script path reference must be updated.
