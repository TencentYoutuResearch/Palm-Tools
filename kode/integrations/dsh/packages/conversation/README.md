# Pinned native Conversation with composer ownership fix

`@kode/dsh-conversation` is the MIT dsh `ui-conversation` client at **0.2.1-rc.5**, plus
one reviewed patch: `patches/dsh-conversation-0.2.1-rc.5/composer-root-ownership.patch`.
It is not a new composer or chat surface. Every native service, slot, locale namespace
and behaviour is unchanged except the three per-view seats below.

## What the patch changes

One Session shell owns one Lexical editor and one file-picker seat; every mounted composer
occurrence of that Session (Orbit planning embed, right-Sidebar Conversation, session mode)
binds to them.

- `ComposerContentEditable`: upstream cleanup called `editor.setRootElement(null)`
  unconditionally, so any occurrence unmounting detached whichever occurrence currently held
  the root. Now occurrences are tracked per editor in mount order; only the current root's
  owner moves the root, handing it to the newest still-mounted occurrence with that
  occurrence's own editability. A covered occurrence's editability no longer overrides the root.
- `registerComposerKeymap` / `installDraftKeymap`: every view registers Enter, paste, Space, Escape,
  Tab and arrows on the shared editor at the same priority, and Lexical stops at the first handler that
  answers, so the oldest view (with its own locked/upload gate and Toast) answered for the root owner.
  Now a view's handlers pass unless its own scrollport contains the editor root.
- `SessionInputShell.bindFilePicker`: upstream unbinding the current picker left none bound.
  Now pickers are kept in bind order and the action returns to the newest still-bound view.

No backend, permission, upload, model or send path is touched; nothing sends automatically.

## Build / install

- `npm run build:conversation` verifies the upstream package name, version, `lib/client.js`
  SHA-256 and the patch SHA-256 against `upstream-lock.json`, applies the patch with
  `git apply --check` in a scratch directory and writes `client.js`. Any mismatch fails closed
  and writes nothing. The installed upstream package is never modified.
- `npm run build:bundle` runs it before packing. `cordis.patch.yml` replaces loader entry
  **ui-conversation** (as with ui-chat / ui-sidebar); never load the original and the override together.
- The upstream hash equals `patches/dsh-conversation-0.2.1-rc.5/upstream.sha256`, the same audited
  upstream the `@kode/dsh-composer` adapter extracts from.

## Tests

- `test/conversation-extension-build.test.js`: deterministic build, fail-closed on altered
  upstream hash, version or patch, Cordis replacement, manifest/bundle wiring.
- `test/orbit-planning-embed-browser.test.js`: real Chrome over the released client Session stack
  loading this patched build (through the same build function). Covers Orbit first → same-Session
  right Sidebar → leaving Orbit (Sidebar keeps the root, types, and its native 文件 action opens its
  own file input), Enter/paste/pending-upload notice answered once by the root owner only
  (Session submit replaced by a recorder; nothing is sent), the reverse order, root/file-action hand-back without remount, and no send.
  Reverting the root, picker or keymap hunk makes that test fail.

## Rollback

Remove the `ui-conversation` entry from `cordis.patch.yml` (stock `@deepseek-ai/dsh-client-ui-conversation`
loads again) or reinstall the previous Kode bundle; reload the profile. No session, draft or
configuration data changes.

## Upgrading upstream

Rebase the patch on the new upstream `lib/client.js`, review, and update both hashes in
`upstream-lock.json` intentionally. Drop the override once upstream ships an equivalent guard.
