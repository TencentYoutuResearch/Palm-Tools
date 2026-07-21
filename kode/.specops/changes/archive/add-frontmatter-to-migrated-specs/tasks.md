# Tasks

## Preparation

- [ ] 0.1 Review existing spec files (`project-overview.md`, `pty-lifecycle.md`, `backend-default-args.md`, `specops-run-isolation.md`) to understand the exact frontmatter format and conventions used in this repo
- [ ] 0.2 Confirm all 11 files exist and verify they still lack frontmatter: `for f in .specops/specs/*.md; do head -1 "$f" | grep -q '^---$' || echo "MISSING: $f"; done`

## Phase 1: Roadmap docs (3 files)

- [ ] 1.1 Add YAML frontmatter to `.specops/specs/roadmap.md`
  - `id: roadmap` | `kind: spec` | `title: Project roadmap` | `paths: [ROADMAP.md, .specops/specs/roadmap-phase-0-7.md, .specops/specs/roadmap-phase-11.md]`
- [ ] 1.2 Add YAML frontmatter to `.specops/specs/roadmap-phase-0-7.md`
  - `id: roadmap/phase-0-7` | `kind: spec` | `title: Roadmap Phase 0-7: TUI to GUI migration` | `paths: [src/ui/, apps/gui/]`
- [ ] 1.3 Add YAML frontmatter to `.specops/specs/roadmap-phase-11.md`
  - `id: roadmap/phase-11` | `kind: spec` | `title: Roadmap Phase 11: Remote backend` | `paths: [services/kode-server-go/]`

## Phase 2: Design docs (4 files)

- [ ] 2.1 Add YAML frontmatter to `.specops/specs/memory-design.md`
  - `id: memory/design` | `kind: spec` | `title: kode-memory design` | `paths: [crates/kode-memory/]`
- [ ] 2.2 Add YAML frontmatter to `.specops/specs/memory-git-sync.md`
  - `id: memory/git-sync` | `kind: spec` | `title: Memory git sync design` | `paths: [crates/kode-memory/src/store.rs]`
- [ ] 2.3 Add YAML frontmatter to `.specops/specs/memory-quickstart.md`
  - `id: memory/quickstart` | `kind: spec` | `title: Memory quickstart guide` | `paths: [crates/kode-memory/]`
- [ ] 2.4 Add YAML frontmatter to `.specops/specs/remote-protocol.md`
  - `id: remote/protocol` | `kind: spec` | `title: Remote protocol specification` | `paths: [apps/gui/src-tauri/src/transport/, docs/protocol-smoke.sh]`

## Phase 3: SpecOps engine docs (4 files)

- [ ] 3.1 Add YAML frontmatter to `.specops/specs/specops-engine-roadmap.md`
  - `id: specops-engine/roadmap` | `kind: spec` | `title: SpecOps engine roadmap` | `paths: [apps/specops/]`
- [ ] 3.2 Add YAML frontmatter to `.specops/specs/specops-engine-cli.md`
  - `id: specops-engine/cli` | `kind: spec` | `title: SpecOps CLI reference` | `paths: [apps/specops/src/cli/]`
- [ ] 3.3 Add YAML frontmatter to `.specops/specs/specops-engine-perf.md`
  - `id: specops-engine/perf` | `kind: spec` | `title: SpecOps performance baseline` | `paths: [apps/specops/]`
- [ ] 3.4 Add YAML frontmatter to `.specops/specs/specops-engine-security.md`
  - `id: specops-engine/security` | `kind: spec` | `title: SpecOps security model` | `paths: [apps/specops/]`

## Phase 4: Verify

- [ ] 4.1 Run `specops scan` to confirm no more missing-frontmatter errors
- [ ] 4.2 Open SpecOps UI and click each of the 11 files — confirm they display without errors
- [ ] 4.3 Verify frontmatter fields are correct: `schema_version: 1`, `kind: spec`, `status: active` for all
- [ ] 4.4 Run `pnpm test` in `apps/specops/` to confirm no regressions
