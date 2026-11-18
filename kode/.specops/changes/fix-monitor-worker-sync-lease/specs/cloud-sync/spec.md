# Cloud Sync

## Requirement: Monitor refreshes the selected Worker snapshot

An authenticated Monitor request for a selected Worker SHALL establish a short
sync lease for that Worker. While the lease is active, the Worker SHALL upload
its current session snapshot through the existing cloud-sync connection.

### Scenario: A Worker has no phone binding

- **GIVEN** a Worker is online but has no phone binding
- **WHEN** an authorized Monitor lists that Worker's sessions
- **THEN** the server enables snapshot sync for that Worker
- **AND** subsequent list responses include its current non-exited sessions

### Scenario: Monitoring stops

- **GIVEN** a Worker has an active Monitor sync lease
- **WHEN** Monitor polling stops for longer than the lease
- **THEN** the Worker receives `sync_enabled=false` on its next heartbeat
