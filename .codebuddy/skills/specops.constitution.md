---
name: specops-constitution
description: Project-level invariants and guardrails. Read .specops/constitution.md before any SpecOps work. Amend only via explicit user request.
---

# SpecOps Constitution

The constitution at `.specops/constitution.md` holds project-level invariants
that override individual changes. Every SpecOps skill MUST read it first.

## When to read
- Before intake, clarify, analyze, or create-run.
- Before writing any proposal.md.

## When to amend
- Only when the user explicitly asks to change a project invariant.
- Amendments are themselves a `change` (kind: change) that updates the file.
- Never silently edit constitution.md during intake.

## Structure
- `## Principles` — high-level values
- `## Invariants` — must-not / must-always rules
- `## Guardrails` — process constraints (e.g. "no new deps without design.md")

If `constitution.md` is missing, treat the project as having no invariants and
emit a warning via drift.
