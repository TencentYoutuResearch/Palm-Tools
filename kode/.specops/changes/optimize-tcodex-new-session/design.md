---
schema_version: 2
id: optimize-tcodex-new-session
document_class: design
status: completed
---

# Design

## Model catalogue cache

Discovery cost is dominated by starting `tcodex app-server`, not by querying
models. Cache the successful `ModelDiscoveryResult` by backend configuration
and executable fingerprint.

- A process-memory cache makes repeated chooser openings instant.
- A disk cache with a bounded TTL makes the first chooser after application
  restart fast.
- Per-key async locks collapse concurrent probes into one CLI process.
- The chooser refresh action passes `force=true`; normal opens use the cache.
- Discovery failures are not returned from a long-lived success cache.

The chooser continues to render compatibility presets immediately and invokes
discovery in the background. Session submission never awaits the model probe.

## History index

Codex-family `state_5.sqlite` is the authoritative lightweight index. A thread
row already contains:

- logical session id;
- rollout path;
- cwd;
- display name/title;
- model;
- token usage;
- update time.

`CodexProfile::list_sessions_page` queries these rows, filters cwd with Windows
verbatim-path normalization, and slices the requested page. Resume path lookup
uses the same database before falling back to recursive file search. The
filesystem scan remains when the database or expected columns are unavailable.

`codex_session_cwd` reads only the first eight lines with a bounded reader. It
must never load a multi-megabyte rollout just to discover session metadata.

## Startup path

The PTY spawn path only awaits data needed to build the command. Independent
local preparation that currently runs serially should be joined where ownership
allows, and model/history work stays outside spawn. The CLI's own initialization
time is not hidden or faked.

## Resume startup

The history row already carries a logical session id. Starting it must resolve
that id through the lightweight SQLite index first:

1. `state_5.sqlite` lookup returns the rollout path.
2. The PTY command starts with that exact path and session id.
3. Recursive rollout scanning is used only when the database lookup fails.

The selected state and existing click/Resume interaction remain unchanged. The
performance boundary is the Start/Resume command, not the chooser selection.

## Verification

- Rust tests cover SQLite-backed list metadata, path normalization, direct
  resume lookup, and bounded first-line reads through a fallback fixture.
- Node tests cover non-blocking chooser actions and model-cache refresh
  semantics.
- Run focused tests, `cargo test` for touched crates, `svelte-check`, and the
  GUI suite before rebuilding the debug installer.
