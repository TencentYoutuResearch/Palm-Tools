# Design

## Existing foundation

- The sync server already scopes sessions, events, bindings and commands by
  `device_id`.
- The desktop agent has one outbound WebSocket and already serves allowlisted
  ephemeral setup reads through `setup.request/setup.result`.
- Mobile bindings already identify exactly one Worker.
- There is no user account, Worker inventory or ADB inventory implementation.

## Protocol

`GET /api/v1/workers` accepts the existing device bearer for desktop discovery
and an existing mobile binding for monitor discovery. It returns only directory
metadata:

```text
worker_id, name, online, last_seen_at, kode_version, os, arch,
inventory_capable, bound
```

`GET /api/v1/workers/:worker_id/inventory` reuses binding authorization and
requires the binding to belong to `worker_id`. Desktop device bearer access is
accepted only for its own Worker. Cross-Worker data is never returned.

The Worker inventory is requested through the existing setup channel:

```text
setup.request { kind: "worker_inventory", payload: {} }
setup.result  { body: WorkerInventory }
```

The Agent hello gains an optional capability list. The server rejects inventory
requests for Workers that do not advertise `inventory.v1`, so an older Worker
never receives an operation it cannot deserialize.

## Inventory contents

```text
WorkerInventory {
  observed_at,
  worker: { kode_version, os, os_version, arch, hostname, uptime_seconds },
  resources: {
    cpu_count, cpu_brand, load_1m, load_5m, load_15m,
    memory_total, memory_available,
    disks: [{ name, mount, total, available }]
  },
  agents: [{ key, name, command, version, enabled, available }],
  adb: {
    available, version,
    devices: [{ serial, state, model, product, device, transport_id, connection }]
  },
  capabilities: [...]
}
```

Agent version probing is fixed to `<configured command> --version` with a short
timeout. ADB uses only `adb version` and `adb devices -l`. No user-supplied
arguments are accepted.

## Failure and compatibility

- The server checks an in-memory capability set populated from Agent hello.
- Older Agents appear as `inventory_capable: false`.
- Offline Workers return `409` for live inventory.
- Probe failures are represented as unavailable sections, not as a failed
  Worker directory request.
- ADB output is parsed defensively; malformed or unknown rows remain visible as
  raw state where possible.

## Desktop experience

The sidebar gets a Worker inventory button. It opens a focused dialog with:

- Worker selection and online state.
- System and Kode version.
- CPU, memory and disk usage.
- Agent availability and versions.
- ADB device states and attached model/product identity.
- Explicit refresh and offline/unsupported states.

The dialog is observational. It does not become the monitor session view in
this change.

## Isolation

This change does not modify:

- session or event table keys;
- command routing;
- pairing token semantics;
- cross-Agent `Message` schema;
- mobile endpoint storage.

The only sync-server persistence additions, if needed, are derived directory
metadata. Worker inventory is ephemeral and read on demand.
