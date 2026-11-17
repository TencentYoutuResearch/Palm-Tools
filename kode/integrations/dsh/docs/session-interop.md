# Local session interoperability

`kode_sessions_list` includes `execution_state`: `waiting`, `running`, `completed`,
`not_started`, `interrupted`, `failed`, or `unknown`. Presence is separate from
execution. Stale (over 15 seconds), offline, older-client and unobserved remote
states are `unknown`, not successful completion.

## Local settings

Use the collaboration settings panel. Settings are stored only on the executing
Host in `~/.config/kode/session-interop.json`; `sessionInteropFile` in the Kode
Host plugin config can select another local file. They are not stored in Hub
shared documents or replicated to SSH Hosts. No personal model default is baked
into source. Choose an isolated Codex profile and its allowed model. For example,
users can select their existing tcodex profile and hy4 model if that profile
advertises/configures it. Ordinary login-only Codex profiles without managed
inference are not eligible; credentials are never copied to enable them.

Configuration shape:

```json
{"summary":{"profile_id":"local-summary","model":"configured-model"},"grants":[{"source":"caller-session","target":"target-session","actions":["summary"]}]}
```

`summary: null` disables summaries. `grants: []` permits only self access.
Cross-session grants must name exact local session IDs and actions `summary`
and/or `model` (or `direct_insert`, described below). Listing a session does not grant transcript or model access.
Managed workflow sessions remain excluded. The model action changes selection,
not merely reads metadata. Owner settings disclose that visible user/assistant
text is sent to the chosen model service; tool records and hidden system records
are excluded, but visible text is not guaranteed to be free of sensitive data.

## API and agent tools

Owner-authenticated GET `/api/kode/session-interop` returns settings plus eligible
profiles. POST actions:

- `configure`: `settings` replaces the complete local summary/grants settings.
- `summary`: `session_id`, `system_prompt` (up to 16000 bytes).
- `model`: `session_id`, `model`, optional `reasoningEffort`.

For summary/model, a same-Hub session bearer credential can authenticate instead
of the owner session. It cannot read or edit settings. Caller identity is derived
from Hub `/self`, never request JSON. Messaging enablement and grants are checked
again before inference/model mutation. Native agents receive
`kode_sessions_summary` and `kode_sessions_set_model`; omit `session_id` to
operate on themselves. Third-party stdio MCP users can opt in with
`KODE_SESSION_INTEROP_URL=http://127.0.0.1:<host-port>` in addition to the existing
session credential and Hub settings. Only a loopback HTTP origin is accepted;
redirects are rejected. This targets the local Host, not arbitrary SSH sessions.

Summary inference runs a fresh isolated, tool-free managed Codex decision with
no target-session prompt mutation. It uses a bounded recent visible transcript
(128000 bytes) and returns `truncated`, `snapshot_seq`, and `snapshot_only`.
A snapshot can be older than a running session by the time the result arrives.
The caller's system prompt controls summarization, not target-session execution.
The response reports usage evidence where available; requested model identity
is not proof of upstream model weights. Output is limited to 128000 bytes.

Model switching validates the profile's allowed model/effort catalog and rejects
running sessions, queued input, or configuration changes during discovery.
Success reports `effective: next_turn`, `verification: requested`; it does not
claim a completed inference or modify an in-flight call.

## Verification

Focused tests cover state evidence/freshness, explicit grants and caller identity,
owner-only settings, model-catalog and busy/race guards, snapshot filtering, and
isolated no-tool summary fixtures. Live provider inference and installed-client
MCP transport require separate opt-in validation; fixture passes do not prove
those integrations work on a particular user's configured account.

The offline MCP transport suite runs the actual stdio bridge against isolated
loopback HTTP fixtures with fabricated credentials/data. It verifies summary and
model requests, direct-insertion flags, unsupported-capability rejection, denied
access, redirect refusal, and cancellation propagation. HTTP client disconnects
abort pending summary work; authorization is checked again after output reads.
This suite neither starts a persisted Kode service nor calls a real provider.

## Interrupt and insert versus queue

`kode_sessions_send` and the messages API accept optional boolean `direct_insert`
(“是否直接插入”). Omitted/false preserves normal durable FIFO queuing. True requests
an actual current-turn interruption, then places the new input before existing
queued inputs. It is not native steering and never silently falls back to queue.
The original queued inputs are retained and resume after the inserted turn.

The directory exposes `direct_insert_supported`. A true request requires fresh
local dsh native-runtime support and an exact local grant with action
`direct_insert` for a different source/target. Ordinary messaging, summary or
model grants do not authorize interrupting another session. Remote SSH, legacy
Hosts, GUI/PTY/external runtimes and managed workflow sessions reject this mode.
Owner settings can explicitly enable the grant. The target rechecks authorization
before stopping and before inserting.

The flag is persisted with the message and part of its idempotency identity:
changing it while reusing a key is a conflict. A retry of the same key returns the
original message and does not interrupt again. Native event records track
prepared, stop_requested, stop_confirmed, inserted or uncertain stages. Only a
fresh successful process-group stop permits replacement input after a running
turn. Stop timeout, failed persistence or ambiguous outcomes park/fence the
session for owner reconciliation; no replacement input is replayed automatically.
A rejected request means no insertion was admitted; uncertain can include an
already requested stop. Existing delivery evidence still distinguishes queued
from consumed, and neither proves task completion.

Cancellation retains existing semantics: removing a queued input is distinct
from requesting a stop of a currently executing input. A cancellation during an
unconfirmed interruption can remain `cancel_unconfirmed`; never interpret that
as successful withdrawal or retry the original input under a new key.
