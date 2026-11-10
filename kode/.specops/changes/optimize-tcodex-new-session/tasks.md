---
schema_version: 2
id: optimize-tcodex-new-session
document_class: tasks
status: completed
---

# Tasks

- [x] Record measured Tcodex model, rollout, and history-index costs before
  implementation.
- [x] Add cached, single-flight model discovery with force refresh support.
- [x] Serve Codex/Tcodex history and resume paths from `state_5.sqlite` with a
  filesystem fallback.
- [x] Bound rollout metadata reads to the first eight lines.
- [x] Remove recursive rollout scans and full transcript reads from the
  selected-history Start/Resume path.
- [x] Parallelize safe independent work in the local spawn path.
- [x] Add focused Rust and GUI regression tests.
- [x] Run focused checks and the GUI suite.
- [x] Build and launch the latest Windows debug version.
