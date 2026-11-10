---
schema_version: 2
id: windows-session-experience
kind: feature
document_class: work_item
work_type: feature
title: Windows session experience implementation design
status: completed
verifies:
  - rust
paths:
  - apps/gui/src
  - crates/kode-bridge/src/model_discovery.rs
  - crates/kode-core/src/session
---

# Implementation design

## Window and chooser sizing

Raise the Tauri main-window default height from 700 to 820 logical pixels and
the minimum height from 400 to 640. Keep the chooser card constrained by
`max-height: 90vh` with its own vertical scrolling so small displays remain
usable.

## Windows model discovery

Resolve commands through the existing portable-PTY resolution path. On Windows,
if the resolved executable ends in `.cmd` or `.bat`, launch it through:

```text
cmd.exe /D /S /C <resolved-shim> <original arguments>
```

Request `model/list` with `includeHidden: false` and `limit: 100`, while retaining
cursor pagination.

## Initial Codex model metadata

Explicit launch models and Kode backend defaults remain highest priority. For
Codex-family backends, a missing model is initialized from the active
`config.toml` (`model`, or the selected profile's `model`) before session
creation. JSONL `turn_context` and `session_meta` model values still override the
initial label when available.

## IME stability

Wrap PTY byte delivery in a bounded `TerminalImeOutputGate`. While
`compositionstart` is active, terminal bytes are queued instead of written to
xterm. On `compositionend`, the queued bytes are replayed on the next animation
frame. Ordering is preserved and component teardown clears pending content.

## Mode menu dismissal

Use the existing document-level outside-element pointer handler only while the
mode menu is open.

## Terminal click handling

Tcodex shares Codex's terminal mouse protocol. Install the existing
click-versus-drag adapter for both `codex` and `tcodex`. A short click is
replayed once so collapsible content can toggle; a drag selects terminal text
locally without forwarding an interrupt.

## Session history paths

Replace the POSIX-only `startsWith('/')` frontend guard with a cross-platform
absolute-path check. Windows drive-letter and UNC roots are accepted; the Rust
command remains the final authority and rejects relative paths.
