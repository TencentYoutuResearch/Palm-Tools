# Design: Fix gate signals diagnostics

## Current diagnostic flow

```
CLI / Server API
  │
  ├── scanWorkspace()     → YAML parse errors, duplicate IDs
  ├── driftWorkspace()    → stale_paths, unknown_verifies, wild_specs
  ├── analyzeWorkspace()  → cross_artifact_gaps (scope→tasks, design→tasks)
  └── gateWorkspace()     → missing_reference, unknown_reference, verify_failed
                             ↑ NOT included in /api/state response
```

The `/api/state` endpoint (`server/index.ts:155-157`) calls only scan + drift + analyze:

```typescript
const [scan, drift, analyze] = await Promise.all([
  scanWorkspace(workspace),
  driftWorkspace(workspace),
  analyzeWorkspace(workspace)
])
```

The client `refresh()` (`app.js:311-316`) aggregates:

```javascript
const allDiags = [
  ...state.scan.diagnostics,
  ...state.drift.diagnostics,
  ...(state.analyze?.diagnostics ?? []),
]
```

### Empirical diagnostic counts (as of 2026-06-24)

| Source | Errors | Warnings | Notes |
|---|---|---|---|
| `specops scan` | 0 | 0 | All YAML parses correctly |
| `specops drift` | 1 | 0 | `unknown_verify: go` in remote/protocol |
| `specops gate --base HEAD~30` | 0 | 36 | 24 missing_reference + 8 unknown_reference (all downgraded to warning) |
| `specops analyze` | ? | ? | Only available via server API, no CLI command |

## Problem breakdown

### Problem 1: Stale `go` verify reference

`remote-protocol.md` declares `verifies: [rust, go, specops]`. The `go` verify
was likely added speculatively (anticipating a Go test suite for the remote
server at `services/kode-server-go`), but no such verify was ever defined in
`specops.toml`.

**Fix**: Remove `go` from the verifies list. If a Go test suite is added later,
the verify can be re-added along with its `specops.toml` definition.

### Problem 2: Panel mislabeling

The panel heading "Gate signals" implies it shows gate diagnostics, but it
shows scan + drift + analyze. This is misleading and was likely an artifact
of early development when the panel was envisioned to show gate results.

Additionally, the "no diagnostics" message (`app.js:67`) says "No drift or gate
errors" — another reference to "gate" that doesn't reflect what's actually shown.

**Fix**: Rename heading to "Diagnostics" and message to "No diagnostics."

### Problem 3: Warning noise in count badge

The count badge (`diagCount`) shows the total number of diagnostics (errors +
warnings). With 4 non-archived changes, the analyze phase produces several
`cross_artifact_gap` warnings, inflating the count. Users see a non-zero
badge and assume there are errors to fix.

Current `renderDiagnostics()` (`app.js:60-82`):
```javascript
function renderDiagnostics(items) {
  diagCount.textContent = String(items.length)
  diagCount.classList.toggle('has-errors', items.some(i => i.severity === 'error'))
  // ...
}
```

**Fix**: Show error/warning breakdown in the badge:
```javascript
function renderDiagnostics(items) {
  const errors = items.filter(i => i.severity === 'error').length
  const warnings = items.length - errors
  if (errors > 0) {
    diagCount.textContent = `${errors} error${errors !== 1 ? 's' : ''}, ${warnings} warning${warnings !== 1 ? 's' : ''}`
    diagCount.classList.add('has-errors')
  } else if (warnings > 0) {
    diagCount.textContent = `${warnings} warning${warnings !== 1 ? 's' : ''}`
    diagCount.classList.add('has-warnings')
  } else {
    diagCount.textContent = '0'
    diagCount.classList.remove('has-errors', 'has-warnings')
  }
  // ...
}
```

This is the "Better" option from the trade-off analysis — provides clarity
without UI complexity. No toggle needed; the breakdown is always visible.

The CSS already supports `.has-errors` on the badge. Need to add `.has-warnings`
styling and remove the `min-width` constraint (or increase it) to accommodate
longer text like "1 error, 4 warnings":

```css
.diag-count-badge.has-warnings {
  background: var(--amber-glow);
  color: var(--amber);
  border: 1px solid rgba(245, 200, 66, 0.25);
}
```

### Problem 4: `suppress_commit_types` colon mismatch (bug)

The `suppress_commit_types` feature in `gate.ts:106-107`:

```typescript
const firstWord = commit.message.split('\n')[0]?.split(/\s+/)[0]?.toLowerCase()
if (firstWord && suppressTypes.includes(firstWord)) continue
```

For a commit `chore: add node modules`, the first word is `chore:` (with colon).
The config has `suppress_commit_types = ["chore"]` without colon. So
`suppressTypes.includes("chore:")` is `false` — no commits are ever suppressed.

This was empirically confirmed: the `f11e890` commit (`chore: add node modules`)
appears in `specops gate` results with a `missing_reference` warning.

**Fix**: Strip trailing colon before comparison:
```typescript
const firstWord = commit.message.split('\n')[0]?.split(/\s+/)[0]?.toLowerCase()
const commitType = firstWord?.endsWith(':') ? firstWord.slice(0, -1) : firstWord
if (commitType && suppressTypes.includes(commitType)) continue
```

This approach:
- Works with or without colon in config values (user-friendly)
- Handles both `chore:` and `chore(scope):` → `chore`
- Doesn't require users to update their config if they already have colons

Note: commits with scoped prefixes like `feat(gui):` will have first word
`feat(gui):`. After stripping the trailing colon, the type is `feat(gui)` which
won't match `feat`. This is acceptable — scoped commits are intentional and
shouldn't be blanket-suppressed. If the user wants to suppress them, they can
add `feat(gui)` to the list.

### Problem 5: Missing `analyze` CLI subcommand

`analyzeWorkspace()` is fully implemented but only accessible via:
- `GET /api/state` (bundled into the state response)
- `POST /api/analyze` (standalone endpoint)

There is no `analyze` subcommand in the CLI (`cli/main.ts`). This means users
can't check cross-artifact gaps from the terminal without starting the server.

**Fix**: Add `analyze` subcommand following the existing `drift`/`gate` pattern:

```typescript
if (command === 'analyze') {
  const result = await analyzeWorkspace(workspace)
  if (json) io.stdout(`${JSON.stringify(result)}\n`)
  else {
    io.stdout(`analyze: ${result.ok ? 'ok' : 'failed'}\n`)
    for (const diagnostic of result.diagnostics) {
      io.stderr(`${diagnostic.severity}: ${diagnostic.message}\n`)
    }
  }
  return result.ok ? 0 : 1
}
```

## Trade-offs

### Why not add a `go` verify?

Adding `[verify.go]` to `specops.toml` would make the verify check pass, but
there's no Go test suite to run. The verify would be a no-op or would fail
every time. Removing the reference is more honest.

### Why not filter warnings entirely?

Warnings are useful signals — they indicate real maintenance needs (stale
paths, cross-artifact gaps). Filtering them would hide valuable information.
The fix is to present them clearly without conflating them with errors.

### Why not fix all cross_artifact_gap warnings?

Each change folder has legitimate gaps between proposal scope and tasks.md
because:
- Some scope items are high-level descriptions, not task-level granularity
- The keyword matching heuristic (`firstSignificantWord`) is approximate
- Design.md headings may describe components at a different level than tasks

Fixing every gap would require rewriting tasks.md for each change to include
every keyword from the proposal scope — this is make-work that doesn't
improve the documents. The warnings serve as reminders, not errors.

### Why strip colon in code rather than require colon in config?

Two approaches:
1. **Strip colon in code** (chosen): User writes `["chore", "feat"]`, code strips
   trailing `:` from commit first word. More intuitive config.
2. **Require colon in config**: User writes `["chore:", "feat:"]`. Exact matching
   but more error-prone and less discoverable.

Option 1 is better UX. The config says what commit *types* to suppress, and the
code handles the commit message format.

## Implementation plan

### Phase 1: Data fix + label fix (no logic change)
1. Remove `go` from `remote-protocol.md` verifies
2. Rename panel label "Gate signals" → "Diagnostics" in `index.html`
3. Fix "No drift or gate errors" → "No diagnostics." in `app.js`

### Phase 2: Bug fix (logic change)
4. Fix `suppress_commit_types` colon mismatch in `gate.ts`
5. Expand `suppress_commit_types` in `specops.toml`
6. Add test coverage for `suppress_commit_types` in `gate.test.ts`

### Phase 3: UI + CLI improvement
7. Update count badge to show error/warning breakdown in `app.js`
8. Add `analyze` CLI subcommand to `cli/main.ts`

## Files changed

| File | Change |
|---|---|
| `.specops/specs/remote-protocol.md` | Remove `go` from verifies |
| `apps/specops/src/server/public/index.html` | "Gate signals" → "Diagnostics" |
| `apps/specops/src/server/public/app.js` | Badge breakdown + "No diagnostics." message |
| `apps/specops/src/server/public/styles.css` | `.has-warnings` badge style |
| `apps/specops/src/domain/gate.ts` | Strip colon in suppress_commit_types matching |
| `apps/specops/src/cli/main.ts` | Add `analyze` subcommand |
| `specops.toml` | Expand suppress_commit_types |
| `apps/specops/tests/gate.test.ts` | Add suppress_commit_types test |
| `dist/` (generated) | Regenerated via `pnpm build` |

## Risks

- **Low risk**: The `go` verify removal is a one-line data change
- **Low risk**: The label rename is a one-line HTML change
- **Low risk**: The badge breakdown is a client-side JS change, no API changes
- **Low risk**: The colon fix is a 2-line logic change in gate.ts
- **Low risk**: Adding `analyze` CLI subcommand is additive, doesn't change existing behavior
- **No risk**: The suppress_commit_types expansion is a config-only change
