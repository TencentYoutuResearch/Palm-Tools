# Native DSH text composer

This independent client module reuses the pinned DSH 0.2.1-rc.5 DraftEditorRuntime,
DraftEditor, registerComposerKeymap, and InputBar CSS. It does not replace the
Conversation plugin or manufacture Sessions. The host entry is intentionally inert.

Production clients import `PortableTextComposer` and `portableComposerCapabilities`
from `@kode/dsh-composer` through the DSH module loader. Cordis loads the client via
`kode-composer`; collaboration declares it as a client injection dependency.

`npm run build:composer` verifies the upstream package version and client SHA-256,
plus the reviewed extension SHA-256, before producing client.js. `build:collab` runs
this build first, and `build:bundle` already runs `build:collab` and bundles local
packages. No installed or global package is modified. Upstream license is preserved.
Rebasing requires reviewing both sources and explicitly updating upstream-lock.json.

The controlled, scope-keyed contract is in client.d.ts. The caller owns durable
storage, request IDs, authorization, receipts and resetting accepted drafts. A
synchronous submit lock blocks repeated gestures until the promise settles.
Failures retain the editor and show a retry message. maxLength defaults to and is
capped at 65536 UTF-16 units; an oversized edit is rejected in full and the prior accepted draft is restored
without truncation or persistence. A preloaded oversized value remains intact,
with an explicit unsaved warning and sending disabled until shortened. IME, Shift+Enter,
Enter/repeat filtering, plain-text paste and history use the native implementation.
Attachments and voice are unsupported, and file paste/drop is rejected locally.

No stylesheet is maintained in parallel: native CSS modules remain in the pinned
source transform and use their original deduplicated style identities/tokens.

The browser exports an inert `apply` entry as required by real ClientEntries.start /
Cordis activation, separately from the no-op host entry. Importing the component
does not activate Conversation or create a Session.
