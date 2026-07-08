# Tasks

## Task 1: Fix stale `verifies` in remote-protocol.md

- [ ] Remove `go` from the `verifies` list in `.specops/specs/remote-protocol.md`
- [ ] The corrected frontmatter should read `verifies: [rust, specops]`
- [ ] Run `specops drift --json` and confirm `ok: true` with zero errors

## Task 2: Rename panel label and "no diagnostics" message

- [ ] In `apps/specops/src/server/public/index.html:91`, change
      `<span class="diag-head-label">Gate signals</span>` to
      `<span class="diag-head-label">Diagnostics</span>`
- [ ] In `apps/specops/src/server/public/app.js:67`, change
      `'No drift or gate errors.'` to `'No diagnostics.'`
- [ ] Regenerate `dist/` via `pnpm build` and verify both files are updated

## Task 3: Improve diagnostic count badge

- [ ] In `apps/specops/src/server/public/app.js`, update `renderDiagnostics()` to
      show error/warning breakdown in the badge:
  - Count errors and warnings separately
  - Display format: if only warnings, show "W:N" with amber class; if errors exist,
    show "E:N W:M" with red class
  - Replace `diagCount.textContent = String(items.length)` with breakdown logic
  - Update `diagCount.classList.toggle('has-errors', ...)` to also add `has-warnings`
- [ ] In `apps/specops/src/server/public/styles.css`, add `.diag-count-badge.has-warnings`
      styling with amber color scheme, and remove or increase `min-width` to
      accommodate longer text like "1 error, 4 warnings"
- [ ] Regenerate `dist/` via `pnpm build`

## Task 4: Fix suppress_commit_types colon mismatch

- [ ] In `apps/specops/src/domain/gate.ts:106`, strip trailing colon from `firstWord`
      before checking `suppressTypes`:
  ```typescript
  const firstWord = commit.message.split('\n')[0]?.split(/\s+/)[0]?.toLowerCase()
  const commitType = firstWord?.endsWith(':') ? firstWord.slice(0, -1) : firstWord
  if (commitType && suppressTypes.includes(commitType)) continue
  ```
- [ ] This makes `suppress_commit_types = ["chore"]` match `chore: add node modules`
      without requiring users to put colons in their config

## Task 5: Expand suppress_commit_types

- [ ] Update `specops.toml` to add the repo's actual commit conventions:
  ```toml
  [gate.suppress]
  suppress_codes = ["missing_reference", "unknown_reference"]
  suppress_commit_types = ["chore", "feat", "fix", "refactor", "test", "debug", "docs"]
  ```
- [ ] Run `specops gate --base HEAD~30 --head HEAD --json` and confirm:
  - Zero errors (all gate diagnostics are warnings)
  - Significantly fewer warnings (most commits should be suppressed by type)
- [ ] Expected: ~22 commits suppressed by type, ~8 remaining (those with unusual
      prefixes like "SpecOps migration:" or scoped prefixes like "feat(gui):")

## Task 6: Add `analyze` CLI subcommand

- [ ] In `apps/specops/src/cli/main.ts`:
  - Import `analyzeWorkspace` from `'../domain/gate.js'`
  - Add `analyze` to the HELP text
  - Add a `command === 'analyze'` branch that calls `analyzeWorkspace(workspace)`
    and outputs results (same pattern as `drift` and `gate`)
- [ ] Run `specops analyze --json` and confirm it outputs cross_artifact_gap results

## Task 7: Add test coverage for suppress_commit_types

- [ ] In `apps/specops/tests/gate.test.ts`, add a test:
  - Create a workspace with `specops.toml` containing
    `suppress_commit_types = ["feat"]`
  - Create a commit with message `feat: add something`
  - Run `gateWorkspace` and verify the commit is NOT in diagnostics
  - Create another commit with message `fix: broken thing`
  - Verify the `fix:` commit IS flagged as `missing_reference`
- [ ] Run `pnpm test` and confirm the new test passes

## Task 8: Verification

- [ ] Run `specops drift --json` → `ok: true`, zero errors
- [ ] Run `specops gate --base HEAD~30 --head HEAD --json` → zero errors, reduced warnings
- [ ] Run `specops analyze --json` → outputs cross-artifact gaps for non-archived changes
- [ ] Build the SpecOps console (`pnpm build`) and verify:
  - `dist/server/public/index.html` says "Diagnostics" not "Gate signals"
  - `dist/server/public/app.js` says "No diagnostics." not "No drift or gate errors."
  - `dist/server/public/app.js` has the error/warning breakdown logic
- [ ] Run `pnpm test` in `apps/specops/` to confirm all tests pass
- [ ] Start `specops serve` and visually confirm:
  - Panel heading says "Diagnostics"
  - Badge shows breakdown like "1 error, 4 warnings" or "W:5" if no errors
  - After fixing `go` verify, badge should show zero errors
