# specops.decide-run

Accept, reject, or give feedback on a SpecOps run after verification.

## API

```
POST {SPECOPS_ORIGIN}/api/runs/{run_id}/decision
Authorization: Bearer {SPECOPS_TOKEN}
Content-Type: application/json
```

## Request Body

```json
{
  "verdict": "accept",
  "note": "Optional note explaining the decision"
}
```

## Verdicts

| Verdict | Effect | When to Use |
|---|---|---|
| `accept` | Advance to next task, or complete if last task | All verify checks pass, diff looks correct |
| `reject` | Cancel the run entirely | Agent went in wrong direction, better to start over |
| `feedback` | Send feedback note to agent, retry same task | Minor issues to fix, agent needs guidance |

## Success Response

```json
{
  "run": {
    "run_id": "550e8400-...",
    "state": "completed",
    "current_task": 1,
    "tasks": [...],
    "decisions": [
      { "at": "2026-06-21T10:15:00.000Z", "verdict": "accept", "note": "All checks pass" }
    ]
  }
}
```

## Feedback Flow

When using `"feedback"`:
1. The `note` is sent to the agent as a new prompt: "SpecOps review feedback:\n\n{note}\n\nRevise the same task and report when ready for verification."
2. The run transitions back to `running` for the same task
3. `iteration` is incremented by 1
4. Max 8 iterations per task — after that, the run fails

## After Decision

- If state becomes `running` (accept with more tasks, or feedback): poll `specops.get-run` again
- If state becomes `completed`: call `specops.apply-run`
- If state becomes `cancelled`: run is terminated, no further action needed
