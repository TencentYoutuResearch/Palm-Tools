---
schema_version: 1
id: specops/engine-perf
kind: spec
title: SpecOps MVP baseline performance measurements
status: active
verifies:
  - specops
paths:
  - apps/specops
---

# SpecOps MVP Baseline

Measured on 2026-06-20 on an Apple silicon macOS development machine. Values are smoke-test baselines, not cross-platform guarantees.

| Check | Result |
|---|---:|
| Packaged sidecar `scan` over kode's four active specs | about 50 ms |
| Idle `specops serve` CPU | 0.0% |
| Idle `specops serve` RSS | about 41 MiB |
| arm64 macOS SpecOps sidecar | 61 MiB |
| unsigned debug `kode.app` bundle | 98 MiB |

The Bun single-file runtime dominates sidecar size. The server is event-driven while idle and does not introduce a render loop into kode's terminal path.

## Dogfood Result

- `scan`, `drift`, and named `specops` gate passed on the kode workspace.
- The full Rust workspace suite passed single-threaded.
- SpecOps passed type checking, 22 tests, and its production bundle.
- The Tauri app bundled the sidecar and launched without requiring Node on `PATH`; the embedded console page was served from the packaged executable.
- No false-positive gate failure was observed. Wild-spec discovery remains a warning unless `strict_wild_specs` is explicitly enabled.

## Release Follow-up

Linux bundle validation and macOS signing require their respective CI runner and signing certificate. A release candidate still needs a manual visual pass for iframe focus, shortcuts, zoom, and theme before distribution.
