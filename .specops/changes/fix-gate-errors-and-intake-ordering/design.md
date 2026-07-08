# Design: Gate error suppression and intake ordering

## Problem diagnosis

### Gate errors (26 errors across 20 commits)

The gate scans every non-merge commit in `base..head` and requires each to have a reference. This is too strict for a project where many commits are chores, fixes, or features that don't map to a `.specops/` document. The current error breakdown:

| Error Code | Count | Root Cause |
|---|---|---|
| `missing_reference` | 19 | Commits without `Spec:/Change:/Bug:...` annotation |
| `unknown_reference` | 7 | Malformed commit titles parsed as refactor references |

The `unknown_reference` errors come from two commits with titles that match the reference pattern:
- `refactor: update docs` → parsed as `Refactor: update` + `Refactor: docs`
- `refactor: token statistics reset-on-event with cumulative tracking` → parsed as 6 separate refactor IDs

### Console assets test failure

`index.html` was updated to remove "Implement in isolated worktree" text. The button now says "Run in worktree". The test assertion needs updating.

### Intake ordering

`commands.ts:373` sorts documents by `id` alphabetically. New documents always appear at their alphabetical position, not at the top where users expect to see them.

## Approach

### Gate suppression (additive, non-breaking)

Add a `[gate.suppress]` section to `specops.toml`:

```toml
[gate.suppress]
suppress_codes = ["missing_reference"]
suppress_commit_types = ["chore"]
```

**`suppress_codes`**: A list of diagnostic codes to downgrade from `error` to `info` (effectively hiding them from the error count). The default list would be empty (preserving current behavior), but the kode project's `specops.toml` would include `missing_reference`.

**`suppress_commit_types`**: A list of commit type prefixes (e.g., `chore`, `fix`) that, when matched at the start of the commit subject, skip the reference check entirely for that commit. This prevents false positives from `refactor:` titles being parsed as references.

**Why not just make `missing_reference` a warning?** Because for some projects (e.g., strict compliance), every commit SHOULD have a reference. The suppression is opt-in per project.

**Why `suppress_commit_types` instead of smarter parsing?** The `refactor: update docs` case shows that trying to distinguish between "commit type prefix" and "reference annotation" from the commit message is fragile. A whitelist of known commit type prefixes is simple and predictable.

### Console assets test fix (mechanical)

Change the assertion from `'Implement in isolated worktree'` to `'Run in worktree'` in both `.ts` and `.js` test files. This is a purely mechanical update to match the current UI.

### Intake ordering (sort by mtime, most recent first)

Instead of `.sort((a, b) => a.id.localeCompare(b.id))`, sort by the modification time of the document file:
- For change folders: stat `proposal.md`
- For specs: stat the `.md` file

Fall back to alphabetical sort if `stat` fails for any document.

This ensures newly created documents (which have the most recent mtime) appear at the top of their category, while existing documents maintain a stable order by creation time.

## Implementation plan

### Config changes (`apps/specops/src/domain/config.ts`)

Add to `SpecOpsConfig`:
```typescript
interface GateSuppressConfig {
  suppress_codes: string[]
  suppress_commit_types: string[]
}

interface SpecOpsConfig {
  // ... existing fields
  gate: {
    strict_wild_specs: boolean
    suppress: GateSuppressConfig
  }
}
```

### Gate changes (`apps/specops/src/domain/gate.ts`)

In `gateWorkspace()`:
1. After parsing commit references, check if the first word of the commit subject matches any `suppress_commit_types` entry. If yes, skip the commit entirely (don't add diagnostics).
2. After collecting all diagnostics, filter out any whose `code` is in `suppress_codes` (or downgrade to `info` severity).

### Commands changes (`apps/specops/src/domain/commands.ts`)

In `scanWorkspace()`, replace the `.sort((a, b) => a.id.localeCompare(b.id))` with:
```typescript
.sort(async (a, b) => {
  // Get mtime of the source file
  const getMtime = async (doc) => {
    try {
      const filePath = pathInside(workspace, doc.relativePath)
      const stats = await stat(filePath)
      return stats.mtimeMs
    } catch { return 0 }
  }
  const aTime = await getMtime(a)
  const bTime = await getMtime(b)
  if (aTime !== bTime) return bTime - aTime // most recent first
  return a.id.localeCompare(b.id) // fallback
})
```

Wait — this won't work in a `.sort()` because the comparator needs to be sync. Better approach: pre-compute mtimes before sorting.

### Test changes

1. `tests/console-assets.test.ts` and `.js`: Update the assertion text
2. `tests/gate.test.ts` and `.js`: Add tests for suppression config
3. `tests/workspace.test.ts` and `.js`: Verify sort order

## Rollback

- Gate suppression: remove the `[gate.suppress]` section from `specops.toml` to restore strict behavior
- Console assets: revert the test assertion
- Ordering: change the sort back to alphabetical

## Principles

- **Non-breaking**: Default behavior unchanged (suppress list is empty by default)
- **Opt-in**: Projects configure their own suppression preferences
- **Backward compatible**: Existing tests continue to pass without modification
