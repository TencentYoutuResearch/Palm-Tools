# specops.verify-run

Run verification checks on a SpecOps run's worktree and collect the diff.

## API

```
POST {SPECOPS_ORIGIN}/api/runs/{run_id}/verify
Authorization: Bearer {SPECOPS_TOKEN}
```

## Response

```json
{
  "run": {
    "run_id": "550e8400-...",
    "state": "awaiting_review",
    "current_task": 0,
    ...
  },
  "patch": "diff --git a/src/file.rs b/src/file.rs\n...",
  "files": ["src/file.rs", "src/other.rs"],
  "results": [
    {
      "at": "2026-06-21T10:10:00.000Z",
      "task_id": "task-1",
      "results": [
        {
          "name": "rust",
          "command": ["cargo", "test", "--", "--test-threads=1"],
          "exit_code": 0,
          "stdout": "running 24 tests\n...",
          "stderr": "",
          "duration_ms": 500
        }
      ]
    }
  ]
}
```

## How It Works

1. Transitions the run from `awaiting_verify` to `awaiting_review`
2. Runs each verify command from `specops.toml` referenced by the current task's `verify` array
3. Collects the git diff between the worktree and the base commit
4. Saves the diff as `.specops/runs/{run_id}/output.patch`

## Verify Results

Each verify result contains:
- **name**: the verify config name from `specops.toml`
- **exit_code**: 0 means pass, non-zero means fail
- **stdout**: captured standard output
- **stderr**: captured standard error
- **duration_ms**: how long the check took

## After Verification

- Review the verify results: all exit_code should be 0
- Review the patch: check that changes are correct and complete
- If everything looks good → `specops.decide-run` with verdict `"accept"`
- If tests fail or patch is wrong → `specops.decide-run` with verdict `"feedback"`
- If the approach is fundamentally wrong → `specops.decide-run` with verdict `"reject"`
