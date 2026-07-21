---
schema_version: 1
id: specops/engine-security
kind: spec
title: SpecOps security model — trust boundaries and local server isolation
status: active
verifies:
  - specops
paths:
  - apps/specops/src/server
  - .specops/specs/specops-engine-roadmap.md
---

# SpecOps Security Model

## Trust boundaries

- Canonical specs and `specops.toml` are trusted repository inputs reviewed through Git.
- Agent output and Run worktrees are untrusted until a human accepts the complete diff.
- Console browser code never receives the kode bridge token. The SpecOps server owns the Phase 9 adapter.
- A green verify result is evidence, not approval. Applying a patch is always explicit in the MVP.

## Local server

`specops serve` binds only to a loopback address on a random port. Every API call requires a per-process bearer token; browser writes also require the exact Origin. The token enters the iframe through a URL fragment, is removed immediately, and is not written to server logs.

Document reads and writes are canonicalized beneath `.specops/specs`, `.specops/changes`, or `.specops/archive`. Symlinks and traversal outside those roots are rejected. Request bodies are capped at 1 MiB and document updates use content hashes for optimistic concurrency.

## Execution

Each Run uses a detached Git worktree beneath the platform cache directory and records an immutable base commit. Verify commands come from the base snapshot, use argv spawning without a shell, and have time/output limits. The primary worktree is untouched until `run apply` or the Console's **Apply patch** action.

## Recovery

Run state is atomically stored in `.specops/runs/<run-id>/run.json`. After a crash:

1. Use `specops run status` to inspect the recorded state and worktree path.
2. Use `specops run verify` to repeat verification when the state permits it.
3. Use `specops run cleanup` only after preserving or applying the patch.
4. If apply conflicts, resolve it in the primary worktree; SpecOps never overwrites conflicting files.

Kode owns every `specops serve` child and kills then waits for it when the panel or application closes.
