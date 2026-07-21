# Project Constitution

> Last updated: 2026-06-23
>
> This constitution documents project-level invariants that all SpecOps operations
> must respect. It is the first file read before any intake, clarify, analyze, or
> create-run operation. Invariants are extracted from authoritative spec documents
> under `.specops/specs/` — see each section for the source document reference.

## Principles

- **Rust workspace tests run single-threaded** (`cargo test -- --test-threads=1`)
  because PTY tests contend on file descriptors. *Source: project-overview.md*
- **GUI terminal rendering is independent from SpecOps console rendering.**
  Do not couple the two implementations. *Source: project-overview.md*
- **SpecOps is a monorepo package.** It must not contain a nested Git repository.
  *Source: project-overview.md*

## Invariants

- **PTY child lifecycle must use independent handles for wait and kill.**
  A shared `Arc<Mutex<Child>>` around both operations can deadlock when `wait()`
  holds the mutex. The PTY host must retain the independent killer returned by
  `clone_killer()`. *Source: pty-lifecycle.md*
- **Backend default arguments must not include positional values.**
  CLI backends (codebuddy, claude, codex) interpret positional arguments as
  prompts and may send unintended content to the model. Regression tests in
  `kode-core::config::tests` are the executable source of truth for this invariant.
  *Source: backend-default-args.md*
- **SpecOps runs must be isolated from user workspaces.**
  Every Run binds an immutable base commit and executes in a linked Git worktree
  under the platform cache directory. Diff and verify operations must never use
  the user's primary worktree as the Run target. Applying approved output is a
  separate, explicit action. *Source: specops-run-isolation.md*

## Guardrails

- **Read this constitution before every SpecOps operation**: intake, clarify,
  analyze, or create-run. If the proposed operation would violate any invariant
  above, surface the conflict in the proposal's `## Constitution conflicts`
  section rather than silently proceeding.
- **Proposals must include Motivation, Scope, Acceptance criteria, and
  Out of scope sections** before an intake receipt can be written (enforced by
  `specops.checklist`).
- **Cross-artifact consistency analysis** must run before creating a run
  (enforced by `specops.analyze`). Errors block run creation; warnings must be
  acknowledged.
- **Implementation requires explicit approval** (Phase 3: Launch Run in the
  SpecOps workflow). Proposals that accumulate in `proposed` status while work
  proceeds through other channels must be reconciled promptly to avoid staleness.
  *Note: this guardrail was added reactively to prevent the clarify lifecycle gap
  documented in `cleanup-specops-document-staleness`.*
