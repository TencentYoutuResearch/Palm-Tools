# Tasks

## Phase 1: Roadmap docs migration

- [x] 1.1 `git mv ROADMAP.md .specops/specs/roadmap.md`, leave redirect stub at `ROADMAP.md`
- [x] 1.2 `git mv docs/roadmap/phase-0-7-tui-to-gui.md .specops/specs/roadmap-phase-0-7.md`
- [x] 1.3 `git mv docs/roadmap/phase-11-remote-backend.md .specops/specs/roadmap-phase-11.md`
- [x] 1.4 Remove empty `docs/roadmap/` directory
- [x] 1.5 Update `CODEBUDDY.md`, `AGENTS.md`, `README.md` links to point to new `.specops/specs/` paths

## Phase 2: Design docs migration

- [x] 2.1 `git mv docs/MEMORY_DESIGN.md .specops/specs/memory-design.md`
- [x] 2.2 `git mv docs/MEMORY_GIT_SYNC.md .specops/specs/memory-git-sync.md`
- [x] 2.3 `git mv docs/PROTOCOL.md .specops/specs/remote-protocol.md`
- [x] 2.4 `git mv docs/MEMORY_QUICKSTART.md .specops/specs/memory-quickstart.md`
- [x] 2.5 `docs/protocol-smoke.sh` does not reference PROTOCOL.md path directly — no update needed
- [x] 2.6 Cross-references in `CODEBUDDY.md` updated; `.specops/specs/roadmap.md` internal links already correct

## Phase 3: Stale analysis archive

- [x] 3.1 `FLUTTER_DIAGNOSIS.md` → `.specops/changes/archive/_legacy-investigations/flutter-diagnosis.md`
- [x] 3.2 `FLUTTER_FIXES.md` → `.specops/changes/archive/_legacy-investigations/flutter-fixes.md`
- [x] 3.3 `INVESTIGATION_REPORT.md` → `.specops/changes/archive/_legacy-investigations/resume-investigation-report.md`
- [x] 3.4 `RESUME_BUG_ANALYSIS.md` → `.specops/changes/archive/_legacy-investigations/resume-bug-analysis.md`
- [x] 3.5 `RESUME_BUG_SUMMARY.md` → `.specops/changes/archive/_legacy-investigations/resume-bug-summary.md`
- [x] 3.6 `SPECOPS_ANALYSIS.md` → `.specops/changes/archive/_legacy-investigations/specops-analysis.md`
- [x] 3.7 `memory_browser_exploration.md` → `.specops/changes/archive/_legacy-investigations/memory-browser-exploration.md`
- [x] 3.8 `SCROLL_BEHAVIOR_ANALYSIS.md` → `.specops/changes/archive/_legacy-investigations/scroll-behavior-analysis.md`
- [x] 3.9 `SCROLL_FLOW_QUICK_REF.md` → `.specops/changes/archive/_legacy-investigations/scroll-flow-quick-ref.md`
- [x] 3.10 `SPECOPS_FRONTEND_COMPONENTS.md` → `.specops/changes/archive/_legacy-investigations/specops-frontend-components.md`
- [x] 3.11 `SPECOPS_FRONTEND_EXPLORATION.md` → `.specops/changes/archive/_legacy-investigations/specops-frontend-exploration.md`
- [x] 3.12 `SPECOPS_INDEX.md` → `.specops/changes/archive/_legacy-investigations/specops-index.md`
- [x] 3.13 `SPECOPS_QUICK_REFERENCE.md` → `.specops/changes/archive/_legacy-investigations/specops-quick-reference.md`

## Phase 4: SpecOps engine docs migration

- [x] 4.1 `apps/specops/docs/ROADMAP.md` → `.specops/specs/specops-engine-roadmap.md`
- [x] 4.2 `apps/specops/docs/CLI.md` → `.specops/specs/specops-engine-cli.md`
- [x] 4.3 `apps/specops/docs/PERFORMANCE.md` → `.specops/specs/specops-engine-perf.md`
- [x] 4.4 `apps/specops/docs/SECURITY.md` → `.specops/specs/specops-engine-security.md`
- [x] 4.5 `apps/specops/docs/` removed (empty after migration)
- [x] 4.6 No `apps/specops/src/` code referenced `docs/` paths

## Phase 5: Existing .specops cleanup

- [x] 5.1 `migrate-design-docs-to-specops/` — never existed, no action needed
- [x] 5.2 `migrate-roadmap-to-specops/` — never existed, no action needed
- [x] 5.3 `.specops/state/SPEC-LINKS.md` — file does not exist, no action needed

## Phase 6: Verify

- [x] 6.2 Grep confirms no stale `docs/roadmap/`, `docs/MEMORY_`, `docs/PROTOCOL.md` paths in .md/.sh files
- [x] 6.3 `cargo test -- --test-threads=1` — no code changes in this migration, skip
- [x] 6.4 `CODEBUDDY.md` links updated to canonical `.specops/specs/roadmap.md`
