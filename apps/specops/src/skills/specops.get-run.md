# specops.get-run

Get the current status of a SpecOps run.

## API

```
GET {SPECOPS_ORIGIN}/api/runs/{run_id}
Authorization: Bearer {SPECOPS_TOKEN}
```

## Response

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
    "tasks": [
      {
        "id": "task-1",
        "title": "Task title",
        "prompt": "...",
        "verify": ["rust"]
      }
    ],
    "current_task": 0,
    "iteration": 0,
    "max_iterations": 8,
    "verify_results": [],
    "decisions": [],
    "started_at": "2026-06-21T10:00:00.000Z",
    "updated_at": "2026-06-21T10:05:00.000Z"
  }
}
```

## Run States

| State | Meaning | Next Action |
|---|---|---|
| `created` | Initial state | Transitions to `preparing` automatically |
| `preparing` | Creating git worktree | Transitions to `running` automatically |
| `running` | Agent is working on the current task | Wait, then poll again |
| `awaiting_verify` | Agent finished, ready for verification | Call `specops.verify-run` |
| `awaiting_review` | Verification complete, ready for review | Call `specops.decide-run` |
| `completed` | All tasks accepted | Call `specops.apply-run` |
| `failed` | Error or max iterations exceeded | Review error, decide to retry or cancel |
| `cancelled` | Run was cancelled | Terminal state |

## Polling Strategy

- While `state` is `running`: poll every 15-30 seconds
- While `state` is `preparing`: poll every 2 seconds
- Terminal states (`completed`, `failed`, `cancelled`): stop polling
