# specops.archive-change

Archive a completed change by moving its folder to `changes/archive/{date}-{slug}/`.

## API

```
POST {SPECOPS_ORIGIN}/api/changes/{change_id}/archive
Authorization: Bearer {SPECOPS_TOKEN}
```

## Parameters

- **change_id**: The `id` from the change's `proposal.md` frontmatter (e.g. `add-dark-mode`)

## Response

```json
{
  "from": ".specops/changes/add-dark-mode",
  "to": ".specops/changes/archive/2026-06-21-add-dark-mode"
}
```

## How It Works

1. Scans `.specops/changes/` for a folder containing `proposal.md` with the matching `id`
2. Moves the folder to `.specops/changes/archive/{YYYY-MM-DD}-{slug}/`
3. Updates `proposal.md` status to `archived`

## Prerequisites

- Change must exist under `.specops/changes/`
- Archive target must not already exist
- Change should be in `completed` status before archiving. **A successful `specops.apply-run` with a `change_id` already sets this for you** — no manual status update is needed between apply and archive. If you archive a `proposed` change (e.g. legacy data that never went through the auto-transition), archive will emit a `warning` diagnostic but still succeed — this is intentional so historical proposals aren't stranded.

## Error Responses

- **404**: change not found with the given id
- **409**: archive target already exists
