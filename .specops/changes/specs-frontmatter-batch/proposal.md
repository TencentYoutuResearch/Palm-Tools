---
schema_version: 1
id: specs-frontmatter-batch
kind: refactor
title: Add missing YAML frontmatter to 10 spec files under .specops/specs/
status: completed
verifies:
  - specops
paths:
  - .specops/specs/memory-design.md
  - .specops/specs/memory-git-sync.md
  - .specops/specs/memory-quickstart.md
  - .specops/specs/remote-protocol.md
  - .specops/specs/roadmap.md
  - .specops/specs/roadmap-phase-0-7.md
  - .specops/specs/roadmap-phase-11.md
  - .specops/specs/specops-engine-cli.md
  - .specops/specs/specops-engine-perf.md
  - .specops/specs/specops-engine-roadmap.md
  - .specops/specs/specops-engine-security.md
---

# Add missing YAML frontmatter to 10 spec files

> **Status**: Implementation complete. All 11 files listed below have been prepended with YAML frontmatter. Verified by inspection on 2026-06-23.

## Motivation

The SpecOps spec format requires every spec document to begin with YAML
frontmatter containing `schema_version`, `id`, `kind`, `title`, and `status`.
10 out of 15 files under `.specops/specs/` lack this frontmatter.

This is a mechanical fix — the body content of each file is preserved verbatim.
The IDs are chosen to follow the naming convention established by existing
specs with frontmatter (`backend/default-args`, `pty/lifecycle`, etc.):

| File | Chosen ID |
|---|---|
| memory-design.md | memory/design |
| memory-git-sync.md | memory/git-sync |
| memory-quickstart.md | memory/quickstart |
| remote-protocol.md | remote/protocol |
| roadmap.md | roadmap |
| roadmap-phase-0-7.md | roadmap/phase-0-7 |
| roadmap-phase-11.md | roadmap/phase-11 |
| specops-engine-cli.md | specops/engine-cli |
| specops-engine-perf.md | specops/engine-perf |
| specops-engine-roadmap.md | specops/engine-roadmap |
| specops-engine-security.md | specops/engine-security |

## Status

All specs receive `status: active` (they describe existing project state or
settled design decisions) except `roadmap-phase-11.md` which is marked `draft`
(its header says "草稿" / draft).

## Paths

Each file is modified only by prepending the frontmatter block. No body
content is changed.
