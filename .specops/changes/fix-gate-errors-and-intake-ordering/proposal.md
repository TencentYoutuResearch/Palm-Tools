---
schema_version: 1
id: fix-gate-errors-and-intake-ordering
kind: bug
title: Fix gate errors, console assets test failures, and intake document ordering
status: completed
verifies:
  - specops
  - rust
paths:
  - apps/specops/src/domain/gate.ts
  - apps/specops/src/domain/commands.ts
  - apps/specops/src/server/public/index.html
  - apps/specops/src/server/public/app.js
  - apps/specops/tests/console-assets.test.ts
  - apps/specops/tests/console-assets.test.js
  - specops.toml
  - .specops/specs/
  - .specops/changes/
---

# Fix gate errors, console assets test failures, and intake document ordering

## Motivation

Three related quality-of-life issues in the SpecOps engine are degrading the developer experience:

### 1. Gate produces 26 errors on the last 20 commits

Running `specops gate --base HEAD~20 --head HEAD` on the kode repo produces **26 errors**:

- **19 `missing_reference` errors**: 19 of the last 20 non-merge commits have no `Spec:/Change:/Bug:/Refactor:/Feature:/Investigation:` reference in their commit message. This is by design — developers don't annotate every commit with a reference, especially for chores and small fixes — but the gate treats every unreferenced commit as an error.

- **7 `unknown_reference` errors**: Two commits have malformed references:
  - `71d9e61`: `refactor: update docs` — the colon-separated title is parsed as `Refactor: update` and `Refactor: docs`, neither of which are valid spec IDs.
  - `a4ec59a`: `refactor: token statistics reset-on-event with cumulative tracking` — parsed as 6 separate refactor IDs (`token`, `statistics`, `reset-on-event`, `with`, `cumulative`, `tracking`).

The gate is too strict for the actual development workflow. Options:
- **Suppress**: Allow configuring which error codes are suppressed (e.g., ignore `missing_reference` for certain commit types)
- **Filter commits**: Only gate commits that touch `.specops/` or source files
- **Whitelist patterns**: Allow commit message patterns like `chore:` / `fix:` / `feat:` to skip reference checks

### 2. Console assets tests fail: missing "Implement in isolated worktree" text

Two tests in `console-assets.test.ts` and `console-assets.test.js` fail because `index.html` no longer contains the text `Implement in isolated worktree`. The `index.html` was updated during the SpecOps migration (commit `c52781d`) but the test assertion wasn't updated to match.

The actual UI now says "Run in worktree" (in the editor header button) and "Apply patch" (in the run panel), but the text "Implement in isolated worktree" was removed. The test needs to be updated to assert on the current UI text.

### 3. New intake-created documents appear at the bottom of the sidebar

When a user creates a new change/spec via the "Ask" intake flow, the newly created document appears at the **bottom** of the sidebar list. This is because `scanWorkspace()` sorts documents alphabetically by `id` (`commands.ts:373`), and the sidebar renders in that order.

Expected behavior: newly created documents should appear at the **top** (most recent first), so users can immediately see the result of their intake.

## Scope

### In scope

- [ ] Add gate configuration option in `specops.toml` to suppress specific error codes (e.g., `missing_reference`) or skip certain commit types
- [ ] Fix console assets tests to match the current `index.html` content (update "Implement in isolated worktree" assertion)
- [ ] Change document sort order in `commands.ts` from alphabetical-by-id to most-recent-first (or add a configurable sort order)
- [ ] Update `renderDocuments()` in `app.js` to honor the new sort order (or reverse the current order)
- [ ] Ensure gate tests pass after changes
- [ ] Ensure console assets tests pass after changes

### Out of scope

- Changing the gate's core logic (e.g., making references optional for all commits)
- Adding a full-blown commit message parser with pattern whitelists
- Changing the intake flow's UI beyond the sidebar ordering
- Modifying the SpecOps server API contract

## Acceptance criteria

- [ ] Gate produces zero errors when `missing_reference` is configured as a warning or suppressed
- [ ] Gate correctly rejects commits with genuinely invalid/unknown spec references
- [ ] `console-assets.test.ts` and `console-assets.test.js` pass without modification to the test logic (only assertion text updated)
- [ ] New intake-created documents appear at the top of the sidebar list
- [ ] Existing documents maintain their sort order within their category
- [ ] All SpecOps tests pass (`pnpm test` in `apps/specops/`)
- [ ] Rust workspace tests pass (`cargo test -- --test-threads=1`)

## Out of scope

- Adding a full commit message convention (e.g., conventional commits) to the kode project
- Rewriting the gate to be a pre-commit hook
- Changing the intake UI beyond the sidebar ordering
- Adding any new SpecOps server API endpoints

## Constitution conflicts

None. This change does not modify any of the project invariants (PTY lifecycle, backend args, run isolation). The gate behavior change is additive (new config option, default unchanged), and the test fix is a mechanical update.
