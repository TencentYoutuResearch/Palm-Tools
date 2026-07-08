# Design: Fix frontmatter crash and stale proposal references

## Bug 1: `parseDocument()` crashes on `tasks.md` / `design.md`

### Two crash sites

**Site A — `/api/document` handler** (`server/index.ts:220-224`):

```typescript
if (request.method === 'GET' && url.pathname === '/api/document') {
  const file = await resolveDocumentPath(workspace, relativePath)
  const content = await readText(file)
  return json(response, 200, { document: parseDocument(content, relativePath), ... })
}
```

Any request to `/api/document?path=.specops/changes/<id>/tasks.md` crashes because `parseDocument()` requires YAML frontmatter.

**Site B — Intake receipt validation** (`server/index.ts:191-197`):

```typescript
for (const documentPath of receipt.documents) {
  const file = await resolveDocumentPath(workspace, documentPath)
  const stat = await import('node:fs/promises').then((m) => m.stat(file))
  if (stat.isFile()) {
    parseDocument(await readText(file), documentPath)  // ← crashes on tasks.md/design.md
  }
}
```

The receipt lists all created files (proposal.md, tasks.md, design.md). The validation loop calls `parseDocument()` on every file, crashing on non-proposal files. This is the **immediate cause** of the error the user reported — the intake polling (triggered after the receipt is written) tries to validate all files and hits `tasks.md`.

### Which files have frontmatter?

| File | Has frontmatter? | Rationale |
|---|---|---|
| `proposal.md` | Yes | Defines change metadata (id, title, status, verifies, paths) |
| `tasks.md` | No | Plain checklist, per skill spec |
| `design.md` | No | Free-form technical notes, per skill spec |
| `specs/<name>/spec.md` | Yes | Delta spec — same format as `.specops/specs/*.md` |

### Fix approach

**For Site A (`/api/document`)**:

```typescript
function isSpecDocumentPath(filePath: string): boolean {
  const basename = path.basename(filePath)
  // proposal.md always has frontmatter; delta specs under specs/ also have frontmatter
  return basename === 'proposal.md' || filePath.includes('/specs/')
}

// In the handler:
if (isSpecDocumentPath(file)) {
  const doc = parseDocument(content, relativePath)
  return json(response, 200, { document: doc, content, version: version(content) })
} else {
  return json(response, 200, { document: null, content, version: version(content) })
}
```

**For Site B (intake receipt validation)**:

Skip `parseDocument()` for files that aren't spec documents:

```typescript
if (stat.isFile() && isSpecDocumentPath(file)) {
  parseDocument(await readText(file), documentPath)
}
// tasks.md, design.md: just check they're readable (stat already did that)
```

### Impact on frontend

`app.js` `openChangeFile()` (line 92-106) and `openDocument()` (line 76-89) both access `payload.document.title`, `payload.document.kind`, etc. After the fix, `document` may be `null` for auxiliary files. Need to handle null:

```javascript
if (payload.document) {
  title.textContent = payload.document.title
  kind.textContent = `${payload.document.kind} / ${payload.document.status} / ${payload.document.id}`
} else {
  // Derive display info from the path
  const parts = filePath.split('/')
  title.textContent = parts[parts.length - 1]
  kind.textContent = 'change / ' + parts[parts.length - 1]
}
```

### Why not just add frontmatter to tasks.md/design.md?

The skill spec intentionally makes these plain markdown. Adding frontmatter would make them parseable but would create ambiguity: should `tasks.md` have its own `id`/`kind`/`status`? It shouldn't — it's subordinate to the change folder's `proposal.md`. The fix should be in the code that reads these files, not in the files themselves.

## Bug 2: Stale references in `migrate-docs-to-specops` proposal body

### Current state

`migrate-docs-to-specops/proposal.md` lines 92-97 references three non-existent resources:

| Reference | Status on disk |
|---|---|
| `migrate-design-docs-to-specops/` | Never created |
| `migrate-roadmap-to-specops/` | Never created |
| `specops-theme-follows-kode.md` | Never created |

### Fix

1. Remove the three phantom rows from the table
2. Add a prominent note at the top of the body:

```markdown
> **Status**: This migration has not been executed. All documents remain in their original locations. The sections below describe the target state after migration.
```
