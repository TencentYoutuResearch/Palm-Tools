# dsh history and model compatibility audit

Audit date: 2026-11-03. Scope: the pinned dsh 0.2.1-rc.2 integration in PR #19.

## Required behavior

- Exact model resolution probes the requested ACP model, rather than interpreting
  another model's missing effort metadata as lack of support.
- UI selection and runtime validation use the same advertised reasoning options.
  Unsupported explicit choices fail before the durable selection is changed.
- Switching models clears incompatible effort values. Cold restoration retains
  saved model ownership and does not inherit unrelated global effort defaults.
- Plugin writers use the released optional-record API. Unknown required events
  remain errors, and each persisted queue prefix retains unique pending IDs.
- Maintenance preserves event identities, full headers and fork boundaries,
  validates with the released reader, obtains the writer lock before applying,
  and backs up both the artifact and projection cache.

## Additional findings and changes

The two offline repair workers used an inherited event count of zero for every
history. This rejected valid forked sessions. Both now derive the cut from the
final inherited end-seed marker and validate the complete V4 artifact before
constructing the Session. Regression fixtures cover both workers on ordinary
and forked histories, including exact header and event preservation, backup,
cache invalidation and idempotence.

Added API checks prevent invalid effort selection from mutating stored state,
verify effort clearing on model switches, and verify that cold native restore
does not acquire a caller's unrelated effort default. A source gate rejects raw
literal plugin-event append calls in production writers.

The integration suite now runs test files serially against its isolated backend.
Native readiness checks allow bounded startup time instead of assuming ACP will
start within one second. The shared registry test explicitly saves its fixture
rather than assuming no earlier test has migrated the registry.

## Validation

Run `KODE_TEST_DSH_NODE_MODULES=<released-node_modules> node scripts/test-integration.js`
from `integrations/dsh`, using Node 24.22+ and the pinned dsh dependencies. The
script builds the Rust backend and creates isolated state and credentials.

Final result: 302 tests, 296 passed, 0 failed, 6 skipped. The skipped cases require
installed native CLI opt-in or the native plugin installer opt-in. Fixture ACP
and Codex execution, native inbox persistence, cold restore, handoff, messaging,
canonical reasoning validation and disk-reader round trips were exercised.

A separate read-only scan validated 133 existing history artifacts through the
released event vocabulary, full V4 relationship/header checks and Session
construction, with the recorded inherited prefix for forks. All passed; no
artifacts changed during their reads. The scan did not rewrite conversation data.

Before this audit, the installed-code probe against real CodeBuddy confirmed
that kimi-k3.1-pro advertises high and accepts its exact runtime validation; no
inference was sent. This audit did not restart the desktop or replay user input.

These checks cover the observed compatibility failures and their adjacent
paths. They do not certify future CLI capability changes or untested releases.
