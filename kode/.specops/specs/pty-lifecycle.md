---
schema_version: 2
id: pty/lifecycle
kind: spec
document_class: normative
spec_type: capability
title: PTY child lifecycle remains deadlock-free
status: deprecated
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
