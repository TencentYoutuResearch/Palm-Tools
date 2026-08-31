# UX Contract

## Product context

- Audience: Developers supervising AI coding sessions and shared project memory.
- Primary jobs: Run and inspect sessions, review memory proposals, search approved facts, and manage local/remote workspaces.
- Target markets: Global developer tooling.
- Active locales: English and Simplified Chinese.
- Language/content register: Direct, technical, and action-led; owned visible and accessible copy localize together.
- Timezone/calendar policy: Timestamps display in the user's local timezone; no market calendar is implied.
- Accessibility target: WCAG 2.2 AA.

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Memory lifecycle and review | `.specops/specs/memory-design.md` | Domain spec | 2026-08-20 |
| Memory synchronization | `.specops/specs/memory-git-sync.md` | Domain spec | 2026-08-20 |
| Product architecture and platform constraints | `CODEBUDDY.md` | Maintained project context | 2026-08-20 |
| Mobile binding, sync, permissions, and command lifecycle | `.specops/specs/cloud-sync-protocol.md` | Domain/API contract | 2026-08-20 |

Billing, payment, regulated copy, and end-user permission policy are not part of the current memory-review surface.

## Visual contract

- Project design context: `docs/DESIGN.md`.
- Token ownership model: Existing runtime is canonical; `docs/DESIGN.md` mirrors intent and normative values.
- Runtime design-system/token source: `apps/gui/index.html`; xterm-specific colors in `apps/gui/src/lib/terminal_settings.ts`.
- Mapping/export/adapters: CSS custom properties consumed by Svelte components; `terminal_settings.ts` maps dark/light modes to xterm defaults and the standard ANSI palette. Child-process ANSI bytes remain unmodified.
- Token drift gate: `designmd lint`, `pnpm check`, and production build.
- Supported themes: Dark, light, system preference, and forced-colors operability.
- Design-context owner/review policy: Durable visual changes update `docs/DESIGN.md` and the runtime owner together.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Table Selection | `apps/gui/src/lib/SelectionCheckbox.svelte`; memory-review behavior in `MemoryPanel.svelte` | This contract + memory design spec | visible-list selection | Svelte check + browser keyboard/state matrix |
| Scrollbar | `apps/gui/index.html` global application stylesheet | `docs/DESIGN.md` | stable-gutter geometry only | computed style + browser |
| Toast | `apps/gui/src/lib/ToastHost.svelte` + `toast.ts` | This contract | info / success / warning / error | live region + browser |
| CRUD | `memoryIpc` and `MemoryPanel.svelte` | memory design spec | local / remote source | unit/typecheck + full review flow |
| Form | Cloud relay form in `PairingDialog.svelte`; authoritative validation in `cloud_deploy.rs` / `cloud_sync.rs` | Cloud sync protocol + this contract | SSH deployment / existing service | Svelte check + Rust tests + WebView |
| Select/Listbox | Native `<select>` for the small saved-backend switcher | This contract | platform-owned popup accepted | keyboard + WebView open state |
| Terminal Theme | `terminal_settings.ts` + `terminal_ansi_theme.ts` plus spawn-time `TERM_THEME` / `COLORFGBG`; consumed by `Terminal.svelte`, `ShellTerminalPanel.svelte`, and the PTY spawn layer | `docs/DESIGN.md` + this contract | dark / light / follow app | foreground-preservation/background-mapping unit tests + env regression + Svelte check + dark/light WebView |
| Session Status | `kode-core::session::BusyHeuristic` + `Session`; consumed through `session.status` by `sessions.ts` | This contract | starting / busy / idle / exited | kode-core unit tests + GUI session cancel flow |

## Component behavior

| Component | Default | Hover | Focus | Active | Disabled | Busy | Error |
|---|---|---|---|---|---|---|---|
| Button | Labeled intent | Tone/border strengthens | 2px accent ring | Small press | Muted, inert cursor | Stable size, duplicate blocked | Inline recovery or shared toast |
| Icon button | Accessible name | Surface appears | Accent ring | Small press | Muted, inert | Stable geometry | n/a |
| Input | Owned label, bordered surface | Border strengthens | Semantic border + ring | n/a | Muted, inert | Preserves value | Associated inline text |
| Textarea | `resize: none`, adequate height | Border strengthens | Accent border + ring | n/a | Muted, inert | Preserves value | Associated inline text |
| Data list | Content-first row | Quiet surface | Visible ring | n/a | n/a | Stable frame/progress | Persistent scoped recovery |
| Session switcher row | Quiet ledger surface; only authoritative `busy` adds a working dot to the avatar, while every other runtime status has no dot or visible label | Border and surface strengthen | Visible inset ring | One outer current-state treatment | n/a | Session status changes do not move metadata | Attention, unread, and error remain separate from runtime status |
| Mobile session unread badge | Hidden at zero; counts non-user message events received outside the viewed session | n/a | Count is included in row semantics | Opening the session clears its count | n/a | Stable 20px height; values above 99 render as `99+` | Exited sessions discard stale counts |
| Mobile session header | Frame-filling backend artwork, title, and exact working path in one compact AppBar; only `busy` adds an avatar corner dot, while provider text, numeric IDs, and status copy stay hidden | n/a | Long model/workspace values available by touch/focus tooltip | Permission mode remains a separate compact control | n/a | Geometry remains stable while metadata and status arrive | Missing metadata is omitted without placeholder noise |
| Mobile transcript message | One role bubble plus external identity marker | n/a | Selectable message content | Long-press text selection | n/a | Optimistic user bubble keeps stable geometry across `SENT` / `PROCESSED` | Failed outbound bubble preserves text with Retry/Discard; rendering fallback stays readable |
| Selection checkbox | Unchecked box | Accent border | Accent ring | Press feedback | Muted, inert | Parent list blocks changes | n/a |

## Dataset navigation

- Memory review queue: Render all because the pending queue is intentionally bounded by agent energy budgets; the list owns internal scrolling.
- Approved-memory browse: Existing search/recent behavior remains canonical for that screen.
- URL state: Not applicable to Tauri modal drawers; transient review and selection state stays in component memory.
- Empty/no-results/error/loading treatment: Empty queue, unavailable source, partial source failure, loading, busy, partial mutation failure, and completion remain visually distinct without changing the drawer footprint.
- Back/scroll restoration: Closing the drawer returns to the unchanged app context.
- Selection scope: Checkboxes select visible pending proposals across loaded local and remote sources. Each checkbox is integrated into its record surface; a quiet checked wash denotes batch membership, while a separate info-toned outline denotes the current detail row. The header control exposes checked/unchecked/indeterminate states and exact count. Selection is independent from the current detail row. Compact rows retain kind, author, source, scope, timestamp, a two-line body preview, subsystem, all tags, confidence, and energy; only spacing changes. Rows keep content-driven height and the list owns overflow, so no metadata is lost through flex shrinking or clipping. Refresh preserves only still-live keys. Bulk actions require an inline exact-count confirmation; successful rows leave the queue, failed rows remain selected, and focus moves to a surviving row.

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| Review one | Approve / reject / edit then approve / blacklist | Actions disabled | Same drawer, item removed | Shared toast | Item remains; error toast | Next user-selected context | memory design §3.1 |
| Review selected | Approve selected / reject selected | Determinate dock progress; duplicate blocked | Same drawer, successful items removed | Inline result + shared toast | Failed items remain checked with exact counts | First failed or surviving row | memory design §3.1 and project memory decision |
| Refresh queue | Backend pending event | Stable list loading behavior | Same drawer | Updated count/list | Per-source inline error | Existing live detail/selection retained | memory design §7 |
| Cancel/back | Escape / close | None | Underlying app | None | Nested decision/edit mode closes first | Originating application context | established drawer behavior |
| Capture screenshot | Global shortcut or Capture settings action | Duplicate capture blocked while the current window or complete display under the pointer is captured; captured image opens full-screen on that display | Same application context after confirming or cancelling the editor | Area mode captures the complete display under the pointer first. User may draw a new region, drag the selection border/handles, or use arrow keys; Confirm and copy places only that region on the system clipboard and shows a success toast | Editor cancellation is silent; capture, crop, fullscreen transition, or clipboard failure uses an error toast and keeps recoverable state | Crop selection receives focus; closing restores the prior window display, size, maximized/fullscreen state, and application focus | screenshot platform contract |
| Create mobile binding | Create pairing code | Stable busy button; prior code replaced | Same dialog with QR | Inline one-time code and expiry | Server URL/error remains inline; retry creates a new code | Server URL or QR decision surface | cloud sync protocol §Credentials and pairing |
| Deploy sync backend | Deploy and create QR code | Pessimistic named-stage rail; dialog cannot dismiss during work | Same dialog, active backend QR | QR and connected backend identity | Exact failed stage remains visible; user corrects SSH/ingress and retries the idempotent deployment | Failed field or deployment action | cloud sync protocol §Deployment |
| Switch sync backend | Saved backend selector | Stable switching state; prior QR cleared | Same dialog, new backend QR | Active backend name and URL | Previous backend credentials remain stored; failed switch keeps selector and inline recovery | Backend selector | cloud sync protocol §Multiple deployment backends |
| Claim mobile binding | Scan QR / claim manual code | Scanner/form blocks duplicate claim | Session list | Bound desktop name and live connection | Expired/used/invalid/network errors preserve manual fields | Session list | cloud sync protocol §Credentials and pairing |
| Send session message | Send from session composer | Optimistic user bubble appears immediately as `SENT`; input clears, keyboard dismisses, and request submits while working | Same session | Matching canonical CLI user message morphs that bubble to `PROCESSED` | Failed/expired request changes the same bubble to `NOT SENT` with Retry/Discard | Transcript tail; composer remains dismissed | cloud sync protocol §Mobile compatibility API |
| Dictate session message | Tap microphone for default Mandarin; long-press it to switch Mandarin/English; tap again to stop | Microphone marker and inline rail name the selected locale, which is locked while listening; partial transcript remains editable | Same composer | Final transcript remains editable; explicit Send is still required | Missing requested locale or permission/recognition error stays inline and can be dismissed/retried | Microphone control | speech_to_text platform contract |
| Revoke mobile binding | Unpair | Pessimistic server revoke, then local credential removal | Pair screen | Binding removed | Local credential is removed even if server is unreachable; server-side revocation failure is logged for recovery | Pair screen | cloud sync protocol §Credentials and pairing |

## Navigation and responsive behavior

- Route document title policy: The Tauri window uses the product title; modal drawers do not create routes.
- Route error / 403 page behavior: Not applicable to this local desktop drawer; source availability is reported inline.
- Breadcrumb/tab/route-state policy: Not applicable to memory review.
- Sidebar/drawer/bottom-sheet transformation: Memory review is a right-side modal drawer on desktop and fills the narrow viewport without hiding actions.
- Responsive table strategy: Memory proposals are independent stacked records; detail remains adjacent where width permits.
- Truncation/full-value access: Preview rows may clamp to two lines; selecting the row exposes the complete body in detail.
- Focus restoration and sticky-obstruction policy: Decision dock is outside the list scroller and never covers rows; focus moves to surviving content after batch mutation.
- Mobile session hierarchy: One compact AppBar owns navigation, backend artwork, session title, exact working path, textual live status, permission mode, and a 28px metadata rail for model, tokens, and context. Backend names and internal numeric session IDs are not repeated visibly. The grouped list header owns the full workspace path; each session row keeps title, status, model, tokens, context, and attention without redundant provider text. There is no separate overview card. The transcript remains the sole vertical scroll owner, and the composer plus its bounded voice/queue rails stay outside that scroller.
- Cloud relay dialog: an existing active backend opens directly on a fresh one-time QR. With no saved backend, the dialog opens on SSH deployment. Backend switching stays inside the dialog and does not create a separate route.
- Mobile transcript identity: Assistant messages display the current session backend icon and name; unavailable artwork falls back to a monogram. User and system messages use semantic role glyphs. Desktop-only custom avatar IDs are not implied to exist in the mobile protocol.
- Mobile transcript Markdown: Display normalization may flatten known transport sentinels such as approval/transcript boundaries, but must not mutate stored event text, fenced examples, ordinary quotations, or authored nested blockquotes. Blockquotes use a flat rail rather than layered card surfaces.

## Overlays and feedback

- Dialog primitive: App-owned Svelte dialog/drawer; no browser dialog APIs.
- Destructive confirmation levels: Bulk decisions, rejection, and blacklist name the count, verb, and consequence. Safe cancellation is always available.
- Toast placement/duration/deduplication: Shared bottom-right `ToastHost`, polite live region, maximum three items.
- Alert/banner scope and persistence: Source and partial-failure issues remain within the memory drawer until resolved or dismissed.
- Tooltip delay/dismissal: Native title is acceptable only for supplemental technical metadata; essential instructions remain visible.
- Unsaved-changes behavior: Edit mode cancels before the drawer closes on Escape.
- Layer/z-index contract: Modal drawers above application chrome; shared toast remains readable above ordinary content without replacing inline recovery.

## Async and resilience

- Mutation default: Pessimistic per item; success is committed to UI only after each IPC acknowledgement.
- Mobile message delivery remains online-only and server-dispatched. Composer commit inserts an optimistic user message labeled `SENT` and calls `POST /input` immediately regardless of session working state. The matching canonical CLI `message(role=user)` event—not `command.status=executed` or `session.status=idle`—moves that same semantic message to `PROCESSED`. `failed`, `expired`, and `409 desktop offline` replace the optimistic label with `NOT SENT` and keep explicit Retry/Discard on the bubble.
- Mobile voice input initializes only after an explicit microphone tap. The microphone defaults to Mandarin (`zh-CN`, with a platform-provided Mandarin fallback); long press switches between Mandarin and English (`en-US`, with a platform-provided English fallback), and a compact marker exposes the current choice without a separate composer button. The language is locked while listening. Speech recognition may use platform services; its partial/final transcript remains editable and is never auto-submitted. The microphone and speech usage strings must describe this purpose before the OS permission prompt.
- Mobile composer commit always dismisses the software keyboard immediately, whether the backend executes the message now or queues it behind current work.
- Mobile working state is derived only from authoritative `session.status`: `busy` shows the avatar corner dot; starting, idle, and exited show no runtime-status indicator or copy. Message timing must never invent working presence.
- Pairing is pessimistic and single-use. Session upload stays disabled until the center confirms at least one active binding.
- Pairing status polling never overwrites a server URL while the user is editing it; the saved URL is restored only when the field has no uncommitted edit.
- SSH deployment is pessimistic and stage-based. It may retry health reads, but it never repeats upload/start/save after an uncertain external-side-effect failure without an explicit user retry. Redeploying the same SSH host or public URL updates one saved backend and preserves that backend's mobile credentials.
- Each sync backend owns separate device credentials and command receipts. Switching generations closes the prior agent loop before the new backend starts; credentials are never copied across origins.
- Idempotency and duplicate-submit policy: One `busy` owner blocks repeated single and batch review.
- Offline/read-stale/write behavior: Each local/remote source fails independently; healthy sources remain usable.
- Retry/backoff/timeout behavior: A later pending event or reopen triggers refresh; automatic duplicate mutation is forbidden.
- Long-running progress: Batch processing exposes true completed/total values.
- Stale-request cancellation/invalidation: Pending events queue one refresh during mutation and reconcile afterward.
- Dialog/form preservation and retry after mutation failure: Failed batch items remain checked; the shared reason remains a single submitted value for the batch attempt.
- Terminal cancel status: A bare Escape sent to the PTY releases the local turn hold. Continuing PTY output may keep the session busy, but a backend that returns to its composer without emitting `task_complete`, `turn_aborted`, or `Stop` must settle to idle after the normal PTY activity threshold. Cancel does not emit a false completion notification.

## Validation

- Schema/validation layer: Rust/domain validation remains authoritative; Svelte owns immediate input constraints.
- Trigger timing: Review inputs validate on explicit commit.
- Error summary/inline policy: Batch partial failure remains inline with exact succeeded/failed counts; non-actionable acknowledgement may use toast.
- Sensitive-value handling: Memory proposal content is not treated as a secret input; raw secrets must not be placed in memory by domain policy.
- Cloud deployment uses the user's existing non-interactive SSH configuration and never collects or stores an SSH password/private key. Device bearer tokens remain in the mode-0600 cloud config and never appear in the pairing UI.
- Duplicate-submit prevention and recovery: Busy state blocks repeat activation while preserving visible geometry and surviving selections.

## Verification

- Required static commands: `pnpm check`, `pnpm build`, `cargo test -p kode-gui`, `cargo test -p kode-sync-server`, `designmd lint`.
- Browser/device/locale/theme matrix: Dark/light; English/Chinese; desktop and narrow drawer; reduced motion and forced colors where available.
- Accessibility checks: Keyboard selection, indeterminate header state, focus-visible, exact accessible labels, live progress/result, and post-mutation focus.
- Canonical sibling flow used for comparison: `MemoryBrowsePanel.svelte` drawer layout and shared `ToastHost` feedback.
- CRUD full-flow evidence: Memory review interaction tests and manual local/remote review flow.
- Failure-path evidence: Partial-source and partial-batch failure states in `MemoryPanel.svelte`.
