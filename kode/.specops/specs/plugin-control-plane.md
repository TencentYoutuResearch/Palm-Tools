# Kode Plugin Control Plane

## Purpose

Kode provides one operational view of plugins used by Codex, Claude, Cursor, and CodeBuddy without pretending that their native plugin systems are interchangeable. Kode owns desired state, reconciliation, and audit history; each backend remains the authority for installation, authentication, activation, caches, and runtime behavior.

The **Kode plugin sync repository** is private cross-machine state. It is not a marketplace and must never be presented as a Codex, Claude, Cursor, or CodeBuddy marketplace.

## Ownership boundary

| Concern | Owner |
|---|---|
| Shared skills and Kode-authored plugin bundles | Kode sync repository |
| Desired plugin identity, source, ref/version, scope, and enabled policy | Kode lock file |
| Installed plugin state | Native backend |
| Credentials, OAuth, API keys, and secrets | Native backend / OS secure storage |
| Download caches and generated runtime state | Native backend |
| Last scan, errors, and machine-local observations | Kode local state, excluded from Git |

Kode must not synchronize raw backend cache directories or write them to reconcile state. Mutations use a verified native CLI/API adapter and are followed by a new inventory scan.

## Repository layout

```text
~/.kode-plugins/
├── plugins/                       # Kode-managed plugin source
├── bundles/                       # Logical cross-backend mappings
├── kode-plugins.lock.json         # Desired state committed to Git
└── .kode/
    ├── config.json
    └── state/
        └── <machine-id>.json      # Observed state; never committed
```

## Desired-state schema

The first lock format is JSON so the Rust control plane can validate it without a second parser dependency.

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "team-code-review",
      "displayName": "Team code review",
      "targets": {
        "codex": {
          "plugin": "review@team",
          "source": "github.com/company/codex-plugins",
          "ref": "v1.4.0",
          "enabled": true,
          "scope": "user"
        },
        "claude": {
          "plugin": "review@company",
          "version": "1.3.2",
          "enabled": true
        }
      }
    }
  ]
}
```

Plugin identities are provider-qualified. Matching names on two backends do not prove equivalent behavior. A bundle explicitly maps one logical capability to separate native targets.

## Adapter contract

Each backend adapter implements the same lifecycle while declaring its real capabilities:

```text
capabilities() -> inventory / marketplace / install / update / enable / scope / pinning
discover()     -> installed provider-qualified plugins
plan()         -> missing / extra / version drift / enablement drift / unsupported
apply()        -> native operations only, with explicit user approval
verify()       -> fresh discovery and per-operation result
```

Discovery is bounded and isolated per backend. A missing CLI, authentication failure, malformed output, or timeout is a backend-scoped result and never hides healthy results from other backends.

### Initial adapter support

| Backend | Discovery | Initial classification |
|---|---|---|
| Codex | `codex plugin list --json` | Native inventory |
| Claude | `claude plugin list --json` when supported | Native inventory or unavailable/error |
| Cursor | Supported local-development directory plus CLI marketplace capability | Partial inventory |
| CodeBuddy | `codebuddy plugin list --json` | Native inventory |

CLI discovery has a six-second bound. The first release is read-only and performs no install, update, enable, disable, authentication, or cache writes.

## Reconciliation lifecycle

```text
Git pull desired state
  -> scan native backends
  -> compute a deterministic plan
  -> show exact operations and unsupported items
  -> explicit Apply
  -> execute native operations per backend
  -> verify with a fresh scan
  -> store machine-local result
```

Removal, downgrade, source replacement, permission expansion, and authentication always require explicit confirmation. Automatic reconciliation may later opt in only to safe, additive operations; it must never silently remove an unmanaged native plugin.

## UI contract

The Plugins settings category contains two visibly separate sections:

1. **Kode plugin sync repository** — Git configuration, Kode-authored plugins, shared-skill deployment, and sync results.
2. **Native backend plugins** — provider-grouped installed inventory, capabilities, source/version, and scan status.

Native states use precise labels: `ready`, `partial`, `unavailable`, and `error`. Future desired-state comparison adds `in sync`, `missing`, `extra`, `version drift`, `disabled`, `auth required`, and `unsupported`. “Extra” means installed but unmanaged; it does not imply removal.

## Delivery phases

1. Read-only inventory and capability detection for all four backends.
2. Lock-file parsing, validation, deterministic diff, and preview-only reconciliation plans.
3. Native additive operations (marketplace/source registration, install, update, enable) with verification.
4. Confirmed destructive operations, bundle mappings, policy controls, and machine-local audit history.

