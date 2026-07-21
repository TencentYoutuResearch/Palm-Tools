---
schema_version: 1
id: specops/engine-cli
kind: spec
title: SpecOps CLI — workspace and run commands
status: active
verifies:
  - specops
paths:
  - apps/specops/src/cli
---

# SpecOps CLI

SpecOps requires Node 20+ during development. The kode release bundles the same CLI as a Bun sidecar.

## Workspace commands

```bash
specops init --workspace /path/to/repo
specops scan --workspace /path/to/repo --json
specops drift --workspace /path/to/repo --json
specops gate --workspace /path/to/repo --base <ref> --head HEAD --verify <name>
specops serve --workspace /path/to/repo
```

`gate` returns `0` on pass, `1` for policy failures, and `2` for configuration or runtime errors. Commit references use footer lines such as `Spec: backend/default-args`, `Change: feature/x`, or `Bug: ISSUE-123`.

## Run commands

Tasks are a JSON array:

```json
[
  {
    "id": "task-1",
    "title": "Implement the change",
    "prompt": "Implement the selected spec and preserve existing behavior.",
    "verify": ["rust"]
  }
]
```

```bash
specops run create --workspace /repo --tasks tasks.json --backend codebuddy
specops run status --workspace /repo --id <run-id>
specops run verify --workspace /repo --id <run-id>
specops run decide --workspace /repo --id <run-id> --verdict feedback --note "Fix the failing case"
specops run decide --workspace /repo --id <run-id> --verdict accept
specops run apply --workspace /repo --id <run-id>
specops run cleanup --workspace /repo --id <run-id>
```

Set `KODE_BRIDGE_URL` and `KODE_BRIDGE_TOKEN` to attach a Run to kode. Without them, `run create` still creates an isolated worktree for offline inspection.

## Configuration

```toml
schema_version = 1

[project]
name = "example"

[gate]
strict_wild_specs = false

[verify.test]
command = ["cargo", "test"]
cwd = "."
timeout_ms = 120000
output_limit_bytes = 1048576
```

Verify commands are argv arrays and never pass through a shell. A Run snapshots verify configuration from its immutable base before the agent starts.
