# Tasks

## Phase 1: Resolve duplicate frontmatter proposals

- [x] 1.1 Archive `add-frontmatter-to-migrated-specs/` — move to `.specops/changes/archive/add-frontmatter-to-migrated-specs/` (it's superseded by `specs-frontmatter-batch` which has a more complete tasks list and design.md)
- [x] 1.2 Update `specs-frontmatter-batch/proposal.md`: change `status` from `proposed` to `implemented`, add a note in the body that frontmatter has been added to all 11 files
- [x] 1.3 Update `specs-frontmatter-batch/tasks.md`: mark all 11 file tasks as `[x]` and the verify task as `[x]` (all 11 files now have correct frontmatter per inspection)

## Phase 2: Archive obsolete fix-migrate-docs-proposal-staleness

- [x] 2.1 Archive `fix-migrate-docs-proposal-staleness/` → `.specops/changes/archive/fix-migrate-docs-proposal-staleness/`
  - Bug 1 (frontmatter crash) was fixed in commit `d351f0d`
  - Bug 2 (stale references) was already fixed — the proposal body now correctly says "None needed"

## Phase 3: Fix migrate-docs-to-specops status accuracy

- [ ] 3.1 Update `migrate-docs-to-specops/proposal.md` body: replace "This migration has not been executed" with an accurate summary of what was done (files were `git mv`'d, but frontmatter was not added — that happened later via `specs-frontmatter-batch`)
- [ ] 3.2 Mark tasks 5.3 and 6.3 as either `[x]` (if done) or add a note explaining why they're skipped
- [ ] 3.3 Verify `status: implemented` in frontmatter is correct (the file moves were executed, so this is accurate)

## Phase 4: Normalize design.md frontmatter

- [ ] 4.1 Decide convention: either all `design.md` files in change folders get frontmatter, or none do
- [ ] 4.2 Apply chosen convention:
  - If "all with frontmatter": add `---` blocks to `add-frontmatter-to-migrated-specs/design.md` and `fix-migrate-docs-proposal-staleness/design.md` (but only if those folders aren't archived — skip for archived folders)
  - If "none": remove frontmatter from `specs-frontmatter-batch/design.md`
  - Recommendation: **no frontmatter** (design.md is free-form per the skill spec, and the change folder's `proposal.md` already carries the metadata)

## Phase 5: Populate constitution.md

- [x] 5.1 Extract invariants from `project-overview.md`: single-threaded tests, GUI independence from TUI, no nested git repos
- [x] 5.2 Extract invariants from `pty-lifecycle.md`: no shared Mutex<Child> for wait+kill, independent killer handle
- [x] 5.3 Extract invariants from `backend-default-args.md`: no positional args in backend default args
- [x] 5.4 Extract invariants from `specops-run-isolation.md`: runs use detached worktrees
- [x] 5.5 Write the extracted invariants into `.specops/constitution.md`, replacing the placeholders
- [x] 5.6 Add a "last updated" note at the bottom of constitution.md

## Phase 6: Verify

- [ ] 6.1 Confirm no two active change folders describe the same work
- [ ] 6.2 Confirm all active change folders have accurate statuses
- [ ] 6.3 Confirm `grep -r "proposed" .specops/changes/*/proposal.md` shows no false positives (proposed work that is actually done)
- [ ] 6.4 Confirm `.specops/constitution.md` has no remaining placeholders
