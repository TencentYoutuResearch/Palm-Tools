---
version: alpha
name: "kode"
description: "A quiet, high-trust desktop workbench for supervising AI coding sessions and shared memory."
colors:
  primary: "#9FE870"
  accent: "#9FE870"
  background: "#0D0F0E"
  sidebar: "#111413"
  surface: "#181B19"
  input: "#0A0C0B"
  text: "#EDEFEB"
  text-secondary: "#A8AEA7"
  border: "#262B28"
  success: "#9FE870"
  warning: "#E6B450"
  danger: "#FF6B6B"
  info: "#8FD3FF"
typography:
  sans:
    fontFamily: "Avenir Next, SF Pro Text, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
  mono:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Menlo, monospace"
rounded:
  DEFAULT: "0.375rem"
  sm: "0.25rem"
  md: "0.375rem"
  lg: "0.75rem"
  xl: "1rem"
spacing:
  base: "0.25rem"
  control-gap: "0.5rem"
  panel-padding: "0.75rem"
components:
  button:
    rounded: "0.375rem"
  panel:
    rounded: "0.75rem"
  dialog:
    rounded: "1rem"
  checkbox:
    rounded: "0.3125rem"
---

# kode Design System

## Overview

### Creative North Star

kode should feel like a compact operations desk built around a terminal: calm instruments, exact status, and deliberate commit controls. The interface is not a generic SaaS dashboard; it is a native-feeling macOS workbench where attention stays on sessions, code, and decisions.

### Product context and register

- **Audience and primary job:** Developers supervising several AI CLI sessions, reviewing shared memory, and inspecting project state without losing terminal context.
- **Target market and evidence:** Global developer tooling. The repository supports English and Simplified Chinese; no market-specific business behavior is inferred from locale.
- **Locales and language policy:** `en` and `zh-CN` UI strings use the shared i18n package. Owned controls and accessible labels must be localized together.
- **Usage scene:** Desktop-first, macOS-prioritized, repeated expert use, keyboard-heavy, and information dense.
- **Register:** Product. Familiarity, speed, and state clarity lead; expressive styling is restrained.
- **Memorable signature:** Selected work is marked like a ledger entry: a precise rail or check state paired with a persistent decision surface. This is used for consequential review flows, not as decoration on every card.
- **Restraint:** Terminal, forms, tables, and review copy remain flat, compact, and readable. Motion communicates entry, progress, or changed state only.
- **Anti-references:** Avoid generic metric-card dashboards, gamer-terminal neon, heavy glassmorphism, soft pastel consumer UI, and oversized marketing typography.
- **Token ownership/runtime mapping:** This file mirrors the established runtime source of truth in `apps/gui/index.html`. Components consume its CSS variables; this document does not generate code. `pnpm check` and production build are the drift gates.

## Colors

Dark mode is canonical and uses near-black green-neutral surfaces with one crisp green accent. Light mode is a functional counterpart defined in `apps/gui/index.html`, not an independent visual identity. Accent means current/committed action; success, warning, danger, and info retain semantic roles and always pair with text or icons. Borders and tonal surfaces establish hierarchy before shadows. Focus uses the accent token and must remain visible in both themes and forced colors.

PTY foreground content preserves each child CLI's native ANSI choices, including CodeBuddy's truecolor green identity. `terminal_settings.ts` owns xterm's background, foreground, cursor, standard palette, and semantic surface slots for dark/light modes. The shared `terminal_ansi_theme.ts` adapter normalizes every standard, bright, low-index, 256-color, truecolor, and reverse-video background into those semantic surface slots so a live or restored CLI cannot retain a light input surface inside a dark terminal (or the inverse) after theme switching. Removed/added slots use muted `#3A2024`/`#173A27` in dark mode and bright `#FF6B6B`/`#71D47D` in light mode; neutral input and selection surfaces use the matching neutral slots. Foreground groups remain atomic and untouched. Kode still passes `TERM_THEME` and `COLORFGBG` when a session starts for the CLI's initial layout, while xterm contrast correction keeps literal foreground colors readable.

## Typography

`Avenir Next` / `SF Pro Text` carries product UI, while the mono stack carries identifiers, paths, timestamps, tokens, and compact numeric status. The scale is intentionally compact (11–18px in runtime tokens). Chinese falls through to the platform UI font; containers must flex or wrap rather than assume Latin character widths. Uppercase is reserved for short technical eyebrows, never body copy.

## Layout

The desktop shell is a bounded workbench with resizable navigation, terminal, and inspector regions. The full session sidebar is a dense 232px ledger: session rows use an explicit 46px border-box footprint and spend their second line on live state, model, and token usage instead of decorative numbering or an ornamental action gutter. Panels own their scroll areas through explicit flex/min-height chains; overlays remain within the visual viewport. Spacing follows the established 4px runtime scale. Dense lists use 40–44px toolbars, readable 48px-or-taller decision rows, stable action areas, and visible scrollbars. Compact density reduces padding and gaps only; it does not remove labels, counts, status, or record metadata. Overflow belongs to the list scroller, so decision rows keep their content-driven height instead of shrinking and clipping. Narrow layouts preserve every action and wrap information before considering truncation.

## Elevation & Depth

Static content is flat by default. Borders and surface tone separate list, detail, and control regions. Shadows are reserved for floating menus, modal drawers, toasts, and decision surfaces that must remain anchored above scrolling content. Modal blur belongs only to the application backdrop.

## Shapes

Controls use 4–6px radii, structural panels use 12px, and major modal surfaces may use 16px. Pills are limited to counts, source labels, and compact status. Icons follow the shared Lucide-style monoline geometry and never substitute for consequential action labels.

## Components

### Foundational visual states

Every interactive control defines default, hover, focus-visible, active, disabled, and busy states. Selected/current and checked-for-bulk are separate states: current controls the detail view; checked controls the batch set. Loading and progress reserve geometry, errors remain recoverable, and forced-colors keeps borders and focus visible.

### Buttons and actions

Buttons combine emphasis with intent. Safe primary commits may be solid accent/success; routine utilities are outline or ghost; danger remains separated and gains high emphasis only at final confirmation. Labels name the real verb and keep their dimensions while busy.

### Navigation and data display

Lists privilege readable content over metadata. Main-session tabs and review records share a quiet ledger-row surface, compact gaps, and one outer current-state treatment instead of floating content on an empty column. Full session rows omit visible sequence markers and separate lifecycle text/dots; `Running`, `Idle`, and equivalent status words stay in the tab's accessible label. Avatar corner dots are reserved for active work, attention, or failure—idle avatars remain clean in both full and compact modes. The current session adds an accent rail while attention remains a compact badge. In compact mode, the outer tab tile alone owns the current-state frame—the avatar remains unframed and the tile does not gain a second glow or elevation layer. Memory-review checkboxes sit inside each record surface: checked rows use a quiet accent wash, while the record shown in detail uses a separate info-toned outline. Secondary source, scope, confidence, and energy data use compact mono labels; confidence and energy never become full-width decorative meters. Bulk selection uses a shared checkbox visual, an exact count, and a persistent decision dock; it never overloads the row-current highlight.

Mobile session identity stays continuous from the session list into the detail header and assistant messages. Backend artwork carries the visible provider identity, so list rows and the detail header do not repeat a backend name or expose internal numeric session IDs. Backend artwork fills its avatar frame with only a narrow protective inset. The compact detail AppBar pairs artwork and title with the exact working path; a 28px instrument rail directly below retains model, token usage, and context pressure without a separate overview card. The grouped session list lets its folder header own the exact workspace path, while each compact row preserves title, model, tokens, context, attention state, and unread count. Runtime status has one visible expression: only authoritative `busy`/working adds a small corner dot to the backend avatar; starting, idle, and exited show neither a dot nor status copy, and no separate transcript activity row is rendered. Transcripts use one role surface per message, paired with a compact identity marker outside the bubble and a quiet timestamp in the message eyebrow. Assistant identity comes from the actual session backend and reuses the desktop backend artwork with a readable monogram fallback; user and system roles use stable semantic glyphs. The composer uses a flat bordered input between equally grounded microphone and commit controls, not floating circular actions. Voice input is short-form dictation: the microphone defaults to Mandarin, carries a compact `中/EN` language marker, and switches language on long press without consuming a separate composer slot; listening has a slim live rail that names the locked language, partial transcription stays editable, and only an explicit commit sends it. A working agent does not block submission: the user message appears immediately in the transcript with a quiet `SENT` receipt in its eyebrow, then becomes `PROCESSED` in place when the canonical CLI user-message event syncs back. Delivery failure stays on that same bubble with Retry and Discard instead of moving into a separate receipt rail. Transport protocol sentinels are rendered as plain technical labels rather than Markdown quote depth. Authored blockquotes remain flat, with a single slim rail and no nested rounded-card treatment.

Mobile session rows show a compact unread-message count for assistant messages received outside the currently viewed session. Opening the session marks those messages read; counts above 99 use the stable `99+` label. Attention remains a separate semantic badge because it represents required action rather than unread volume.

### Forms and overlays

Fields use owned labels, dark input surfaces, border focus plus a soft ring, and inline recovery. Drawers and dialogs use application-owned surfaces, Escape behavior, and stable actions. Toasts use the shared `ToastHost`; actionable failures also remain inline.

Cloud relay setup is treated as an operational handoff, not a generic account wizard. A flat backend identity bar owns the active destination; an exact vertical deployment rail reports upload, install, local health, public health, and save stages. The QR code is the only high-contrast visual block. Existing deployments open directly on that QR surface, while deployment and backend switching remain explicit secondary actions.

### Iconography

Use `Icon.svelte`, based on Lucide names and rounded monoline strokes. Common sizes are 12–16px. Backend identity uses the canonical artwork in `apps/gui/public/backend-icons`; mobile and desktop must share that set rather than invent separate logos. Unknown backends fall back to a short monogram. Icon-only controls require a localized accessible name and a tooltip when the meaning is not universal.

### Motion

Routine feedback uses 120–180ms transitions with the existing cubic-bezier tokens. One coordinated drawer entrance is preferable to scattered animation. All non-essential motion is removed under `prefers-reduced-motion`.

### Content and data visualization

Copy is direct and operational: “Approve selected,” “Reject selected,” and exact counts. Feedback repeats the action verb and distinguishes success from partial failure. Technical values preserve exact casing and use mono typography.

## Do's and Don'ts

- **Do:** Keep the terminal and review content visually dominant over chrome.
- **Do:** Separate current-row focus, batch selection, semantic intent, and async status.
- **Don't:** Add screen-local colors, toasts, checkbox treatments, or scrollbar themes when a canonical owner exists.
- **Don't:** Use glow, gradients, or pills as generic decoration; every emphasized surface must encode state or ownership.
