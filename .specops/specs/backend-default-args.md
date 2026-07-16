---
schema_version: 2
id: backend/default-args
kind: spec
document_class: normative
spec_type: capability
title: Backend default arguments are non-positional
status: deprecated
verifies:
  - rust
paths:
  - crates/kode-core/src/config.rs
---

# Backend default argument safety

Default codebuddy, claude, and codex arguments must not add positional values.
Those CLIs interpret positional arguments as prompts and may send unintended
content to the model. Regression tests in `kode-core::config::tests` are the
executable source of truth for this invariant.
