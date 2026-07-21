---
schema_version: 2
id: specops/assurance-model
kind: spec
document_class: normative
spec_type: architecture
title: SpecOps assurance and workflow type model
status: active
verifies:
  - specops
paths:
  - apps/specops/src/domain/spec.ts
  - apps/specops/src/domain/assurance.ts
  - apps/specops/src/domain/harness.ts
  - apps/specops/src/domain/run.ts
  - apps/specops/frontend/src/components/iwiki
---

# SpecOps assurance and workflow type model

## Document classification

SpecOps separates the nature of a document from the kind of work it describes.

- A `normative` document is a durable product or engineering contract. Its
  `spec_type` is capability, action, contract, verification, architecture,
  policy, or invariant. It has no implementation workflow.
- A `work_item` describes a bounded activity. Its `work_type` is feature,
  bugfix, refactor, investigation, docs, or chore. Only work items may select a
  workflow profile and launch a Run.
- Work items bind the normative specs they implement or repair through
  `targets`. Document review activity must not be presented as an
  implementation workflow.

Schema-version 1 documents remain readable. Their class and subtype are
inferred from the legacy `kind`; new documents use schema version 2.

## Lifecycle

Normative documents use draft, active, deprecated, superseded, or archived.
Work items use proposed, approved, in_progress, blocked, completed, cancelled,
or archived. New schema-version 2 documents must not mix these lifecycle sets.

Users may explicitly deprecate a normative document or cancel a work item from
the document surface. This action also closes matching SpecOps sessions, stops
their active agent processes, and cancels a non-terminal linked Run. Sessions
may also be closed independently from the session header.

## Traceability and completion

The assurance control plane builds these derived, rebuildable views:

1. SpecGraph for normative specs, work items, targets and verification edges.
2. ProductGraph for discovered source/test files and source dependencies.
3. Mapping entries from specs to paths and named verification commands.
4. Diff reports for unmapped specs, unmapped product files, stale paths and
   missing verification.
5. Completion Contracts that enumerate required evidence and forbidden
   implementation shortcuts.
6. An Evidence Ledger whose records bind a subject and claim to the base
   commit, runtime environment and dependency hashes. Changed dependencies make
   prior evidence stale.

Derived graphs and health state are not canonical facts and must remain
rebuildable from `.specops` documents, repository files and evidence records.

## Impact, risk and policy

Impact includes direct mapped paths, reverse source dependencies, linked work
items and required verification. Risk scores security, migration, public API,
cross-module scope, file count and verification gaps, then selects automatic,
human-review, design-review or plan-only approval.

Harness-owned and read-only files are protected during verification. Removing
more assertions than a patch adds is a hard failure. Suspicious hardcoded or
mock-only completion markers are warnings for review.

## Execution

Tasks form a DAG. Unknown dependencies, duplicate task identifiers and cycles
must fail before worktree creation. The ordered DAG, immutable base commit,
backend capabilities, named verification snapshot, limits, platform, runtime,
network policy and secret policy are frozen in the RunManifest.
