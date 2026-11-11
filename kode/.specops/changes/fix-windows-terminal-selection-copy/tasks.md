---
schema_version: 2
id: fix-windows-terminal-selection-copy
document_class: tasks
status: completed
---

# Tasks

- [x] Capture the Windows Tcodex selection/copy problem and acceptance criteria
  before further implementation.
- [x] Make Windows `Ctrl+C` selection-aware while preserving bare interrupt
  behavior when there is no selection.
- [x] Make Tcodex selection drags and multi-click selections remain entirely
  local, with no terminal mouse reports or other PTY input.
- [x] Extend clipboard and mouse-gesture regression tests.
- [x] Update the terminal interaction contract.
- [x] Run focused tests, `svelte-check`, and the GUI suite.
- [x] Build a Windows debug installer from the current branch for manual
  testing.
