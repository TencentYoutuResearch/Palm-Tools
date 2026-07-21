---
name: specops-intake
description: Analyze a natural-language request and create canonical SpecOps documents (specs or change folders). Use for feature, bug, refactor, specification, or investigation intake before implementation.
---

# SpecOps Intake

Analyze the request and create one or more canonical SpecOps documents.
Do not edit source files, implement code, or create a Git worktree. The only
permitted writes are new documents under `.specops/`.

## Classification

Read `.specops/constitution.md` first. If any proposed document would violate a
declared invariant, surface the conflict in `proposal.md` under a
`## Constitution conflicts` heading rather than silently complying.

- `spec`: durable normative capability, action, contract, verification, architecture, policy, or invariant. It has no implementation workflow.
- `bug`: broken behavior that needs a fix
- `refactor`: structural change without intended behavior change
- `feature`: new user-facing or developer-facing capability
- `investigation`: research, diagnosis, or feasibility work without implementation

Inspect relevant repository files and `specops.toml` before deciding. Consolidate
all useful analysis into the document body; do not leave essential information
only in the chat response.

## Directory Mapping

- `spec` → `.specops/specs/<id>.md` (single file, `kind: spec`)
- `bug` → `.specops/changes/<id>/` (change folder, `kind: bug`)
- `refactor` → `.specops/changes/<id>/` (change folder, `kind: refactor`)
- `feature` → `.specops/changes/<id>/` (change folder, `kind: feature`)
- `investigation` → `.specops/changes/<id>/` (change folder, `kind: investigation`)

## Change Folder Structure

For `bug`, `refactor`, `feature`, and `investigation`, create a change folder:

```
.specops/changes/<slug>/
├── proposal.md     # YAML frontmatter + body (required)
├── tasks.md        # Implementation checklist (required)
├── design.md       # Technical decisions (optional)
└── specs/          # Delta specs — new/modified specs for this change (optional)
    └── <spec-name>/
        └── spec.md
```

### proposal.md

Must have YAML frontmatter. Default status by kind: `active` for specs, `proposed` for changes.

```markdown
---
schema_version: 2
id: add-dark-mode
kind: feature
document_class: work_item
work_type: feature
targets:
  - theme/system
title: Add dark mode support
status: proposed
verifies:
  - lint
  - test
paths:
  - apps/gui/src
---

# Add dark mode support

## Motivation

...
```

`kind` and `work_type` are intentionally not identical for bugs: use
`kind: bug` together with `work_type: bugfix`. Valid `work_type` values are
only `feature`, `bugfix`, `refactor`, `investigation`, `docs`, and `chore`;
never write `work_type: bug`.

> **`verifies` must only list verify names defined in `specops.toml` under
> `[verify.*]` sections.** Read `specops.toml` first. If a needed check is not
> defined, either add the `[verify.<name>]` section to `specops.toml` (with a
> `command` array) as part of this change, or leave `verifies` empty (`[]`).
> Do NOT invent verify names like `lint` or `test` unless they exist in
> `specops.toml` — the Run will fail with "unknown verify".

### tasks.md

Checklist of implementation steps:

```markdown
# Tasks

- [ ] Add theme context and CSS variables
- [ ] Implement toggle in settings page
- [ ] Persist preference to localStorage
- [ ] Add tests for theme switching
```

### design.md (optional)

Technical design decisions and trade-offs.

### specs/ (optional)

Delta specs — each subfolder is a spec name, containing a `spec.md` with YAML frontmatter (kind `spec`). Only create these if the change introduces new constraints or modifies existing ones.

For schema-version 2, keep document class and status paired:

| document_class | Default status | Other valid statuses |
|---|---|---|
| `normative` | `draft` | `active`, `deprecated`, `superseded`, `archived` |
| `work_item` | `proposed` | `approved`, `in_progress`, `blocked`, `completed`, `cancelled`, `archived` |

Never use `status: proposed` for `document_class: normative`, including `design.md` and delta `spec.md` files.

## Checklist

Run the `specops.checklist` skill before writing the receipt. The proposal.md
body MUST contain `## Motivation`, `## Scope`, `## Acceptance criteria`, and
`## Out of scope` sections. The server validates these on receipt.

## Receipt

After writing all documents, write the receipt as the final filesystem operation.
Write it to `.specops/state/intakes/<intake_id>.json` (use the intake_id given in
the intake prompt as the filename):

```json
{
  "schema_version": 1,
  "intake_id": "<id from intake prompt>",
  "status": "ready",
  "primary": ".specops/changes/add-dark-mode",
  "documents": [
    ".specops/changes/add-dark-mode",
    ".specops/changes/add-dark-mode/proposal.md",
    ".specops/changes/add-dark-mode/tasks.md",
    ".specops/changes/add-dark-mode/design.md",
    ".specops/specs/theme-system/spec.md"
  ]
}
```

The `primary` must be the main change folder path or the main spec file path.
List every created path exactly once and include `primary` in `documents`.
Only write `status: ready`; the SpecOps server validates every listed document
with its canonical schema parser and promotes the receipt to `completed`.
Finish by reporting only the created relative paths.

## Document language policy

Match the document language to the user request's language. If the request is
in Chinese, write the `proposal.md` / `tasks.md` / `design.md` bodies and the
frontmatter `title` value in Chinese. If the request is in English, write them
in English. For mixed-language requests, use the dominant language of the
request body.

Keep YAML frontmatter **keys** (`schema_version`, `id`, `kind`, `document_class`,
`spec_type`, `work_type`, `targets`, `workflow_profile`, `status`, `verifies`, `paths`) in English — they are parsed by the SpecOps server, gate,
and drift analyzers. Only the `title` **value** and the markdown body follow
the request language.

Do not translate the user request when quoting it verbatim inside the
documents.
