# Tasks

## Task 1: Fix console assets tests (lowest risk, quick win)

- [x] Update `tests/console-assets.test.ts` line 20: change assertion from `'Implement in isolated worktree'` to `'Run in worktree'` (the current button text in `index.html`)
- [x] Update `tests/console-assets.test.js` line 17: same change
- [x] Run `pnpm test` to verify both tests pass

## Task 2: Add gate error suppression configuration

- [x] Add `GateSuppressConfig` interface to `SpecOpsConfig` in `apps/specops/src/domain/config.ts`
- [x] Update `loadConfig()` in `config.ts` to parse `suppress_codes` and `suppress_commit_types`
- [x] Update `gateWorkspace()` in `gate.ts` to:
  - Skip commits whose first word matches `suppress_commit_types`
  - Downgrade diagnostics whose code is in `suppress_codes` from `error` to `info`
- [x] Update `specops.toml` with suppress configuration:
  ```toml
  [gate.suppress]
  suppress_codes = ["missing_reference", "unknown_reference"]
  suppress_commit_types = ["chore"]
  ```
- [x] Run `pnpm test` to verify all gate tests pass (65/65)

## Task 3: Fix intake document ordering (most recent first)

- [x] In `apps/specops/src/domain/commands.ts`, change sort from alphabetical-by-id to mtime-based (most recent first), with alphabetical fallback
- [x] Client `renderDocuments()` in `app.js` preserves server sort order — no changes needed
- [x] Run `pnpm test` to verify no regressions (65/65)

## Task 4: Integration verification

- [x] Run full SpecOps test suite: `cd apps/specops && pnpm test` (65/65 passed)
- [x] Run Rust workspace tests: `cargo test -- --test-threads=1`
