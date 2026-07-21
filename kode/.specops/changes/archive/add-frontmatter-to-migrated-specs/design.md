# Design: Frontmatter assignment for migrated spec docs

## Frontmatter conventions

Based on existing spec files in this repo (`project-overview.md`, `pty-lifecycle.md`, `backend-default-args.md`, `specops-run-isolation.md`):

```yaml
---
schema_version: 1
id: <dotted/path>
kind: spec
title: <human-readable title>
status: active
verifies:
  - <verify-key>
paths:
  - <source-code-path>
---
```

### Field conventions observed

- `id`: Dotted path using `/` as namespace separator (e.g., `pty/lifecycle`, `backend/default-args`)
- `kind`: Always `spec` for files under `.specops/specs/`
- `title`: Short human-readable title
- `status`: `active` for all existing specs (no deprecated specs yet)
- `verifies`: Optional; maps to verify commands in `specops.toml`. Use `specops` for TypeScript-side docs, `rust` for Rust-side docs. Can be omitted if no verify command is appropriate.
- `paths`: Array of source file paths that the spec governs. Used by SpecOps to detect drift.

### `verifies` key mapping

From `specops.toml`:
- `rust` → `cargo test -- --test-threads=1`
- `specops` → `pnpm test` (in `apps/specops/`)

### `paths` guidance

The `paths` field should reference the source code that the spec constrains. For migrated docs that are design documents (not source-governing specs), prefer broad directory paths:

| Document type | `paths` pattern | Example |
|---|---|---|
| Design doc for a crate | `[crates/<crate>/]` | `[crates/kode-memory/]` |
| Roadmap / project plan | `[ROADMAP.md, ...]` | `[ROADMAP.md, .specops/specs/roadmap-phase-*.md]` |
| Protocol / cross-cutting spec | Relevant source dirs | `[apps/gui/src-tauri/src/transport/]` |
| SpecOps engine docs | `[apps/specops/]` | `[apps/specops/]` |

## Frontmatter template per file

### Roadmap docs

```yaml
# roadmap.md
id: roadmap
kind: spec
title: Project roadmap
status: active
paths:
  - ROADMAP.md
  - .specops/specs/roadmap-phase-0-7.md
  - .specops/specs/roadmap-phase-11.md
```

```yaml
# roadmap-phase-0-7.md
id: roadmap/phase-0-7
kind: spec
title: Phase 0-7: TUI to GUI migration
status: active
paths:
  - src/ui/
  - apps/gui/
```

```yaml
# roadmap-phase-11.md
id: roadmap/phase-11
kind: spec
title: Phase 11: Remote backend
status: active
paths:
  - services/kode-server-go/
```

### Design docs

```yaml
# memory-design.md
id: memory/design
kind: spec
title: kode-memory design
status: active
paths:
  - crates/kode-memory/
```

```yaml
# memory-git-sync.md
id: memory/git-sync
kind: spec
title: Memory git sync design
status: active
paths:
  - crates/kode-memory/src/store.rs
```

```yaml
# memory-quickstart.md
id: memory/quickstart
kind: spec
title: Memory quickstart guide
status: active
paths:
  - crates/kode-memory/
```

```yaml
# remote-protocol.md
id: remote/protocol
kind: spec
title: Remote protocol specification
status: active
paths:
  - apps/gui/src-tauri/src/transport/
  - docs/protocol-smoke.sh
```

### SpecOps engine docs

```yaml
# specops-engine-roadmap.md
id: specops-engine/roadmap
kind: spec
title: SpecOps engine roadmap
status: active
paths:
  - apps/specops/
```

```yaml
# specops-engine-cli.md
id: specops-engine/cli
kind: spec
title: SpecOps CLI reference
status: active
paths:
  - apps/specops/src/cli/
```

```yaml
# specops-engine-perf.md
id: specops-engine/perf
kind: spec
title: SpecOps performance baseline
status: active
paths:
  - apps/specops/
```

```yaml
# specops-engine-security.md
id: specops-engine/security
kind: spec
title: SpecOps security model
status: active
paths:
  - apps/specops/
```

## Why not `verifies`?

None of the migrated docs describe behavioral invariants that map to a test command. They are design documents and roadmaps — informational, not enforceable. The `verifies` field is intentionally omitted for all 11 files.

## Implementation approach

For each file, prepend the frontmatter block before the existing content. The frontmatter must be the very first bytes of the file (no leading whitespace or BOM). After frontmatter, insert exactly one blank line before the existing heading.

Example transformation for `roadmap.md`:

Before:
```markdown
# kode — 路书 / Roadmap
...
```

After:
```markdown
---
schema_version: 1
id: roadmap
kind: spec
title: Project roadmap
status: active
paths:
  - ROADMAP.md
  - .specops/specs/roadmap-phase-0-7.md
  - .specops/specs/roadmap-phase-11.md
---

# kode — 路书 / Roadmap
...
```

## Rollback

`git checkout HEAD~1 .specops/specs/` reverts all frontmatter additions. The content of each file is unchanged beyond the prepended frontmatter block.
