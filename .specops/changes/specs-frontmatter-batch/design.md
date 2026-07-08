# Frontmatter content decisions

## Why batch this as a single change

All 10 files suffer the same mechanical defect (missing YAML frontmatter).
Splitting into 10 separate changes would create unnecessary review overhead
with no benefit — each edit is purely additive and independent.

## ID scheme

Existing specs with frontmatter use either flat IDs (`project-overview`,
`roadmap`) or slash-prefixed IDs (`backend/default-args`, `pty/lifecycle`).
The new IDs follow the same convention:

- `memory/` prefix for the memory subsystem files
- `remote/` prefix for the remote protocol spec
- `roadmap/` prefix for the phased sub-roadmaps
- `specops/` prefix for engine-specific specs

## Status assignment

- `roadmap-phase-11.md` is marked `draft` because its H1 reads "草稿" (draft).
  All others are `active` since they describe current or settled project state.

## Verifies

All files share `verifies: [specops]` because the fix is about spec document
format compliance, not any particular code module.

## Paths

Each file path is listed individually so the `paths` field accurately reflects
every file touched.
