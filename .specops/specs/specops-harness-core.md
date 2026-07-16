---
schema_version: 2
id: specops-harness-core
kind: spec
document_class: normative
spec_type: architecture
title: SpecOps Harness Core
status: active
paths:
  - apps/specops/src/domain/harness-core.ts
  - apps/specops/src/domain/run.ts
  - apps/specops/src/domain/run-loop.ts
  - apps/specops/src/domain/agent-runtime.ts
  - apps/specops/src/domain/drift-loop.ts
  - apps/specops/src/domain/environment.ts
  - apps/specops/src/domain/graph-adapters.ts
  - apps/specops/src/domain/harness-evolution.ts
  - apps/specops/src/domain/notes.ts
verifies:
  - specops-test
---

# SpecOps Harness Core

## Purpose

Harness Core is the durable control plane between interactive SpecHTML and Agent execution. The document is the product contract; the Harness is the execution mechanism. Normative specs do not receive implementation workflows. Work items select a workflow and create Runs.

## MVP loops

The production registry starts with four logical loops: `clarify`, `build`, `verify_repair`, and `drift`. Design, planning, test design, and review initially remain role-specific stages or skills inside these loops. They become separately scheduled loops only when they need independent scaling or retry policy.

## Durable model

Every Run owns these files under `.specops/runs/<run-id>/`:

- `run.json`: compatibility-facing Run state and immutable manifest.
- `harness-events.json`: ordered append-only event journal.
- `harness-state.json`: reducer snapshot recoverable from events.
- `output.patch`: patch artifact for review and apply.

Every event has a stable UUID, monotonic sequence, actor, timestamp, idempotency key, type, and typed data. Replaying an idempotency key must not apply its reducer twice. The event journal is the recovery authority for Harness state; `run.json` remains the compatibility authority until migration finishes.

## Scheduler contract

A task is `blocked`, `ready`, `running`, `verifying`, `reviewing`, `completed`, `failed`, or `cancelled`.

- A task starts ready only when it has no dependencies.
- A blocked task becomes ready after all dependencies complete.
- Only ready tasks may be assigned.
- Assignment records Agent identity and immutable worktree.
- Completion requires verification, review, and approval gates.
- Failed verification returns the same task to repair and consumes budget.
- Exhausted budget produces `budget.exhausted` and requires human action.

The local scheduler executes one task at a time in one Run worktree. Parallel assignment requires file-scope locks and separate worktrees; it cannot be inferred from topological sorting alone.

## Artifacts and context

Cross-loop communication uses typed artifacts rather than transcript copying. Base kinds are spec, plan, patch, verification, review, evidence, drift report, gate decision, and note. Each records producer, subject, URI or content hash, exact source commit, input artifact IDs, metadata, and creation time.

The Context Compiler selects only the SpecGraph nodes, source scope, policies, prior artifacts, and budget needed by the assigned role. Transcript is diagnostic context, not a completion artifact.

## Evidence and completion

Evidence binds to the exact tree executed:

- pre-apply evidence binds to Run worktree HEAD after patch commit;
- post-apply evidence binds to main workspace HEAD after merge;
- environment contains runtime, platform, lock hash, and dependency hashes;
- changed dependency hashes make evidence stale;
- stale or failed evidence cannot satisfy a Completion Contract.

Patch policy and post-apply verification produce Gate decisions. Apply without successful post-apply verification leaves the Run `applied_failed` and does not complete its work item.

## Agent runtime

Logical roles are Clarifier, Architect, Planner, Builder, Test Designer, Verifier, Reviewer, Repair Agent, and Drift Agent. Each role constrains accepted and produced artifacts, backend capabilities, file ownership, network/secrets, budgets, retry, and escalation.

The initial runtime may use three physical Agents: product/spec, implementation/repair, and independent verification/review. Logical roles remain explicit even when sessions are reused.

## API and observability

`GET /api/runs/:id/harness` returns the reducer snapshot. `GET /api/runs/:id/events` returns the journal. The console renders task readiness, Loop state, artifacts, gates, budget, and source commit; transcript is not the primary status model.

## Invariants

- One Run uses an immutable base commit and isolated worktree.
- Harness-owned tests, contracts, golden files, and policies are not agent-editable.
- Risk and policy gates control execution rather than being display-only.
- Event and artifact writes are atomic and serialized per Run.
- Main-workspace apply is serialized per repository.
- Restart replay cannot duplicate an event or assignment.

## Evolution

Rules, adapters, and policies are versioned before optimization. Benchmarks cover features, bugs, cheating/stubs, scanner errors, drift invalidation, crash replay, and apply rollback. New rules move through shadow and canary modes before becoming hard gates.
