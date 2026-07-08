# Design: Doc migration mapping and redirect strategy

## Migration strategy

### Principle: `git mv` for active docs, `mv` + archive for stale

All docs being relocated under `.specops/` should use `git mv` to preserve history. Stale analysis files being archived don't need history preservation — their purpose was transient.

### Redirect stubs

For any file that is referenced from `CODEBUDDY.md` or external scripts, leave a minimal redirect stub at the old path:

```markdown
<!-- Redirect: this document has moved to `.specops/specs/<name>.md` -->
```

Files needing redirect stubs:
- `ROADMAP.md` → `.specops/specs/roadmap.md` (referenced by `CODEBUDDY.md`, `README.md`)
- `docs/MEMORY_DESIGN.md` → `.specops/specs/memory-design.md` (referenced by `ROADMAP.md`)
- `docs/MEMORY_GIT_SYNC.md` → `.specops/specs/memory-git-sync.md` (referenced by `ROADMAP.md`)
- `docs/PROTOCOL.md` → `.specops/specs/remote-protocol.md` (referenced by `docs/protocol-smoke.sh`)
- `docs/MEMORY_QUICKSTART.md` → `.specops/specs/memory-quickstart.md` (referenced by `ROADMAP.md`)

### Updated cross-references

After migration, update links in these files:
- `CODEBUDDY.md`: change `ROADMAP.md` link to `.specops/specs/roadmap.md`
- `README.md`: change `ROADMAP.md` link to `.specops/specs/roadmap.md`
- `.specops/specs/roadmap.md`: change `docs/roadmap/` links to `.specops/specs/roadmap-phase-*.md`
- `.specops/specs/roadmap.md`: change `docs/MEMORY_DESIGN.md` link to `.specops/specs/memory-design.md`
- `.specops/specs/roadmap.md`: change `docs/MEMORY_GIT_SYNC.md` link to `.specops/specs/memory-git-sync.md`
- `.specops/specs/roadmap.md`: change `docs/MEMORY_QUICKSTART.md` link to `.specops/specs/memory-quickstart.md`
- `docs/protocol-smoke.sh`: update comment reference to PROTOCOL.md

### Why `apps/specops/docs/` should move into `.specops/specs/`

The SpecOps engine's own docs (`ROADMAP.md`, `CLI.md`, `PERFORMANCE.md`, `SECURITY.md`) currently live at `apps/specops/docs/`. This is awkward because:

1. SpecOps is about canonical documentation — its own docs should be canonical too.
2. `apps/specops/docs/` is invisible to `specops scan` (which only scans `.specops/`).
3. Having sub-project docs inside `apps/` implies they're implementation details, but they're design contracts.

Proposed prefix: `specops-engine-*` under `.specops/specs/` to namespace them alongside kode's own specs.

### Why NOT migrate everything

**Agent instructions** (`CODEBUDDY.md`, `CLAUDE.md`, `AGENTS.md`) must stay at root because:
- CodeBuddy/Claude auto-discover `CODEBUDDY.md` / `CLAUDE.md` at repo root
- Moving them would break the auto-load mechanism

**README.md** must stay at root because:
- GitHub renders it as the project landing page
- It's the conventional entry point for human visitors

### archive/ structure

`.specops/archive/` already exists. Stale analysis files go there with descriptive names:

```
.specops/archive/
├── flutter-diagnosis.md
├── flutter-fixes.md
├── resume-investigation-report.md
├── resume-bug-analysis.md
├── resume-bug-summary.md
├── specops-analysis.md
├── memory-browser-exploration.md
├── scroll-behavior-analysis.md
├── scroll-flow-quick-ref.md
├── specops-frontend-components.md    ← NEW (added 2026-06-21)
├── specops-frontend-exploration.md   ← NEW (added 2026-06-21)
├── specops-index.md                  ← NEW (added 2026-06-21)
└── specops-quick-reference.md        ← NEW (added 2026-06-21)
```

#### Why archive, not specs?

The four new `SPECOPS_FRONTEND_*.md` files were created during a code exploration session on 2026-06-21 to document the SpecOps frontend UI. They are:

- **Transient**: Written as an exploration aid, not as maintained contracts
- **Absolute-path-heavy**: They contain absolute filesystem paths (`/Users/marxwang/...`) that make them machine-specific and unmaintainable
- **Superseded by source code**: The facts they capture are derivable by reading `apps/specops/src/server/public/`

`SPECOPS_INDEX.md` functions as an index to the others — once the others are archived it becomes an index of archived files. Archive the whole group together.

### Final directory layout

```
kode/
├── CODEBUDDY.md              # Agent instruction (stay)
├── CLAUDE.md                 # Symlink to CODEBUDDY.md (stay)
├── AGENTS.md                 # Agent instruction (stay)
├── README.md                 # Project README (stay)
├── ROADMAP.md                # Redirect stub → .specops/specs/roadmap.md
├── docs/
│   └── protocol-smoke.sh     # Updated reference to new protocol path
├── .specops/
│   ├── specs/
│   │   ├── backend-default-args.md
│   │   ├── project-overview.md
│   │   ├── pty-lifecycle.md
│   │   ├── specops-run-isolation.md
│   │   ├── roadmap.md                  ← migrated from ROADMAP.md
│   │   ├── roadmap-phase-0-7.md        ← migrated from docs/roadmap/
│   │   ├── roadmap-phase-11.md         ← migrated from docs/roadmap/
│   │   ├── memory-design.md            ← migrated from docs/
│   │   ├── memory-git-sync.md          ← migrated from docs/
│   │   ├── memory-quickstart.md        ← migrated from docs/
│   │   ├── remote-protocol.md          ← migrated from docs/PROTOCOL.md
│   │   ├── specops-engine-roadmap.md   ← migrated from apps/specops/docs/
│   │   ├── specops-engine-cli.md       ← migrated from apps/specops/docs/
│   │   ├── specops-engine-perf.md      ← migrated from apps/specops/docs/
│   │   └── specops-engine-security.md  ← migrated from apps/specops/docs/
│   ├── archive/
│   │   ├── flutter-diagnosis.md
│   │   ├── flutter-fixes.md
│   │   ├── resume-investigation-report.md
│   │   ├── resume-bug-analysis.md
│   │   ├── resume-bug-summary.md
│   │   ├── specops-analysis.md
│   │   ├── memory-browser-exploration.md
│   │   ├── scroll-behavior-analysis.md
│   │   ├── scroll-flow-quick-ref.md
│   │   ├── specops-frontend-components.md    ← NEW
│   │   ├── specops-frontend-exploration.md   ← NEW
│   │   ├── specops-index.md                  ← NEW
│   │   └── specops-quick-reference.md        ← NEW
│   └── changes/
│       ├── migrate-docs-to-specops/    ← this change
│       └── specops-theme-follows-kode.md
```

### Rollback

All operations are `git mv`, so `git checkout HEAD~1` reverts everything. No data loss risk.
