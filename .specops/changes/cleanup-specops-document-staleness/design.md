# Design: SpecOps document staleness cleanup

## Problem diagnosis

### The clarify guardrail lifecycle gap

The clarify workflow (`.codebuddy/skills/specops.clarify.md`) was introduced as Phase 0 of the SpecOps workflow. It enforces multi-turn Q&A before any document is written. This is paired with:

- `specops.constitution.md` — read constitution before any SpecOps operation
- `specops.checklist.md` — verify Motivation/Scope/Acceptance/Out-of-scope exist before writing receipt
- `specops.analyze.md` — cross-artifact consistency check before creating a run

The gap: **Implementation is decoupled from intake.** The workflow requires explicit user approval (Phase 3: Launch Run) before implementation begins. If the user never approves, or if work gets done through other channels (manual edits, other agents), the proposals remain in `proposed` status with all tasks unchecked — permanently out of sync with reality.

### Specific staleness cases

#### Case 1: Duplicate frontmatter proposals

| Field | `add-frontmatter-to-migrated-specs` | `specs-frontmatter-batch` |
|---|---|---|
| Intake | `da01571b` | `bf8432c0` |
| Kind | `bug` | `refactor` |
| Files | 11 | 11 (same) |
| Status | `proposed` | `proposed` |
| Tasks | All unchecked | All unchecked |
| Actual state | Frontmatter added to all 11 files | Frontmatter added to all 11 files |

Both describe the same work. Both are stale. `specs-frontmatter-batch` is the better artifact (more complete design.md, better ID scheme). Archive `add-frontmatter-to-migrated-specs`, update `specs-frontmatter-batch` to `implemented`.

#### Case 2: Obsolete fix proposal

`fix-migrate-docs-proposal-staleness` proposed two fixes:

- **Bug 1**: `/api/document` crashes on tasks.md/design.md → Fixed in `d351f0d`
- **Bug 2**: Stale references in migrate-docs-to-specops proposal → Already fixed (proposal body updated)

Both fixes are in place. The change folder is obsolete.

#### Case 3: Contradictory status

`migrate-docs-to-specops` says `status: implemented` in frontmatter but "This migration has not been executed" in the body. The truth: Phase 1-4 file moves were executed (tasks checked), but the migration's implicit goal of "all specs have frontmatter" was never in its task list. That was handled separately by `specs-frontmatter-batch`. The status note in the body is misleading — replace with an accurate summary.

#### Case 4: Inconsistent design.md convention

| File | Has frontmatter? |
|---|---|
| `add-frontmatter-to-migrated-specs/design.md` | No |
| `fix-migrate-docs-proposal-staleness/design.md` | No |
| `specs-frontmatter-batch/design.md` | Yes |
| `migrate-docs-to-specops/design.md` | No |

The skill spec says design.md is "free-form technical notes." Frontmatter is optional per the spec. The inconsistency is cosmetic but confusing.

**Recommendation**: No frontmatter on design.md. The change folder's `proposal.md` already carries all metadata. Adding frontmatter to design.md creates ambiguity about whether it's an independent document or subordinate to the proposal. For the one file that has it (`specs-frontmatter-batch/design.md`), remove it.

#### Case 5: Empty constitution

`.specops/constitution.md` is all placeholders:
- Principles: `(placeholder) State the project's core values here.`
- Invariants: `(placeholder) Must-not / must-always rules.`
- Guardrails: `(placeholder) Process constraints.`

Four spec documents already document actual invariants:
- `project-overview.md`: single-threaded tests, GUI/TUI independence, no nested git repos
- `pty-lifecycle.md`: no shared Mutex<Child>, independent killer handle
- `backend-default-args.md`: no positional args in defaults
- `specops-run-isolation.md`: detached worktrees for runs

Extract these into the constitution so it actually serves its intended guardrail purpose.

## Archive strategy

### What to archive

| Change folder | Reason |
|---|---|
| `add-frontmatter-to-migrated-specs/` | Superseded by `specs-frontmatter-batch`; work completed |
| `fix-migrate-docs-proposal-staleness/` | Both bugs already fixed |

### Where to archive

Move to `.specops/changes/archive/` with the same folder name. The archive already has `_legacy-investigations/` for old analysis files; completed/superseded change folders should go directly under `archive/`.

### What NOT to archive

- `migrate-docs-to-specops/` — keep active, just fix the status note. It accurately records the file migration history.
- `specs-frontmatter-batch/` — keep active, update to `implemented`. It's the canonical record of the frontmatter addition.

## Constitution population approach

Read the four source specs and extract their invariant statements. Write them into `.specops/constitution.md` under the appropriate sections:

```markdown
## Principles
- Tests must run single-threaded (`-- --test-threads=1`) due to PTY fd contention
- GUI and TUI are independent implementations; do not couple them
- ...

## Invariants
- PtyHost must use independent killer handle, not share Mutex<Child> with reaper
- Backend default args must not include positional arguments (they become LLM prompts)
- ...

## Guardrails
- SpecOps runs must use detached worktrees (git worktree add --detach)
- ...
```

## Rollback

All operations are file edits within `.specops/`. `git checkout` reverts everything. No source code is touched.
