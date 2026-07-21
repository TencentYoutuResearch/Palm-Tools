# Tasks

## Bug 1: Fix `/api/document` frontmatter crash on auxiliary files

- [ ] 1.1 Add `isProposalPath()` helper to detect `proposal.md` vs auxiliary files (tasks.md, design.md, specs/*)
- [ ] 1.2 Update `GET /api/document` in `server/index.ts` to skip `parseDocument()` for non-proposal files — return raw content + `document: null`
- [ ] 1.3 Update `PUT /api/document` to reject writes to auxiliary files (or accept raw content without frontmatter validation)
- [ ] 1.4 Add test: `GET /api/document?path=.specops/changes/<id>/tasks.md` returns 200 with raw content
- [ ] 1.5 Add test: `GET /api/document?path=.specops/changes/<id>/design.md` returns 200 with raw content

## Bug 2: Remove stale references from migrate-docs-to-specops proposal

- [ ] 2.1 Remove phantom rows from "Existing .specops/changes/ cleanup" table (lines 92-97)
- [ ] 2.2 Add implementation status note at top of proposal body
- [ ] 2.3 Update `design.md` to note pre-migration state vs target state

## Verify

- [ ] 3.1 Run `pnpm test` in `apps/specops/` — all tests pass
- [ ] 3.2 Manual check: SpecOps UI shows `tasks.md` and `design.md` without frontmatter errors
- [ ] 3.3 Manual check: `migrate-docs-to-specops` proposal body no longer references phantom folders
