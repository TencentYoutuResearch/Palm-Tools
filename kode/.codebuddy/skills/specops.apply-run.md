# specops.apply-run

Apply a completed SpecOps run's patch to the main workspace.

## API

```
POST {SPECOPS_ORIGIN}/api/runs/{run_id}/apply
Authorization: Bearer {SPECOPS_TOKEN}
```

## Response

```json
{ "ok": true }
```

## How It Works

1. Reads the saved patch from `.specops/runs/{run_id}/output.patch`
2. Runs `git apply --3way` on the main workspace (not the worktree)
3. The changes are now in the working directory, ready to review and commit
4. **If the Run was created with a `change_id`**, the matching `.specops/changes/<id>/proposal.md` is automatically flipped from `status: proposed` → `status: completed`. This closes the SpecOps loop: a merged Run now leaves a `completed` breadcrumb on its proposal, ready for `archive-change`. Quick-runs (no `change_id`) skip this step.

## Prerequisites

- Run must be in `completed` state
- Patch file must exist (created during verification)
- Working directory must be clean enough for `git apply --3way` to succeed

## After Apply

1. Review the applied changes with `git diff` or `git status`
2. Commit the changes with a proper commit message
3. Archive the change folder using `specops.archive-change` to move it to `changes/archive/{date}-{slug}/` (the proposal's status is already `completed` from the apply step; `archive-change` will write `archived` over it)
4. Append a summary to `.specops/workspace/journal.md`:
   ```markdown
   ## {YYYY-MM-DD}: {title}
   - **Classification**: {classification}
   - **Run ID**: {run_id}
   - **Result**: completed
   - **Files changed**: {file_list}
   ```

## Error Handling

If `git apply --3way` fails (e.g. due to conflicts):
- The patch could not be cleanly applied
- Check `git status` for conflicted files
- Resolve conflicts manually, or re-run with a different base
