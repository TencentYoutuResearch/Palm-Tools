---
schema_version: 1
id: project-overview
kind: spec
title: Project overview
status: active
verifies:
  - rust
  - specops
paths:
  - Cargo.toml
  - apps/specops/package.json
---

# Project overview

Kode is a monorepo for a Tauri/Svelte terminal manager, shared Rust core,
headless bridge, memory system, mobile client, remote server, and SpecOps.

## Invariants

- Rust workspace tests run single-threaded because PTY tests contend on file descriptors.
- GUI terminal rendering remains independent from SpecOps console rendering.
- SpecOps is a monorepo package and must not contain a nested Git repository.
