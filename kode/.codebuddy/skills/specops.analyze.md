---
name: specops-analyze
description: Run cross-artifact consistency analysis across all SpecOps documents. Detects tasks not covering proposal scope, design components missing from tasks, and invalid verifies/paths.
---

# specops.analyze

Runs static cross-artifact checks on the current `.specops/` registry.

## API

```
POST {SPECOPS_ORIGIN}/api/analyze
Authorization: Bearer {SPECOPS_TOKEN}
```

## Response (200)

```json
{
  "ok": true,
  "data": {
    "cross_artifact_gaps": [
      { "id": "add-dark-mode", "gap": "tasks.md does not reference 'theme context' from proposal scope", "severity": "warning" }
    ],
    "constitution_missing": false
  },
  "diagnostics": []
}
```

## Severity
- `error`: invalid verifies reference
- `warning`: scope/coverage gap (heuristic, may be false positive)
- `info`: minor inconsistency

## When to use
- Before `specops.create-run` (mandatory in workflow Phase 2.9).
- After editing tasks.md or design.md.
