# specops.create-run

Launch a SpecOps run — the agent will execute tasks in an isolated git worktree.

## API

```
POST {SPECOPS_ORIGIN}/api/runs
Authorization: Bearer {SPECOPS_TOKEN}
Content-Type: application/json
```

## Request Body

```json
{
  "backend_key": "codebuddy",
  "base": "HEAD",
  "change_id": "fix-specops-post-merge-status-transition",
  "tasks": [
    {
      "id": "task-1",
      "title": "Task title",
      "prompt": "Detailed prompt for the agent to implement",
      "verify": ["rust"]
    }
  ]
}
```

## Parameters

- **backend_key** (required): agent backend to use. Check available backends in `~/.config/kode/config.toml` `[backends]`. Common: `codebuddy`, `claude-internal`, `claude`
- **base** (optional): git ref to base the worktree on. Default: `HEAD`
- **change_id** (optional): the `id` of the SpecOps change proposal this Run implements (from `.specops/changes/<id>/proposal.md` frontmatter). When set, a successful apply will automatically flip the proposal's `status` from `proposed` to `completed`. Omit for quick-runs (no linked proposal → no auto status update).
- **tasks** (required): array of 1-5 tasks, each with:
  - **id** (string): unique task identifier within this run
  - **title** (string): short task title
  - **prompt** (string): detailed prompt for the agent. Include the spec content and any constraints. The agent will be told to work ONLY in the run worktree.
  - **verify** (string[]): names of verify checks from `specops.toml` `[verify.*]` sections. Example: `["rust"]` to run `cargo test`. **Only use names that exist in `specops.toml`.** If none are defined, pass an empty array `[]` — the Run fails with "unknown verify" otherwise.

## Success Response (201)

```json
{
  "run": {
    "run_id": "550e8400-e29b-41d4-a716-446655440000",
    "state": "running",
    "workspace_root": "/path/to/repo",
    "worktree_path": "/path/to/cache/worktrees/hash/uuid",
    "base_commit": "abc123...",
    "backend_key": "codebuddy",
    "kode_session_id": 1,
    "tasks": [...],
    "current_task": 0,
    "iteration": 0,
    "max_iterations": 8,
    "started_at": "2026-06-21T10:00:00.000Z"
  }
}
```

## Important Notes

- The run creates a **detached git worktree** at the base commit
- An agent session is **started automatically** in the worktree
- The **first task prompt is sent immediately** to the agent
- The agent is instructed to work ONLY in the worktree, never in the main workspace
- Verify checks run inside the worktree
- The session is created with `permission_mode: "bypass"` so the agent doesn't need tool approval confirmations
- The worktree root directory is pre-trusted in codebuddy settings so the "trust this directory?" prompt doesn't block startup
- The agent is instructed to work ONLY in the worktree, never in the main workspace
- Verify checks run inside the worktree
