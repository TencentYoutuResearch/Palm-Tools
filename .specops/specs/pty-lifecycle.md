---
schema_version: 1
id: pty/lifecycle
kind: spec
title: PTY child lifecycle remains deadlock-free
status: active
verifies:
  - rust
paths:
  - crates/kode-core/src/pty/mod.rs
---

# PTY lifecycle

Waiting for a child and killing it must use independent handles. A shared
`Arc<Mutex<Child>>` around both operations can deadlock when `wait()` holds the
mutex. The PTY host must retain the independent killer returned by
`clone_killer()`.
