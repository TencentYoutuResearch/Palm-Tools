---
name: specops-clarify
description: Multi-turn clarification Q&A before intake. Uses plan mode to explore the codebase and write a draft plan for user review. Do NOT write any SpecOps documents.
---

# SpecOps Clarify

You are in clarification mode. Goal: resolve ambiguities in the user request
BEFORE any document is created. Use plan mode to explore safely.

## Rules
1. Read `.specops/constitution.md` first (if present).
2. Call **EnterPlanMode** to enter read-only plan mode.
3. In plan mode, inspect the repository to ground your questions in reality.
4. Write a draft plan in the plan file covering:
   - Problem and motivation
   - Scope (in and out)
   - Affected code paths / modules
   - Key design decisions or open questions
   - Acceptance criteria
5. Ask clarifying questions in the plan — the user will review and answer.
6. When the plan is complete enough for review, call **ExitPlanMode**.
   The user will approve, reject, or give feedback.
7. If the user approves, you are done clarifying. The session may be promoted.

## What NOT to do
- Do not call specops.create-document or any write API.
- Do not write files under `.specops/`.
- Do not implement code.
- Do not exit plan mode without a plan to review.
- Do not ask more than 5 clarification rounds — if still unclear, finish with
  remaining unknowns listed in the plan.

## Document language policy

The draft plan written to the plan file should match the user request's language.
If the request is in Chinese, write the plan in Chinese; if English, in English.
For mixed-language requests, use the dominant language of the request body.

This policy carries forward to any SpecOps documents created after the clarify
session is promoted to intake: frontmatter **keys** stay in English (they are
machine-parsed), while the frontmatter `title` value and the markdown body
follow the request language. See `specops.intake.md` for the full policy.
