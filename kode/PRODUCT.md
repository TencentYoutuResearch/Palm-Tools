# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Scope
This record covers the Superagents IM extension in integrations/dsh. It does not redefine the existing Tauri or mobile products.

## Users and purpose
A single owner configures persistent Superagents, then communicates requirements through them without managing Worker sessions or models. Superagents coordinate authorized work and return traceable outcomes.

## Operating context
Extend dsh's existing sidebar and conversation workspace. Canonical registered workspaces contain team channels, project direct messages when supported, and their original native Sessions. Preserve the single native project tree, title and Session store. The Builder is an explicitly global entry. Application installation and connections stay in dsh plugin management; there is no duplicate workspace app list. Saved v3 navigation binds the exact Home/Host/workspace/root tuple; older unscoped records cannot select a workspace by name. No mode switch hides navigation. This is a navigation-continuity requirement: native mode controls may remain, but must not replace the workspace/project tree or strand channel, private-message or Session navigation. The home Hub owns team state; Workers may run locally or remotely. Switching views must not create, stop or authorize work. Future Git integration prioritizes merge requests / pull requests and issues. Workspace links should reference real repository/project resources backed by dsh plugins; do not add a parallel installation, credential or permission system.

## Capabilities and constraints
Creation assistant, contacts, long-lived conversation, process evidence, configurable workflow/delivery, permissions and clearly labeled team budgets are required. Worker logs stay in the process view. Workspace channels and scoped discussion threads are part of this phase; multi-user collaboration, TypeScript migration and mobile migration remain outside it.

## Product principles
- Keep team identity separate from runtime sessions.
- Show actual state and uncertainty; never infer completion from prose or delivery acceptance.
- Make evidence available without putting internal logs in the main conversation.
- Lead requirement conversations with goals, usage scenarios and observable acceptance results. Preserve original human input and every explicit technical constraint; natural wording is not a filter for paths, APIs or prohibitions. Explain verified outcomes and open questions without making the owner prescribe internal tool steps. See [requirement dialogue and replay boundaries](integrations/dsh/docs/requirement-dialogue.md).
- Preserve existing dsh visual tokens, typography, themes and keyboard conventions.

## Channel-first collaboration
- Channels are the main home for requirements, discussion and task archives. Private messages are a low-noise surface for core updates and decisions, not the default execution feed.
- Long Superagent private replies use a display-only excerpt copied from the original text, with a visible truncation marker and access to the unchanged full original. This is not a generated summary or proof that the excerpt includes every important detail. Human messages remain intact.
- A discussion opens in a right-hand sidebar containing the root message and actual replies. Task and execution controls live in a separate, initially collapsed disclosure; private-conversation execution details use an on-demand inspector. Task, WorkRun and exact native Session links expose evidence without replacing discussion prose with a pipeline.
- Narrow layouts may show the selected discussion or inspector as the full conversation pane, with close/back navigation and focus restoration. They do not create a second project tree or a second Session identity.
- Empty states and channel guidance only explain or navigate. They create no channels, move or publish no private history, and grant no permissions. Creation, publication and execution retain their explicit scoped actions and existing authorization gates.

## Native reuse and visual direction
Keep the DSH shell, project tree, components, typography and theme tokens. This is an extension of the incumbent DSH system, not an independent visual world: reuse the native Input/Button/Modal primitives, semantic `--dsw-*` colors, radii and focus tokens, and upstream editor styles rather than defining a parallel token catalog. Use readable prose, restrained separators and progressive disclosure, rather than cloning another product's branding. The interaction references are [Slack threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions) for focused replies beside the channel, and [Linear collapsed history](https://linear.app/changelog/2025-04-03-collapsed-issue-history) for details available without dominating the primary content.

The independent `@kode/dsh-composer` package reuses the native editor, keymap and InputBar styles from pinned DSH conversation UI 0.2.1-rc.5. Its build validates upstream version, client source SHA-256 and reviewed extension SHA-256 against `packages/composer/upstream-lock.json`, preserving the upstream MIT license. It does not register a second Conversation runtime, manufacture Sessions or fall back to a textarea. Callers retain scoped durable drafts, request IDs, authorization and receipt handling. Attachments and voice are not supported by this text-only component.

## Verification boundary
The channel-first acceptance fixture uses the real isolated renderer and Hub with controlled content and execution records. It does not launch a model or establish new live Hy4 business/model acceptance. On 2026-11-10, the completed no-provider suite recorded 1,628 tests: 1,292 passed, 336 environment-gated skips and zero failures. Controlled real-renderer/Hub browser checks covered widths of 1440, 1000 and 390 pixels, exact persistence/restoration and bounded editor height for 36-line root/thread/private-message drafts, Chromium DevTools composition, and synthetic clipboard over-limit rejection of the entire edit with scope restoration. These are not OS Chinese-IME or system-clipboard acceptance tests. After the final selected-panel/scope highlight correction, the current-source no-provider rerun confirmed the same 1,628-test result (24.44 seconds); the core real-browser tests passed 13/13 and the three legacy tests against explicitly shipped artifacts passed 3/3. The complete channel-first matrix passed (5.69 seconds), including current-selection markers for channels, discussion DMs, Teams and native Sessions. Environment-gated skips remain untested in this run; this is not all-environment acceptance. The existing P1 resource/approval revocation and stale-409 work remains pending and is not completed by this presentation change.

## Evidence on hand
Confirmed requirements and architecture: .specops/changes/super-agent-im-collab. Backend, Host and rendered IM acceptance scopes are recorded in .specops/changes/super-agent-im-collab/validation.md and acceptance-audit.md.
