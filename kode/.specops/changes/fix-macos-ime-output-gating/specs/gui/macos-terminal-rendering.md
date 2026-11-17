---
schema_version: 2
id: gui/macos-terminal-rendering
kind: spec
document_class: normative
spec_type: capability
title: macOS terminal IME rendering isolation
status: proposed
verifies:
  - rust
paths:
  - apps/gui/src/lib/Terminal.svelte
  - apps/gui/src/lib/terminal_ime.ts
  - apps/gui/tests/terminal_ime.test.ts
---

# macOS terminal IME rendering isolation

## Requirements

- Windows-only IME mitigations must not alter PTY output delivery on macOS or
  Linux unless the mitigation itself is explicitly cross-platform.
- On macOS, PTY output must continue through the normal ANSI adapter and xterm
  write path while an IME composition is active.
- Windows may defer PTY redraws during composition only to prevent native IME
  anchor jitter; deferred bytes must replay once, in order, on composition end.
- Terminal repair must not depend on periodic repaint, tab switching, or manual
  view refresh.

## Invariants

- No terminal output byte may be lost, duplicated, or reordered.
- Platform workarounds must be gated at the platform boundary.
- Terminal renderer behavior remains independent from SpecOps rendering.
