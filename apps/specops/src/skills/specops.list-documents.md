# specops.list-documents

List all SpecOps documents in the workspace. Use this to check for existing specs before creating new ones.

## API

```
GET {SPECOPS_ORIGIN}/api/state
Authorization: Bearer {SPECOPS_TOKEN}
```

## Response

```json
{
  "workspace": "/path/to/repo",
  "scan": {
    "ok": true,
    "command": "scan",
    "data": {
      "schema_version": 1,
      "generated_at": "2026-06-21T10:00:00.000Z",
      "documents": [
        {
          "id": "project-overview",
          "kind": "spec",
          "title": "Project overview",
          "status": "active",
          "path": ".specops/specs/project-overview.md",
          "verifies": [],
          "paths": []
        }
      ]
    },
    "diagnostics": []
  },
  "drift": {
    "ok": true,
    "diagnostics": []
  }
}
```

## Document Fields

| Field | Description |
|---|---|
| `id` | Unique document identifier |
| `kind` | `spec` or `change` |
| `title` | Human-readable title |
| `status` | `draft`, `active`, `proposed`, `completed`, or `archived` |
| `path` | Relative path from workspace root |
| `verifies` | IDs of documents this one verifies |
| `paths` | File paths this document concerns |

## Usage

- Before creating a new document, check if one already exists for the same topic
- Filter by `kind` to find only specs or only changes
- Check `status` to find active vs draft vs archived documents
- Change documents are folders under `.specops/changes/` containing `proposal.md`, `tasks.md`, etc.
