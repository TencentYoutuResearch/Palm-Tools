# Pinned native text composer extension

extension.js is the reviewed adapter used by the production @kode/dsh-composer
package. scripts/build-composer.js verifies the upstream version and source SHA-256
and the extension SHA-256 recorded in packages/composer/upstream-lock.json, then
extracts and tree-shakes an independent client module. It exports PortableTextComposer, portableComposerCapabilities and an inert Cordis
apply entry. DSH activates every client graph row; apply registers no services or
Conversation.
No installed dependency, global package, or daily service is modified.

The adapter uses the native DraftEditorRuntime, DraftEditor, registerComposerKeymap
and InputBar CSS. The caller retains scope-keyed durable drafts, request IDs,
authorization and exact receipt validation. It does not create Sessions, upload
files, use microphones, or request models or permissions.

portable-composer.d.ts documents the contract and is copied to the package at build.
The legacy build.mjs/conversation-portable.js are historical isolated proposal
fixtures only, not the production route. Production and normal rendering tests load
@kode/dsh-composer directly; no KODE_TEST_CONVERSATION_BUNDLE override is required.

The browser exports an inert `apply` entry as required by real ClientEntries.start /
Cordis activation, separately from the no-op host entry. Importing the component
does not activate Conversation or create a Session.

## composer-root-ownership.patch (production)

Applied by `scripts/build-conversation.js` to produce `@kode/dsh-conversation`, which replaces
Cordis entry `ui-conversation`. Guards the composer editor root and file-picker seat so an
occurrence only releases what it still owns and hands it to the newest remaining occurrence.
Locked in `packages/conversation/upstream-lock.json`; see `packages/conversation/README.md`.
