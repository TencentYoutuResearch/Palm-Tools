---
schema_version: 1
id: specops/run-isolation
kind: spec
title: SpecOps runs are isolated from user workspaces
status: active
verifies:
  - specops
paths:
  - .specops/specs/specops-engine-roadmap.md
---

# Run isolation

Every Run binds an immutable base commit and executes in a linked Git worktree
under the platform cache directory. Diff and verify operations must never use
the user's primary worktree as the Run target. Applying approved output is a
separate, explicit action.
