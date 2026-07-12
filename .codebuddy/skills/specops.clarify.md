---
name: specops-clarify
description: Resolve blocking uncertainty through structured questions before proposing an approval-ready plan. Use before intake for ambiguous feature, bug, refactor, or investigation requests. Do not write SpecOps documents.
---

# SpecOps Clarify

Resolve ambiguity before any document is created. Use plan mode for safe
repository exploration and structured questions for user decisions.

## Rules
1. Read `.specops/constitution.md` first (if present).
2. Call **EnterPlanMode** to enter read-only plan mode.
3. Inspect the repository and classify each uncertainty:
   - `blocking`: changes scope, architecture, user-visible behavior, or risk.
   - `defaultable`: has a safe recommended default.
   - `discovered`: comes from existing code, specs, or project constraints.
4. Use **AskUserQuestion** for blocking uncertainty. Ask at most 3 focused
   single-select questions per round; include a recommended option and describe
   its impact.
5. Record accepted defaults as decisions. Do not ask the same question again
   unless new repository evidence invalidates the answer.
6. After blocking uncertainty is resolved, write a draft plan covering:
   - Problem and motivation
   - Scope (in and out)
   - Affected code paths / modules
   - Confirmed decisions and remaining non-blocking assumptions
   - Acceptance criteria
7. Call **ExitPlanMode** only when scope, non-goals, acceptance criteria, and
   material risks are explicit. Do not hide unanswered questions in the plan.
   The user will approve, reject, or give feedback.
8. If the user approves, clarification is complete and the session may be promoted.

## What NOT to do
- Do not call specops.create-document or any write API.
- Do not write files under `.specops/`.
- Do not implement code.
- Do not use ordinary chat text when AskUserQuestion is available.
- Do not exit plan mode while blocking uncertainty remains unresolved.
- Do not ask more than 5 clarification rounds — if still unclear, finish with
  an explicit blocked result instead of inventing requirements.

## Document language policy

The draft plan written to the plan file should match the user request's language.
If the request is in Chinese, write the plan in Chinese; if English, in English.
For mixed-language requests, use the dominant language of the request body.

This policy carries forward to any SpecOps documents created after the clarify
session is promoted to intake: frontmatter **keys** stay in English (they are
machine-parsed), while the frontmatter `title` value and the markdown body
follow the request language. See `specops.intake.md` for the full policy.
