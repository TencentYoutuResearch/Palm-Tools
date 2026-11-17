# Pinned native right Sidebar with panel host scopes

`@kode/dsh-sidebar-right` is the MIT dsh `ui-sidebar-right` client at **0.2.1-rc.5**, plus
one reviewed patch: `patches/dsh-sidebar-right-0.2.1-rc.5/panel-host-scope.patch`.
It is not a second sidebar. The tab registry, resources, tab strip, drag, close, split,
fullscreen, layout store and every Session behaviour are the upstream code, unchanged.

## What the patch changes

Upstream shows a right Sidebar only for the selected Session, and only while no main panel is
active. The patch adds one public entry so a main panel can own a surface for a **real resource
scope** of its own:

- `sidebarRight.registerHost(panelId, { scope, seed })` → `{ openTab, openResource, dispose }`.
  `scope` is a `{ subscribe, getSnapshot }` source of a scope string (Orbit: `team/<home>/<team_id>`
  or `draft/<home>/<draft_id>`); `seed` is the first page kind. Commands throw when the panel has
  no current scope; nothing invents one.
- The surface key is `host:<panelId>/<scope>`, so it can never equal a Session id and two scopes
  never share tabs. Its layout is persisted by the same native store (a local UI preference).
- A host surface is shown only while its own panel is active; with no active panel the selected
  Session's surface is shown exactly as upstream.
- Host tabs render through the root-scoped seats `sidebar.right.host.tab`,
  `sidebar.right.host.tab.title` and `sidebar.right.host.tab.menu.item`. A host surface has no
  guide/add-tab entry and retains no Session by itself; a tab that shows a Session retains it
  through its own resource (Orbit: `dsh-resource://kode-collab-session/session/<id>`, the
  SidebarChatTab pattern) and releases it when the tab closes.

No backend, permission, Session, message or model path is touched; nothing sends automatically.

## Build / install

- `npm run build:sidebar-right` verifies the upstream package name, version, `lib/client.js`
  SHA-256 and the patch SHA-256 against `upstream-lock.json`, applies the patch in a scratch
  directory and writes `client.js`. Any mismatch fails closed and writes nothing. The installed
  upstream package is never modified.
- `npm run build:bundle` runs it before packing. `cordis.patch.yml` replaces loader entry
  **ui-sidebar-right**; never load the original and the override together.

## Tests

- `test/sidebar-right-extension-build.test.js`: deterministic build, fail-closed on altered
  upstream hash, version or patch, Cordis replacement, manifest/bundle wiring.
- `test/orbit-team-sidebar-browser.test.js`: real Chrome over the released client Session stack
  loading this patched build (through the same build function): messages, settings and Session
  tabs per team scope, writer yield, retain/release, no session mode, no send.

## Rollback

Remove the `ui-sidebar-right` entry from `cordis.patch.yml` (stock package loads again; Orbit
keeps its in-place views) or reinstall the previous Kode bundle; reload the profile.

## Upgrading upstream

Rebase the patch on the new upstream `lib/client.js`, review, and update both hashes in
`upstream-lock.json` intentionally.
