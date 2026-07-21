# Design: Gate signals investigation

## Problem anatomy

The "Gate signals" count in the SpecOps console aggregates diagnostics from four sources:

```
renderDiagnostics() in app.js:
  allDiags = [
    ...scan.diagnostics,     // YAML parsing errors
    ...drift.diagnostics,    // stale paths, unknown verifies, wild specs
    ...analyze.diagnostics,  // cross-artifact gaps
  ]
  // Plus gate diagnostics are shown separately via the gate command
```

The 28 signals likely break down as:

### Gate diagnostics (~19-21 signals)
From `gateWorkspace()` analyzing the last 20-30 commits:

| Diagnostic code | Count (est.) | Status after suppress config |
|---|---|---|
| `missing_reference` | ~17-19 | Downgraded to warning (still shown) |
| `unknown_reference` | ~2 | Downgraded to warning (still shown) |

The `suppress_commit_types = ["chore"]` only skips commits whose first word is `chore`. Looking at the last 30 commits, only `f11e890` uses `chore:`. The remaining 19+ non-merge commits use `feat:`, `fix:`, `refactor:`, `test:`, `debug:` — none of which are suppressed.

### Drift diagnostics (~3-5 signals)
From `driftWorkspace()`:

| Diagnostic code | Count (est.) | Details |
|---|---|---|
| `stale_path` | ~1-2 | Some spec documents reference paths that no longer exist |
| `unknown_verify` | ~0-2 | Some documents reference verify names not in specops.toml |
| `wild_spec` | ~0-1 | Files like `ROADMAP.md` or `CLAUDE.md` outside .specops detected as wild specs |
| `missing_constitution` | 0 | constitution.md now exists |

### Analyze diagnostics (~2-4 signals)
From `analyzeWorkspace()`:

| Diagnostic code | Count (est.) | Details |
|---|---|---|
| `cross_artifact_gap` | ~2-4 | Scope items in proposal.md not referenced in tasks.md, or design components not in tasks |

### Scan diagnostics (~0-2 signals)
From `scanWorkspace()`:

| Diagnostic code | Count (est.) | Details |
|---|---|---|
| YAML parse errors | ~0-2 | Some design.md files lack valid frontmatter |

## Why the current suppression is insufficient

The `specops.toml` gate suppression:

```toml
[gate.suppress]
suppress_codes = ["missing_reference", "unknown_reference"]
suppress_commit_types = ["chore"]
```

**What it does**: 
- `suppress_codes`: Changes diagnostic severity from `error` to `warning` for matching codes
- `suppress_commit_types`: Skips commits entirely if their first word matches

**What it doesn't do**:
- Hide warnings from the Gate signals panel (all diagnostics are shown regardless of severity)
- Cover commit types other than `chore:` (the repo uses `feat:`, `fix:`, `refactor:`, `test:`, `debug:`)
- Address drift, analyze, or scan diagnostics (only affects gate diagnostics)

## Possible resolution paths

### Path A: Expand suppression (minimal code change)
Add more commit type prefixes to `suppress_commit_types`:
```toml
suppress_commit_types = ["chore", "feat", "fix", "refactor", "test", "debug", "docs"]
```
This would eliminate ~17-19 missing_reference warnings from gate diagnostics, but doesn't address drift/analyze/scan signals.

### Path B: Hide warnings in UI (requires code change)
Modify `renderDiagnostics()` in `app.js` to filter out `severity: 'warning'` items when the count is high, or add a toggle. This is a code change in the SpecOps engine.

### Path C: Fix root causes (most work)
- Add Spec references to all commit messages (impractical for existing commits)
- Fix stale paths and unknown verifies in spec documents
- Fix cross-artifact gaps in change folders
- This is the "correct" fix but requires touching many files

### Path D: Accept the noise (do nothing)
The 28 signals are mostly warnings, not errors. The gate is working as designed — it surfaces all diagnostics. The suppression already prevents them from blocking runs (errors block, warnings don't). This is acceptable for a development workflow where not every commit has a Spec reference.

## Recommendation

**Path A + D hybrid**: Expand `suppress_commit_types` to cover the repo's actual commit conventions (this is a one-line config change). Accept that drift/analyze warnings will remain as useful signals rather than noise — they indicate real document maintenance needs (stale paths, missing cross-references).

This would reduce the count from ~28 to ~7-10 (eliminating the bulk of gate-specific warnings while keeping useful drift/analyze signals).
