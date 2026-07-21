---
schema_version: 2
id: fix-gate-signals-diagnostics
kind: bug
document_class: work_item
work_type: bugfix
title: Fix misleading "Gate signals" diagnostics panel — stale verifies, panel mislabeling, broken suppress, and noise
status: cancelled
verifies:
  - specops
paths:
  - .specops/specs/remote-protocol.md
  - apps/specops/src/server/public/app.js
  - apps/specops/src/server/public/index.html
  - apps/specops/src/server/public/styles.css
  - apps/specops/src/server/index.ts
  - apps/specops/src/domain/gate.ts
  - apps/specops/src/cli/main.ts
  - specops.toml
  - apps/specops/tests/gate.test.ts
---

# Fix misleading "Gate signals" diagnostics panel

## Motivation

The SpecOps "Gate signals" panel in the console shows error/warning counts that are
confusing and misleading. After two prior attempts to fix this
(`fix-gate-errors-and-intake-ordering` and `investigate-gate-signals-28`), the panel
still shows a non-zero error count. The user asks: "GATE SIGNALS 还是有很多错误提示信息,
你看看怎么解决,是skill问题么" (GATE SIGNALS still has many error messages, look at how
to solve it, is it a skill problem?).

### Answer: not a skill problem

The `.codebuddy/skills/specops.*.md` skills are documentation of the API contract —
they don't generate diagnostics. The problem is a combination of four data/code issues:

### Root cause analysis

**1. Stale `verifies` reference (the only actual error)**

`remote-protocol.md` declares `verifies: [rust, go, specops]` but `specops.toml` only
defines `rust` and `specops` verifies. No `go` verify exists. This produces:
```
error: unknown_verify - remote/protocol references unknown verify go
```
This is the **sole error** driving the non-zero count in the panel. All other
diagnostics are warnings.

Verified empirically:
- `specops scan --json` → 0 diagnostics
- `specops drift --json` → 1 error (`unknown_verify: go`)
- `specops gate --base HEAD~30 --head HEAD --json` → 36 warnings, 0 errors

**2. Panel mislabeling (code issue)**

The panel is titled "Gate signals" but does NOT display gate diagnostics. The
`/api/state` endpoint (`server/index.ts:155-157`) calls only `scanWorkspace`,
`driftWorkspace`, and `analyzeWorkspace` — but NOT `gateWorkspace`. The `refresh()`
function in `app.js` aggregates:

```javascript
const allDiags = [
  ...state.scan.diagnostics,     // 0 diagnostics
  ...state.drift.diagnostics,    // 1 error (unknown_verify "go")
  ...(state.analyze?.diagnostics ?? []),  // ~N warnings
]
```

Gate diagnostics (36 warnings from last 30 commits) are excluded from the panel
entirely. The panel title is misleading — it should say "Diagnostics", not
"Gate signals". Additionally, the "no diagnostics" message in `app.js:67` says
"No drift or gate errors" — another misleading reference to "gate".

**3. `suppress_commit_types` is broken (bug in prior fix)**

The `specops.toml` has `suppress_commit_types = ["chore"]`, but this **never matches
any commit**. The gate logic (`gate.ts:106-107`) extracts the first word with
`split(/\s+/)[0]`, which gives `chore:` (with colon) for commit `chore: add node modules`.
The suppress list has `"chore"` without colon, so `suppressTypes.includes("chore:")`
is always `false`.

This means the entire `suppress_commit_types` feature from
`fix-gate-errors-and-intake-ordering` has been non-functional since it was implemented.
There are no tests for suppress_commit_types in `gate.test.ts`.

The `suppress_codes` part works correctly (downgrades `missing_reference` and
`unknown_reference` from error to warning), but `suppress_commit_types` is a no-op.

**4. Warnings drown out the signal**

The analyze phase produces `cross_artifact_gap` warnings for each non-archived change
where proposal scope items aren't found in tasks.md, or design components aren't
referenced in tasks. These are useful heuristics but are all `warning` severity —
they don't block runs. Yet they contribute to the total count badge, making it
look like there are more problems than there actually are.

The current `renderDiagnostics()` (`app.js:60-82`) shows the total count
(`items.length`) and toggles a CSS class `has-errors` if any item is an error.
There's no visual distinction between error count and warning count in the badge.

### Why prior fixes didn't work

| Change | What it did | Why it didn't resolve the panel |
|---|---|---|
| `fix-gate-errors-and-intake-ordering` | Added `suppress_codes` + `suppress_commit_types` to `specops.toml` | Panel doesn't show gate diagnostics; `suppress_commit_types` is broken (colon mismatch); didn't fix `go` verify or panel label |
| `investigate-gate-signals-28` | Diagnosed the situation | Investigation-only, no implementation; recommendation missed the `suppress_commit_types` colon bug |

### Discoverability gap: no `specops analyze` CLI command

`analyzeWorkspace()` is implemented in `gate.ts` and called by the server API
(`/api/state` and `POST /api/analyze`), but there is no `analyze` subcommand in the
CLI (`cli/main.ts`). Users can't run cross-artifact checks from the terminal without
the server. This makes it harder to diagnose what's contributing to the panel count.

## Scope

### In scope

- [ ] Remove `go` from `verifies` in `remote-protocol.md` (no such verify exists)
- [ ] Rename the panel label from "Gate signals" to "Diagnostics" in `index.html`
- [ ] Fix the "No drift or gate errors" message in `app.js` to say "No diagnostics"
- [ ] Fix `suppress_commit_types` matching in `gate.ts` to strip trailing colon
      from the first word before comparing, OR update `specops.toml` values to
      include the colon (e.g., `"chore:"` instead of `"chore"`)
- [ ] Expand `suppress_commit_types` in `specops.toml` to cover the repo's actual
      commit conventions (`chore:`, `feat:`, `fix:`, `refactor:`, `test:`,
      `debug:`, `docs:`)
- [ ] Update the diagnostic count badge in `app.js` to show error/warning breakdown
      (e.g., "E:1 W:12") instead of just total count
- [ ] Add `analyze` subcommand to the CLI (`cli/main.ts`) for terminal access to
      cross-artifact consistency checks
- [ ] Add test coverage for `suppress_commit_types` in `gate.test.ts`
- [ ] Verify `specops drift` returns ok (zero errors) after the fix
- [ ] Verify `specops gate` produces zero errors after the fix
- [ ] Verify the SpecOps console panel shows zero errors after the fix

### Out of scope

- Adding a `go` verify to `specops.toml` (there is no Go test suite to run)
- Implementing a warning/error toggle in the SpecOps console UI (future enhancement)
- Fixing all `cross_artifact_gap` warnings in existing change folders (they are
  useful signals for document maintenance)
- Modifying the gate logic beyond the colon-stripping fix
- Changing how commit messages are parsed for references
- Adding the `analyze` subcommand to the `serve` mode (it's already there via API)

## Acceptance criteria

- [ ] `specops drift` returns `ok: true` with zero errors (no `unknown_verify` for `go`)
- [ ] The SpecOps console panel label says "Diagnostics", not "Gate signals"
- [ ] The "no diagnostics" message says "No diagnostics" not "No drift or gate errors"
- [ ] The diagnostic count badge shows error/warning breakdown (e.g., "1 error, 4 warnings")
- [ ] `suppress_commit_types` correctly matches commits like `chore:`, `feat:`, `fix:` etc.
- [ ] `specops gate --base HEAD~30 --head HEAD` produces zero errors (warnings only)
- [ ] `specops analyze` works as a CLI subcommand and returns cross-artifact gap results
- [ ] `suppress_commit_types` has test coverage in `gate.test.ts`
- [ ] All SpecOps tests pass (`pnpm test` in `apps/specops/`)
- [ ] No new regressions in scan or drift

## Out of scope

- Adding full Go test verification to the project
- Implementing a "hide warnings" toggle in the SpecOps UI
- Fixing all cross-artifact consistency gaps in existing change proposals
- Changing the gate's commit-message parsing heuristics
- Adding new spec documents

## Constitution conflicts

None. This change is a data fix (correcting a stale `verifies` reference), a UI
label correction, a bug fix (colon stripping in suppress_commit_types), and a CLI
ergonomics improvement (adding `analyze` subcommand). It does not modify any project
invariants.
