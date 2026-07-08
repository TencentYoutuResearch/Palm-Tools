---
name: specops-checklist
description: Quality gate for proposal.md before intake receipt is written. Verifies motivation, scope, acceptance criteria, out-of-scope, constitution alignment.
---

# SpecOps Checklist

Run this checklist BEFORE writing the intake receipt. If any section is missing,
fix the proposal first. Do not write the receipt until all required sections exist.

## Required sections in proposal.md body
- `## Motivation` — why this change is needed
- `## Scope` — what is included
- `## Acceptance criteria` — verifiable outcomes (bullet list)
- `## Out of scope` — explicit exclusions

## Constitution alignment
- Read `.specops/constitution.md`.
- If the proposal conflicts with any invariant, add a `## Constitution conflicts`
  subsection documenting the conflict and the resolution.

## Failure handling
If a section cannot be filled in, state why in that section rather than
omitting it. An empty section is a checklist failure.
