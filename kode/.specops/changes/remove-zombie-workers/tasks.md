---
schema_version: 2
id: remove-zombie-workers
document_class: tasks
status: proposed
---

# Tasks

- [x] Add offline-only Worker removal API and transactional revocation.
- [x] Reject silent re-registration by a revoked installation/token.
- [x] Publish session, binding and Worker removal events.
- [x] Add bridge/workbench service and Desktop Tauri command.
- [x] Add Worker Details danger zone for Offline Workers only.
- [x] Add destructive second confirmation and success/failure states.
- [x] Clear an invalid Monitor target after removal and refresh the directory.
- [x] Add server, bridge and GUI regression tests.
- [x] Run focused Rust and Svelte checks.
- [ ] Verify local server and two debug Workers end to end.
