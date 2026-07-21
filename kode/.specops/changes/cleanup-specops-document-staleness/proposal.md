---
schema_version: 2
id: cleanup-specops-document-staleness
kind: refactor
document_class: work_item
work_type: refactor
title: Clean up SpecOps document staleness from clarify guardrail proliferation
status: cancelled
verifies:
  - specops
paths:
  - .specops/changes/add-frontmatter-to-migrated-specs/
  - .specops/changes/specs-frontmatter-batch/
  - .specops/changes/fix-migrate-docs-proposal-staleness/
  - .specops/changes/migrate-docs-to-specops/
  - .specops/constitution.md
---

# Clean up SpecOps document staleness from clarify guardrail proliferation

## Motivation

The introduction of the clarify workflow (`.codebuddy/skills/specops.clarify.md`, `specops.checklist.md`, `specops.constitution.md`, `specops.analyze.md`) as Phase 0 guardrails in the SpecOps workflow has created a proliferation of change folders that are now **stale** — they describe work that has either been completed without updating their status, or duplicate each other, or reference problems that no longer exist.

### Root cause analysis

The clarify → intake → checklist pipeline is designed to produce well-validated proposals. However, when the implementation phase is decoupled (requiring explicit user approval to launch a run), the proposals accumulate in `proposed` status indefinitely. Meanwhile, work gets done through other channels (direct edits, other agents, manual fixes) without the change folders being updated.

### Specific issues found

1. **Duplicate proposals for the same completed work**: Both `add-frontmatter-to-migrated-specs` (intake `da01571b`) and `specs-frontmatter-batch` (intake `bf8432c0`) propose adding YAML frontmatter to 11 migrated spec files. The frontmatter has since been added to all 11 files (verified by inspection), but both proposals remain at `status: proposed` with all tasks unchecked.

2. **`migrate-docs-to-specops` status is wrong**: Its `proposal.md` says `status: implemented`, but the body says "This migration has not been executed." The Phase 1-4 tasks are checked, but the overall status contradicts the body. The actual state is that files were `git mv`'d (tasks checked) but the migration's goal of "add frontmatter to all specs" was never part of its task list — it was a mechanical file move only.

3. **`fix-migrate-docs-proposal-staleness` is obsolete**: It proposed two fixes:
   - Bug 1 (frontmatter crash on tasks.md/design.md): Already fixed in commit `d351f0d` ("fix(specops): handle non-frontmatter files in change folders").
   - Bug 2 (stale references in migrate-docs-to-specops proposal): Already fixed — the proposal body now says "None needed — the sub-change folders previously referenced...were never created" (line 103-104).

4. **Inconsistent `design.md` frontmatter**: Two of three `design.md` files in change folders lack YAML frontmatter (`add-frontmatter-to-migrated-specs/design.md`, `fix-migrate-docs-proposal-staleness/design.md`), while `specs-frontmatter-batch/design.md` has it. The skill spec says design.md is "free-form technical notes" — frontmatter is optional but inconsistency is confusing.

5. **Empty constitution**: `.specops/constitution.md` is all placeholders. Every SpecOps operation reads it, but it provides zero guardrail value. The actual invariants are scattered across individual spec files.

## Scope

### In scope

- Archive duplicate/stale change folders that describe completed or superseded work
- Update `migrate-docs-to-specops` status to accurately reflect what was and wasn't done
- Normalize `design.md` files: either all with frontmatter or all without (consistent convention)
- Populate `.specops/constitution.md` with actual invariants derived from existing spec documents
- Update `specs-frontmatter-batch` tasks to reflect that frontmatter has been added (mark tasks as done, update status)

### Out of scope

- Adding new clarify guardrail logic (this is about cleaning up existing documents, not changing the pipeline)
- Modifying the SpecOps server code (`apps/specops/src/`)
- Creating new spec documents beyond constitution amendments
- Changing file content of the 11 spec files (their frontmatter is already correct)

## Acceptance criteria

- [ ] `add-frontmatter-to-migrated-specs/` is either archived or merged into `specs-frontmatter-batch` with updated status
- [ ] `fix-migrate-docs-proposal-staleness/` is archived (both bugs it describes are already fixed)
- [ ] `migrate-docs-to-specops/proposal.md` status accurately reflects executed vs unexecuted tasks
- [ ] All `design.md` files in change folders follow a consistent frontmatter convention
- [ ] `.specops/constitution.md` contains at least the invariants documented in `project-overview.md`, `pty-lifecycle.md`, `backend-default-args.md`, and `specops-run-isolation.md`
- [ ] No two change folders describe the same work
- [ ] No change folder describes already-completed work as `proposed`

## Out of scope

- Adding automated staleness detection to the SpecOps server
- Implementing any code changes in `apps/specops/` or any source files
- Creating new spec documents beyond the constitution update
- Modifying the clarify/checklist/analyze skills themselves
