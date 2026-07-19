# specops.create-document

Create a new SpecOps document in the workspace.

## API

```
POST {SPECOPS_ORIGIN}/api/document
Authorization: Bearer {SPECOPS_TOKEN}
Content-Type: application/json
```

## Request Body

```json
{
  "path": ".specops/{specs|changes}/{id}.md",
  "content": "---\nschema_version: 2\nid: \"{id}\"\nkind: {kind}\ndocument_class: {normative|work_item}\nspec_type: {capability|action|contract|verification|architecture|policy|invariant}\nwork_type: {feature|bugfix|refactor|investigation|docs|chore}\ntitle: \"{title}\"\nstatus: {status}\n---\n\n{body}"
}
```

## Parameters

- **kind** (required): `spec` for normative documents; a concrete work kind for work items
- **document_class** (required in schema v2): `normative` | `work_item`
- `spec_type` is only valid for normative specs; `work_type`, `targets`, and `workflow_profile` are only valid for work items.
- **id** (required): unique identifier matching `[A-Za-z0-9][A-Za-z0-9._/-]{0,127}`
  - Format: `{YYYY-MM-DD}-{slug}`
  - Example: `2026-06-21-fix-session-char-loss`
- **title** (required): non-empty string, 5-10 words describing the intent
- **body** (required): markdown content after the YAML frontmatter
- **status** (required): `draft` for new normative specs, `proposed` for work-item changes. Never use `proposed` with `document_class: normative`.

## Classification → Kind Mapping

| Classification | kind | directory |
|---|---|---|
| spec (constraint/standard) | `spec` | `specs` |
| bug (fix) | `change` | `changes` |
| refactor (restructure) | `change` | `changes` |
| feature (new capability) | `change` | `changes` |
| investigation (research) | `change` | `changes` |

## Change Folder Creation

For `change` kind, create the full folder structure instead of a single file:

1. Create directory `.specops/changes/{slug}/`
2. Write `proposal.md` with YAML frontmatter (kind: change, status: proposed)
3. Write `tasks.md` with implementation checklist
4. Optionally write `design.md` and `specs/` subdirectory
5. Use `POST /api/document` for each file individually

## Success Response (201)

```json
{ "ok": true, "path": ".specops/changes/2026-06-21-fix-session-char-loss.md", "version": "abc123..." }
```

## Error Responses

- **409**: document already exists at this path → use a different id
- **400**: invalid path, content format, or missing required fields
- **401**: invalid or missing token → check SPECOPS_TOKEN
