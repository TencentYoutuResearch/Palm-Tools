# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Scope
This record covers the Superagents IM extension in integrations/dsh. It does not redefine the existing Tauri or mobile products.

## Users and purpose
A single owner configures persistent Superagents, then communicates requirements through them without managing Worker sessions or models. Superagents coordinate authorized work and return traceable outcomes.

## Operating context
Extend dsh's existing sidebar and conversation workspace. Retain a Session mode for ordinary sessions and diagnostics. The home Hub owns team state; Workers may run locally or remotely. Switching views must not create, stop or authorize work.

## Capabilities and constraints
Creation assistant, contacts, long-lived conversation, process evidence, configurable workflow/delivery, permissions and clearly labeled team budgets are required. Worker logs stay in the process view. Group chat, multiple users, TypeScript migration and mobile migration are outside this phase.

## Product principles
- Keep team identity separate from runtime sessions.
- Show actual state and uncertainty; never infer completion from prose or delivery acceptance.
- Make evidence available without putting internal logs in the main conversation.
- Preserve existing dsh visual tokens, typography, themes and keyboard conventions.

## Evidence on hand
Confirmed requirements and architecture: .specops/changes/super-agent-im-collab. Backend, Host and rendered IM acceptance scopes are recorded in .specops/changes/super-agent-im-collab/validation.md and acceptance-audit.md.
