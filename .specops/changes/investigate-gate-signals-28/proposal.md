---
schema_version: 2
id: investigate-gate-signals-28
kind: investigation
document_class: work_item
work_type: investigation
title: Investigate why 28 Gate signals persist and have not been resolved
status: cancelled
verifies:
  - specops
paths:
  - .specops/changes/fix-gate-errors-and-intake-ordering/
  - specops.toml
  - apps/specops/src/domain/gate.ts
  - apps/specops/src/domain/commands.ts
---

# Investigate why 28 Gate signals persist and have not been resolved

## Motivation

The SpecOps "Gate signals" panel in the console shows **28 diagnostic items** (errors + warnings). A previous change proposal `fix-gate-errors-and-intake-ordering` was created to address 26 gate errors, and tasks 1-3 have been marked complete (adding suppress configuration to `specops.toml`, fixing console assets tests, fixing intake document ordering). However, the gate signal count has **increased from 26 to 28** since that proposal was written, and the underlying issues have not been fully resolved.

The user asks: **why are these 28 gate signals still present, and why haven't they been handled?**

### Current state of `fix-gate-errors-and-intake-ordering`

Tasks 1-3 are marked `[x]` (completed):
- Task 1: Console assets tests fixed
- Task 2: Gate error suppression configuration added to `specops.toml` (`suppress_codes = ["missing_reference", "unknown_reference"]`, `suppress_commit_types = ["chore"]`)
- Task 3: Intake document ordering fixed (most recent first)

Task 4 is **not checked**: Rust workspace test verification.

### Why the suppression doesn't eliminate all signals

The suppression configuration in `specops.toml` downgrades `missing_reference` and `unknown_reference` diagnostics from `error` to `warning` severity — but they are still **shown** in the Gate signals panel (the panel shows all diagnostics regardless of severity). The `suppress_commit_types = ["chore"]` only skips commits starting with `chore:`, but the repo's commit conventions use `feat:`, `fix:`, `refactor:`, `test:`, `debug:` etc.

Additionally, the 28 signals are composed of multiple sources:
1. **Gate diagnostics** (from `gateWorkspace()`): missing/unknown commit references from recent commits not using `chore:` prefix — these are downgraded to warnings but still counted
2. **Drift diagnostics** (from `driftWorkspace()`): stale paths, unknown verify bindings, wild spec files, missing constitution
3. **Analyze diagnostics** (from `analyzeWorkspace()`): cross-artifact consistency gaps between proposal.md, tasks.md, and design.md
4. **Scan diagnostics** (from `scanWorkspace()`): YAML frontmatter parsing errors in spec/change documents

The `suppress_codes` config only affects gate diagnostics (making them warnings instead of errors), but:
- It doesn't remove them from the display
- It doesn't affect drift/analyze/scan diagnostics
- It only covers `missing_reference` and `unknown_reference`, not other diagnostic codes

### Root cause: the fix was partial

The `fix-gate-errors-and-intake-ordering` proposal treated the 26 gate errors as a configuration problem (add suppression), but didn't address:
- That suppression only downgrades severity, not visibility
- That drift and analyze diagnostics contribute to the total count
- That the commit message convention doesn't match the suppression pattern (`chore:` only)
- That task 4 (Rust test verification) was never completed

## Scope

### In scope

- Analyze the exact composition of the 28 gate signals (break down by source and diagnostic code)
- Determine which signals are false positives (suppressed but still shown, already-fixed but not updated, etc.)
- Propose concrete actions to reduce the signal count to zero or to a manageable level
- Recommend improvements to the suppression mechanism if needed (e.g., hide warnings by default, add more commit type filters)

### Out of scope

- Implementing any code changes in this investigation
- Modifying source files in `apps/specops/` or any other code
- Creating new SpecOps features
- Modifying existing spec documents (other than this investigation's documents)

## Acceptance criteria

- [ ] Clear breakdown of the 28 signals by source (gate/drift/analyze/scan) and diagnostic code
- [ ] Identification of which signals are false positives or already-addressed
- [ ] Recommendation for concrete next steps to resolve the remaining signals
- [ ] If the fix is trivial, tasks.md should contain actionable steps; if complex, it should propose a follow-up change

## Out of scope

- Implementing the fix itself (this is investigation-only)
- Changing the SpecOps server or gate logic
- Modifying commit history or commit messages
- Addressing unrelated SpecOps console issues
