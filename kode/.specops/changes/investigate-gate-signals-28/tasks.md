# Tasks

## Phase 1: Diagnose the 28 signals

- [ ] Run `specops gate --base HEAD~30 --head HEAD` to enumerate all gate diagnostics
- [ ] Run `specops drift` to enumerate all drift diagnostics (stale paths, unknown verifies, wild specs)
- [ ] Run `specops analyze` to enumerate cross-artifact consistency gaps
- [ ] Categorize all 28 signals by source and diagnostic code
- [ ] Identify which signals are:
  - False positives (already-suppressed but still visible due to severity downgrade not hiding)
  - Legitimate but low-priority (warnings that don't block work)
  - Actionable (errors that need fixing)

## Phase 2: Determine why `fix-gate-errors-and-intake-ordering` didn't resolve the issue

- [ ] Verify that `specops.toml` suppression config is correctly parsed by the gate logic
- [ ] Check if `suppress_codes` downgrades errors to warnings but doesn't hide them from the panel
- [ ] Check if `suppress_commit_types` only matches `chore:` but not `feat:`/`fix:`/`refactor:` etc.
- [ ] Verify task 4 (Rust test verification) is the only remaining unchecked item
- [ ] Document the gap between "suppression" (downgrade severity) and "resolution" (zero visible signals)

## Phase 3: Propose resolution strategy

- [ ] If the fix is trivial (e.g., add more commit type prefixes to suppress, hide warnings by default):
  - Create actionable tasks in this tasks.md
- [ ] If the fix requires code changes to the SpecOps engine (e.g., new "hide warnings" toggle):
  - Create a follow-up change proposal with design.md
- [ ] Estimate effort for each resolution path
