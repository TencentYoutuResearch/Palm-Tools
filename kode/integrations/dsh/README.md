# kode sessions for dsh

This integration adds **model-callable session communication** to DeepSeek Harness. It uses kode's Rust backend for durable local/SSH routing and dsh's original conversation, tool execution and inbox. The current isolated worktree also implements an opt-in Superagents/IM layer with persistent teams, configurable workflows, budgets and evidence. It has not been installed into the daily environment.

For the current product flow, read the [Superagents/IM usage guide](../../.specops/changes/super-agent-im-collab/usage-guide.md), [upgrade checklist](../../.specops/changes/super-agent-im-collab/upgrade-checklist.md), and [current acceptance status](../../.specops/changes/super-agent-im-collab/acceptance-audit.md). Development notes below include historical checkpoints; they do not supersede the latest acceptance record or establish a full regression pass.

The initial integration targets `@deepseek-ai/dsh@0.2.1-rc.2` and Node >=24.9.0. The plugin is opt-in. Existing kode behavior is unchanged without `KODE_MESSAGING_CONFIG`.

## Components

- `crates/kode-bridge/src/messaging`: SQLite outbox/inbox, session identities, scoped credentials, delivery receipts, peer links, native ACP/PTY adapter.
- `kode-session-server`: standalone communication service; no Tauri and no CLI settings/hook modifications.
- `@kode/dsh`: registers each active dsh session, installs agent-scoped tools, submits incoming messages as separate follow-up turns, flushes persistence before acknowledging acceptance.
- `kode-sessions-mcp`: optional stdio MCP entry for other agents, including kode-managed CLI sessions.

Native CLI adapters drive Codex app-server and Claude/CodeBuddy ACP through the Kode Agent factory, while dsh supplies the conversation shell. Workspace selection and session-message presentation extend dsh UI slots. The bundle enables dsh's existing sandboxed sidebar-browser plugin on Web; files, Git and terminal continue using the shipped dsh implementations. SpecOps rules are outside this integration's scope.

## Shared session and workspace storage

Kode's backend SQLite documents own workspace registrations and native session identities on each execution node. Both frontends use these documents; the GUI's opened-tab snapshot is separate from the durable session catalog. Closing a tab or an unsuccessful CLI resume does not erase its native registration. The GUI aggregates SSH peer catalogs through the authenticated backend link, maps remote sessions to their configured SSH endpoint, and reads canonical workspace titles. A remote session is never resumed as a local process.

Original conversations remain in each CLI's existing history directory. Importing one into dsh keeps that native identity and loads a recent display window: by default at most 80 text messages from the last 8 MiB. The transcript API accepts `limit` and `tail_bytes` overrides within bounded resource limits and reports `history_window`. Large histories are not rejected because of their total file size. Earlier messages and native tool logs remain in the original CLI history, and native resume still uses the original thread.

The workspace storage adapter serializes writes and rebases local field/membership changes onto the latest backend revision before retrying conflicts. Concurrent session attachments retain both memberships. Restoring an old session does not recreate a deleted workspace. The sidebar omits empty projects; the workspace picker retains the complete registered catalog.

For browser access, open the private URL printed by `dsh web` once in each browser. Its token is exchanged for that browser's authentication cookie, then removed from the address. Cookies are scoped to the browser and origin; a clean URL copied from an already authenticated browser does not authorize another browser.

## Run a standalone backend

From the `kode` project directory:

```sh
cargo build -p kode-bridge --bin kode-session-server
openssl rand -hex 32 > /path/to/admin.token
chmod 600 /path/to/admin.token
```

Create a configuration (absolute database path recommended):

```json
{
  "node_id": "laptop",
  "database": "/path/to/messaging.sqlite",
  "peers": []
}
```

```sh
./target/debug/kode-session-server \
  --config /path/to/messaging.json \
  --token-file /path/to/admin.token \
  --bind 127.0.0.1:47870
```

The database is node-specific and exclusively locked. Keep `node_id` stable when restarting. Token files and peer configuration must be user-private.

To add the same service to the **existing kode GUI or headless bridge**, set `KODE_MESSAGING_CONFIG=/path/to/messaging.json` when launching it. The communication API then uses that bridge's existing administrator token, and discovers its native sessions. Do not simultaneously start the standalone service with the same database.

## Install in dsh

### Self-contained platform bundle

Build an npm package that contains the pinned plugin and matching Kode backend:

```sh
npm run build:bundle
```

The generated archive is printed under `dist/`. Install it with one plugin command:

```sh
dsh plugin --profile web add /absolute/path/to/dist/kode-dsh-0.1.0-darwin-arm64.tgz
```

The archive includes the private UI subpackages as bundled dependencies, so pnpm
does not need a source checkout. Other npm dependencies are downloaded during installation.
Start the installed profile with `dsh web --no-open` (or `dsh web` to open a browser).

On first start the plugin creates private state under `~/.config/kode/dsh`, including
the administrator token, backend configuration and owner-token state. The
bundled `kode-session-server` is started only for a loopback HTTP URL. An existing
authenticated backend is reused and left running when the plugin exits; a backend
started by the plugin is stopped on exit. Set
`KODE_DSH_HOME` to move this state, or provide `tokenFile`, `serverConfig`,
`serverCommand`, and `stateFile` explicitly to keep an existing backend setup.
Explicit configuration always takes precedence over automatic provisioning.

### Source checkout

```sh
dsh plugin --profile web add /absolute/path/to/kode/integrations/dsh
```

Configure the installed `kode` row through the profile patch:

```yaml
- id: kode
  config:
    url: http://127.0.0.1:47870
    tokenFile: /path/to/admin.token
    stateFile: /path/to/dsh-owner-tokens.json
```

Alternatively, `KODE_BRIDGE_TOKEN` supplies the administrator token on the Host. It is never sent to the model or a browser. `stateFile` stores per-session owner tokens privately and must survive dsh restarts.

For one-command dsh startup, optionally add:

```yaml
    serverConfig: /path/to/messaging.json
    serverCommand: /absolute/path/to/kode-session-server
```

The plugin starts this executable only when its loopback backend is unavailable. It does not use a shell. It stops only a process it started itself; an existing backend is left running. Authentication errors never trigger a replacement process.

Then start `dsh web`. Open/resume a session and ask the model to use:

| Tool | Behavior |
|---|---|
| `kode_sessions_list` | List local and connected-peer addresses and availability |
| `kode_sessions_create` | Create a helper with a stable creation key and assign its task |
| `kode_sessions_creation_status` | Query a prior creation by its original key and Host without starting work |
| `kode_sessions_send` | Send content using an explicit target and a stable idempotency key |
| `kode_sessions_delivery_status` | Inspect prepared/queued/consumed runtime evidence on the execution Host; not task completion |
| `kode_sessions_read` | Read this session's communication events after a cursor |
| `kode_sessions_wait` | Wait up to 30 seconds for communication events |

If a creation response is lost, query `kode_sessions_creation_status` using the same key and execution Host. `completed` describes session creation only, not task assignment or completion. `uncertain` means creation or submission may have happened; do not create a replacement blindly. `pending` is not proof that no session exists.

A reply is another send with `in_reply_to` set to the original message ID. The backend checks both participants. Delivery acceptance does not mean task completion.

Incoming messages are attributed peer messages in the original dsh conversation. They queue a separate turn and do not answer pending approvals. On a Web Host with the native `sessionController`, the plugin automatically resumes a previously registered dsh session when it has pending messages, prepared/queued runtime deliveries without a cancellation, or requested input cancellations. Consumed deliveries and terminal cancellations alone do not wake a cold session. The probe counts each actionable message once; accepted inputs remain recoverable even after their original transport TTL. Resume still observes native execution fences and never treats a wakeup as permission to replay an external effect. The native controller restores its recorded preset, model selection and persistence ownership; dsh's archive admission still controls whether it runs. Only session IDs already owned in this Host's token state file are eligible, never arbitrary sessions discovered on another Host. Set `resumeInactive: false` to require manual resume; Hosts without the controller retain queued messages until manual resume. The wakeup probe does not claim messages, so a failed resume leaves delivery pending.

## Connect over SSH

Generate a separate random link secret, shared only by the two backend configurations. Do not reuse administrator or agent credentials.

Local configuration:

```json
{
  "node_id": "laptop",
  "database": "/path/to/local.sqlite",
  "peers": [{
    "node_id": "dev-server",
    "link_token": "<replace-with-random-secret-at-least-32-bytes>",
    "ssh": {
      "host": "dev.example",
      "port": 22,
      "remote_port": 47870
    }
  }]
}
```

Remote configuration:

```json
{
  "node_id": "dev-server",
  "database": "/path/to/remote.sqlite",
  "peers": [{
    "node_id": "laptop",
    "link_token": "<same-random-link-secret>"
  }]
}
```

Start a backend on each machine. `dev.example` may be an alias in the user's SSH config. Optional `ssh.config_file` selects an explicit SSH config file. OpenSSH handles keys, known hosts and transport security.

Only the local node initiates `ssh -L` and a full-duplex WebSocket. The remote node sends messages and receipts back over that same connection: no reverse tunnel or inbound laptop port is required. A direct peer may use `url` instead of `ssh`; configure only one initiating side of a link. Multi-hop relay is not implemented.

## Other agents through MCP

MCP needs a session-scoped credential, not the administrator token:

```sh
KODE_MESSAGING_URL=http://127.0.0.1:47870 \
KODE_MESSAGING_TOKEN_FILE=/path/to/session.token \
node /path/to/integrations/dsh/src/mcp.js
```

For a kode-managed native CLI, kode already sets `KODE_SESSION_ID`. An explicitly configured MCP child can bootstrap its scoped credential with `KODE_MESSAGING_ADMIN_TOKEN_FILE=/path/to/bridge-admin.token` instead. Only the Host-side MCP process reads this file; model tools cannot select a source session. This requires the existing GUI/bridge to have messaging enabled. MCP installation into individual CLI settings remains explicit; this service never rewrites those settings.

The server refuses an administrator token as a direct agent credential. Stdio is reserved for MCP JSON-RPC; diagnostics go to stderr.

## Protocol and failure guarantees

The additive API namespace is `/api/v1/messaging`; existing v1 routes and PTY output paths are unchanged.

- `GET node`, `GET self`, `GET sessions`, `POST sessions`.
- `POST sessions/:id/claim`, `heartbeat`, `offline`.
- `POST messages`, `GET/POST messages/:id`, `GET events?after=…`.
- `POST native/:runtime_id/credential`: administrator-only scoped credential bootstrap.
- `GET link`: WebSocket authenticated with a **peer** secret and `X-Kode-Node`.

Agent tokens can send only as their own session, inspect only their own message/receipt events, and cannot claim or settle another session's inbox. Paired nodes are explicitly trusted peers; this version does not implement multi-user/project ACL administration.

Message states:

```text
queued → received → delivering → accepted
                   └──────────→ uncertain / rejected
received → expired
```

- SQLite commits precede acceptance responses. Idempotency is per source address and key; changing the payload under the same key is rejected.
- Each target claims one message at a time, preserving acceptance order. Limits are 64 KiB per content, 256 pending messages per target, a maximum 24-hour TTL, and eight reply hops per linked request chain.
- Links reconnect with backoff and reconcile by stable message IDs and current receipts. Duplicate transport frames do not cause another runtime submission.
- Runtime submission is not a distributed transaction. A bridge crash, owner replacement or lease expiry during submission yields `uncertain`, never an automatic replay of a potentially executed task.
- Native PTY submission is best effort. Busy sessions and pending questions/plans hold messages in the queue. A successful write does not prove model processing.
- For remote messages, the receiver owns expiration once received. If the sender never obtains a receipt before its deadline, it reports uncertainty rather than falsely claiming the target did nothing. Later authoritative receipts can resolve that uncertainty.
- Events use monotonically increasing SQLite cursors; machine clocks are not recovery cursors. History is retained; automatic retention/compaction is not implemented.

## Verification

```sh
# Rust protocol, persistence, native PTY and reconnect tests
cargo test -p kode-bridge messaging -- --test-threads=1

# Disposable backend + dsh adapter / stdio MCP / owned-process tests
node integrations/dsh/scripts/test-integration.js

# Actual OpenSSH forwarding with disposable keys and local sshd
python3 integrations/dsh/scripts/test-ssh.py
```

The SSH script does not modify `~/.ssh` or system SSH settings. It requires a usable local `sshd` and `ssh-keygen`; unsupported environments fail explicitly.

`test/fixture-model.js` is a local OpenAI-compatible inference fixture for manual dsh runtime verification. It handles fixture prompts only and never calls a remote model. Real dsh 0.2.1-rc.2 was used to verify model tool discovery/calls, native inbox persistence, and a request/reply roundtrip between two dsh Hosts through OpenSSH. A second verification stopped the receiving dsh Host, queued a message over SSH, restarted dsh without opening the session, and observed native cold resume, a model-issued reply linked by `in_reply_to`, and accepted receipts on both nodes. New bridges negotiate link v2 using an optional authenticated upgrade header and a server-first Hello. Old bridges retain v1 message behavior; capability frames are exchanged only after both sides select v2. A v2 handshake alone does not imply support for managed collaboration operations. This is integration evidence, not a model-quality evaluation.

## Agent configurations and native CLI conversations

The Web **Agent** selector replaces the standard-preset chip on new conversations and the preset label in an existing conversation's header. It uses dsh's own Menu primitive, as does the bottom-right **model** selector. The Agent menu ends with **自定义 Agent…**, which opens dsh's own Modal with the profile list and a name/type/executable form. Choosing a type fills its default executable. Executable overrides, JSON argument arrays, environment variables and a preferred model are independent per entry. Two `codex` entries named Codex and Company Codex can launch `codex` and `tcodex`, each owning any number of conversations. Type chooses the protocol; the stable profile ID chooses the configuration. Names and executable names are never used as unique keys or to infer protocol types.

Selecting dsh also shows its own preset menu (standard, minimal, PTC and any other presets the Host advertises). It reads and selects presets through dsh's public `agentPresets` Remote API; an external Agent does not show this mode menu. Type and protocol fields inside the configuration dialog use the same native Menu component as the composer.

Five built-in entries (dsh, Codex, Cursor, Claude Code, CodeBuddy) are separate from user-created entries. Defaults resolve actual executable paths on the executing Host; Cursor tries `agent` and `cursor-agent`, never the Cursor GUI launcher. The custom dialog shows only user-created entries and supports adding, editing and deleting them. “Custom” and “manually added” are one configuration entity, not two registries. The owner-only API accepts `{ action: 'remove', profileId }`; built-ins reject update/delete requests, and removing a custom entry preserves already bound conversation snapshots and model selection. Changing the protocol type resets the argument array so arguments from the previous CLI cannot contaminate discovery.

Models are discovered from the selected executable's protocol and account environment. Selecting an Agent chooses an advertised model (the configured preference, advertised current/default model, or first available model). There is no synthetic “CLI default model” menu entry. Empty or failed discovery is shown explicitly and does not silently switch providers. The model menu can refresh the executable's catalog. Existing conversations retain their Agent; model changes remain within that Agent's catalog.

The runtime choices are implemented as protocol adapters while dsh keeps the conversation UI and inbox:

| Agent type | Protocol / reused framework | Default executable |
|---|---|---|
| dsh | dsh's native loop | none |
| codex | Codex app-server | `codex` |
| claude | [Claude Agent ACP](https://github.com/zed-industries/claude-agent-acp), using the official Claude Agent SDK | `claude` |
| codebuddy | CodeBuddy native ACP (`--acp`) | `codebuddy` |
| cursor | [Cursor's native ACP endpoint](https://cursor.com/docs/cli/acp) | `agent` |
| custom | ACP by default, or explicitly selected Codex app-server | configured by the user |

The ACP client uses the [official TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), pinned to stable ACP v1. Custom means a compatible protocol executable, not an arbitrary interactive terminal program. The Claude adapter launches the configured CLI through the open-source bridge, preserving executable overrides, argument arrays and environment settings; it does not silently substitute its bundled CLI. CLI installation and login remain the user's existing CLI setup. There is no fallback to a one-shot subagent or to dsh inference.

Profiles and conversation bindings are saved privately on the Host, by default beside `stateFile` in `agents-{node_id}.json`. `agentProfilesFile` overrides that path. `agentProfiles` supplies initial entries only when that file does not exist:

```yaml
    agentProfiles:
      - id: codex-company
        name: Company Codex
        type: codex
        executable: tcodex
        args: []
        env: {}
      - id: claude-company
        name: Company Claude Code
        type: claude
        executable: tclaude
      - id: other-acp
        name: Another ACP Agent
        type: custom
        protocol: acp
        executable: my-acp-agent
        args: []
```

External conversations retain their native session/thread ID and accept followups through the original dsh inbox, including peer messages. Each dsh conversation owns a separate process and an immutable launch-configuration snapshot. ACP restoration checks `loadSession` before loading and suppresses native history replay because dsh already owns that transcript. An Agent that cannot restore sessions is never silently replaced with a fresh conversation. Codex initialization handshakes are serialized to avoid first-use SQLite creation races in builds sharing a home; loaded processes and turns remain concurrent. Changing a saved executable affects new conversations; existing ones resume with their original snapshot. Changing a conversation's Agent after it has started requires a new conversation. Model changes within that Agent apply to the next turn.

The adapter streams native answers into dsh's existing chat and projects command/file/MCP activity into its tool timeline. It records the full assistant advertisement → tool call → tool result lifecycle required by dsh's durable reader. Local call identities include a process epoch so a resumed CLI reusing an ID cannot corrupt the dsh log. Codex receives the dsh declarations as dynamic tools. ACP Agents receive an official-SDK MCP stdio bridge backed by a per-Agent authenticated loopback server. Both paths execute through the owning Agent's dsh tool runtime, including `kode_sessions_*`. The proxy rejects foreign credentials, cross-origin requests and tools not advertised to that Agent; it never forwards a bridge administrator token.

Native command/file approvals and supported interactive questions go through dsh's human-interaction services. Codex receives the current sandbox policy and workspace root per turn. ACP selects an advertised read-only/plan/ask mode for read-only sessions and refuses to proceed if the Agent exposes no such mode. ACP-native operations remain enforced by that CLI's own mode and permission implementation; tools delegated to dsh always use dsh's policy. Only one-operation permission grants are returned; unhandled requests fail rather than granting access. Host administration credentials and inherited kode parent-session identities are removed from the child environment. The plugin owns and closes its ACP process group, scoped MCP server and temporary launcher/credential files.

The adapter accepts text, files and images through the official dsh attachment service. Codex receives validated local image paths (or inline images for memory-only stores); Claude receives image blocks directly; other ACP Agents require negotiated image support. Native Codex/Claude image transport is not blocked by incomplete model-catalog metadata; actual image understanding still depends on the chosen backend model. Remote attachments use dsh execution-host storage, without a second temporary-file upload. Skill commands preserve attachments, and durable logs retain attachment references across resume. Auxiliary compaction/title calls through an external Agent route are refused. Work-bearing native turns are not automatically retried: input admission is persisted before dispatch, and a crash or lost result is marked uncertain. New followups can resume the native thread; the admitted input is never silently submitted a second time. Account login remains the configured CLI's own login.

The Web controls use dsh's authenticated owner connection and public hero/header/composer slots; the bundle replaces the stock preset and model-selection UI so model choices stay within the selected Agent configuration. The dsh outer loop, persistence and delegated tools still run; an external CLI owns its native agent turn. Headless Hosts keep the model tools and need no browser. Configuration files stay on the executing Host, so remote CLI environments are not copied to a local process.

The immutable session workspace is passed as the process cwd and native session cwd. Codex also receives that directory and the current sandbox/approval policy on every turn. ACP Agents receive the current read-only or working mode, and operation permission requests enter the owning dsh approval service. Explicit full access without prompts grants individual native permission requests; confined modes do not inherit that grant. ACP mode selection and approval bridging do **not** establish an OS filesystem sandbox: `workspace-write` containment for native ACP operations is still limited by the CLI's enforcement. The configuration dialog states this distinction; delegated dsh tools retain dsh's own sandbox.

Workspace identities, names, directories, membership and ordering live in the
Kode backend's canonical `workspaces` document in SQLite. dsh's workspace registry
is an in-memory view over the `kode-workspaces` storage facet; its JSON workspace
backend and automatic default-workspace creation are disabled. GUI directory
choices and registration use the same backend API. An unavailable backend fails
explicitly; no frontend directory-history fallback exists.

Each execution node resolves its own canonical filesystem paths. Workspace
requests for SSH nodes travel over Kode's authenticated peer link, independently
of either frontend. Agent session creation resolves the selected workspace on the
target Host and refuses foreign ids or ambiguous omitted choices. The model's
session directory tool returns per-Host workspace names, ids and server paths.
Existing nondefault registrations were transferred once into Kode, and the old
dsh workspace files were retired; runtime code never reads those files.

On an unsent draft, the explicit Agent/model choice follows the Workspace picker's move to another blank session. Started conversations keep their immutable working directory. Follow-up verification used the real dsh Workspace picker to move between two local Workspaces, retained Codex and the selected model, and then used the installed Codex with GPT-5.6-Luna to execute `pwd`, write `workspace-check.txt` and read it back in the chosen temporary Workspace. The marker matched that Workspace's canonical path and was absent from the dsh server's launch directory. This is a real CLI execution check, in addition to the deterministic protocol fixtures.

Regression coverage includes concurrent same-type configurations with identical native IDs, environment isolation, followups, native resume, duplicate-input refusal, cancellation, unavailable executables, dynamic tool calls and owner-only configuration. Real dsh Web verification also covered an external Codex-protocol configuration calling `kode_sessions_send`, an SSH-connected dsh model replying with `in_reply_to`, and acceptance on both sides. Models in that roundtrip were deterministic fixtures. A separate opt-in check exercises an installed Codex binary's initialization, model discovery and two simultaneously live native threads with one isolated `CODEX_HOME`, without inference:

```bash
KODE_TEST_CODEX_EXECUTABLE=/absolute/path/to/codex node --test test/agent-runtime.test.js
```

ACP fixtures use the official SDK on both sides and the real MCP stdio/HTTP transports. They cover scoped tool execution, permission rejection, model/mode changes, followups, native load, replay suppression, cancellation and unsupported resume. Additional opt-in checks exercise real Claude/Cursor CLI model discovery, MCP configuration, and read-only mode without sending a prompt for inference:

```bash
KODE_TEST_CLAUDE_EXECUTABLE=/absolute/path/to/claude \
KODE_TEST_CURSOR_EXECUTABLE=/absolute/path/to/agent \
node --test test/acp-session.test.js
```

To verify the tool log against dsh's actual released Session writer and reader (including a native process restart that reuses call IDs), point the additional compatibility gate at an installed pinned dsh dependency directory:

```bash
KODE_TEST_DSH_NODE_MODULES=/path/to/dsh/node_modules node --test test/dsh-session-log.test.js
```

`test/native-messaging.test.js` crosses the native protocol boundary for Codex, Cursor and custom ACP: the fixture Agent invokes `kode_sessions_send` through the owning dsh tool executor, a real Rust backend receives it with the bound source identity, and a linked reply reaches the original dsh inbox. Together with the actual OpenSSH transport test and released dsh log-reader checks, this covers the execution, routing and persistence boundaries independently.

### Validation record (2026-10-26)

| Requirement | Verified evidence |
|---|---|
| Separate development branch; retain kode GUI | `feat/session-messaging-dsh`; new integration directory and opt-in bridge registration; no Tauri migration |
| Durable local and SSH messaging | Rust delivery, scoped identity, deduplication, restart, busy/approval, reconnect and reply-chain tests; disposable real OpenSSH bidirectional test passed |
| Models call communication tools | Real backend + stdio MCP tests; native Codex/Cursor/custom ACP send-and-reply tests; dsh Web fixture request/reply over SSH |
| Original dsh conversations and persistence | Released 0.2.1-rc.2 Session writer/reader tests for Codex, Cursor and custom ACP, including reused native IDs after restart; manual cold-resume SSH roundtrip |
| Multiple same-type Agent configurations | Concurrent `codex`/`tcodex` fixture turns, independent profile IDs/environment/snapshots, and installed Codex simultaneous native threads |
| Separate Agent/model controls and guided executable settings | Real dsh Web checks for Codex, Tcodex, Cursor and custom ACP; custom protocol form visible; model changes retain the Agent configuration |
| Packaged plugin entry points | `npm pack --dry-run` includes Host/client exports, profile patch, MCP entry and protocol bridges; dependencies pinned in package manifest and lockfile |

Final backend checks: kode-bridge **85 unit + 5 integration tests passed**, plus the separately enabled real SSH test. The dsh integration runner includes installed-CLI and released-reader gates; the UI/policy follow-up adds advertised-model admission, per-turn workspace/sandbox/approval propagation and native ACP approval-policy transitions. Installed Codex/Claude/Cursor checks cover protocol setup and model discovery without inference. Conversation and tool roundtrips use deterministic local fixtures; they do not establish real-provider model quality. External routes currently accept text input and leave native context management to their CLI; auxiliary dsh title/summary inference through those routes remains unsupported.

The subsequent profile/defaults/deletion follow-up passed **31 integration-runner tests**, including built-in protection, independent custom configuration CRUD, and preservation of bound conversations after deletion. Real account discovery returned 4 Codex models and 31 Cursor Agent models. Browser checks exercised dsh minimal-mode selection, both native configuration menus, custom-only configuration listing, and creating/deleting a disposable custom configuration while preserving the user's other entries. The local Workspace execution check above used actual inference; the automated account-discovery gates do not.


### Workspace, browser, and message presentation

The project menu uses native dsh Menu rows with project-name/path search, a current-Host label, and the native folder picker. Local projects remain selectable. The execution-host control switches between this computer and saved SSH Hosts. The unified Create Project dialog uses dsh’s native system folder picker locally and its browse picker on the remote Host. Messaging peers and execution Hosts are separate directories.

`@kode/dsh-browser` reuses the pinned official sidebar browser chrome and replaces only the Web page provider. An owner-authenticated API renders top-level pages in an installed Chrome/Chromium with a private profile; the browser sandbox and site framing policies remain intact. MR links stay in the sidebar, including sites that reject iframes. The original address bar, tabs, history controls and explicit external-open action remain. `browserExecutable` and `browserProfileDirectory` are optional Host settings. The entry machine owns browsing even when the conversation executes over SSH. This initial pixel-stream provider supports pointer, keyboard, paste and IME input; viewport coordinates follow actual stream geometry, final frames are coalesced, and expired pages recover without replaying input. Native accessibility trees, file selection and download management are not exposed. Selection copying has an implementation but is not yet verified across host clipboard integrations. Login state is separate from the user's regular browser.

Communication remains model-tool driven. The transcript shows sender session name → recipient session name and the actual message, with no raw source addresses, message IDs, reply IDs or JSON in the communication cards. Long received messages expand in place. Send statuses are explicitly the recorded status at send time, not a claim of task completion. The original protocol is still available to the model and in the native trajectory/log.

The owner-only, read-only `GET /api/kode/sessions` endpoint returns a minimal session-name directory through dsh authentication. Full `(node_id, session_id)` pairs resolve names; a remote session is never looked up against a same-ID local session. The client shares one directory read across cards and refreshes every 10 seconds while cards are mounted and the page is visible. Missing names display a readable unavailable/unnamed state instead of an ID.

The messaging backend adds session-scoped `POST /api/v1/messaging/sessions/:id/title` with `{ "title": "…" }`. It changes directory metadata without rotating credentials, reviving offline sessions, or disturbing claimed messages. The Host reads dsh's authoritative `sessionTitle` service, updates changed live titles, and backfills already-owned persisted session titles at startup without resuming Agents. Existing authenticated peer-directory frames carry these names across SSH; the wire frame format is unchanged.

Validation: 36 integration-runner tests passed, followed by 6 focused client/name-API tests including the additional inactive-session backfill case. The messaging Rust suite passed 10 tests (the environment-gated disposable SSH test was not enabled in that command). Live browser checks verified project search/switching/native directory selection, sidebar HTTP(S) loading, cross-node name resolution, and immediate current-session rename updates. Exact, settled, text-only assistant echoes of a verified Kode incoming envelope are now suppressed in Chat beside the received-message card. Matching is restricted to the same turn and the complete envelope (optionally prefixed by a one-line Agent label); substantive replies, mixed content, and streaming output remain visible. This presentation rule uses rc.2 Chat data attributes, retaining the native assistant renderer and all durable events/trajectory content; revalidate those attributes when upgrading dsh.


### SSH execution Hosts and settings (2026-10-26)

The local plugin starts `kode-ssh-tunnel`, which reuses `kode-bridge::ssh::Tunnel` and its SSH config / known-host checks. An authenticated loopback portal forwards the complete remote dsh HTTP/WebSocket application. Agent execution, directory browsing, file preview, Git and PTY terminals therefore belong to the remote dsh Host. Kode does not reimplement these services. Switching Hosts selects a different dsh session store; it does not migrate an existing conversation.

Build the helper with `cargo build -p kode-bridge --bin kode-ssh-tunnel`, then put it on PATH or set the Kode Host plugin’s `sshTunnelCommand` to its absolute path. Install the same pinned dsh and Kode plugin on the remote machine, apply `cordis.remote.patch.yml` in addition to the bundle, and start `dsh web --no-open` bound to loopback. For manual installations (automatic deployment is documented below), In Create Project → Add SSH Host, provide the SSH config alias, port, and complete loopback access URL printed by the remote dsh. Profiles are saved mode 0600; remote tokens stay server-side. The browser receives a single-use portal ticket and a separate HttpOnly cookie. Closing the owning dsh Host closes its portals and tunnels.

Settings → Agent contains custom Agent CRUD, including multiple instances of the same type and default avatar selection. The composer's Custom Agent action opens this section. The official Models section and settings navigation remain intact; DeepSeek Harness's model-settings button opens that native section through the shared `openSection` action. The composer retains per-conversation Agent/model controls and dsh work-mode selection. Kode does not wrap or reorder the official settings shell.


Terminal font family and size remain user preferences under Settings → General → More font settings. No default font is forced and existing preferences are not overwritten. An optional bundled Nerd Fonts Symbols face is available as `"Kode Terminal Symbols"`; users can append it to their configured font stack when their preferred font lacks prompt glyphs. The font asset is served behind dsh authentication, with the upstream license included. The browser machine’s installed fonts are used even when the shell executes remotely.

Live acceptance used two isolated dsh Hosts and a disposable real OpenSSH server on the same Mac, not a production remote machine. A real Codex turn searched for the partial title “远端验收助手”, selected its unique directory result, sent a message over the SSH peer link and received the other real Codex session’s linked reply. The initial prompt contained no session address. Remote project acceptance separately executed `pwd`, wrote/read a marker in the chosen workspace, previewed its file through dsh, and ran a PTY Git diff. The user confirmed the local native folder picker appeared. A configured installed Nerd Font fixed the zsh prompt glyphs without code selecting a font.

## Unified local / SSH workspace sidebar

The Kode plugin extends the native dsh workspace tree with an owner-only, cold
workspace directory from each saved SSH Host. Rows use `(host, id)` identities;
opening a foreign session switches the execution Host and selects that exact
session after dsh's initial navigation has settled. Native workspace rows,
search, collapse, timestamps, and selected states are reused for both origins.
SSH projects carry a remote-computer icon and host label. Reading the directory
never resumes an Agent. A disconnected Host retains its last in-memory snapshot
and offers retry; reconnecting reconciles the directory. The directory endpoints
are metadata-only and never return credentials or conversation bodies.

The built-in dsh Agent is enabled by default alongside external Agents. Users
can select it directly without configuring plugin lifecycle entries. Official
settings navigation, Models, Web Search, Plugins and Trajectory remain available.
Kode reuses dsh's attachment upload/storage, files, Git, terminal and browser
services; it adds native protocol adapters, shared Agent/session metadata and SSH
routing. The framework's internal plugin lifecycle remains an implementation
detail.

### Official sidebar capabilities

The workspace/session tree, files, document preview, Git, terminal, browser and
Plugins page reuse dsh's official services and UI. Kode adds local/SSH routing,
shared session metadata and Agent avatars through the existing sidebar slots.
There is no parallel Kode sidebar plugin suite to install.

The experimental **Codex subagent** and **Claude Code subagent** entries are
optional task-delegation bundles, unrelated to rendering the sidebar or selecting
a main native Agent. Leave them uninstalled for this integration. The main Agent
adapters use the configured CLI and protocol libraries; neither subagent bundle
is a dependency. Other optional official sidebar/UI features can be selected
through dsh's own Plugins page. Features that change execution or session
lifecycle (such as Teams, Ralph and moving existing sessions between worktrees) require separate
compatibility work with native conversations and are not enabled by this bundle.

### Managed SSH installation

Settings → SSH Hosts accepts a display name, SSH address and port. The default
action uploads the matching Kode services and this plugin, prepares Node.js when
needed, installs the pinned official dsh distribution, starts both services on
loopback, checks authentication and pairs the two messaging nodes. A live progress
dialog exposes each step, errors, cancellation and retry. The existing-access-URL
path remains available for manually administered Hosts.

The SSH transport uses the user's keys/config and strict known-host checks.
Unknown host keys or password-only authentication must be resolved through the
user's normal SSH setup. Nothing is installed with sudo. The managed installation
lives under `~/.local/share/kode/dsh-host`; its data stays separate from an existing
dsh home. It does not install AI CLIs or copy local CLI credentials to the remote
Host. Existing remote CLI configuration and login remain authoritative.

Updates are staged before stopping managed services and refuse to replace a Host
with running/queued conversations. Only recorded managed processes are stopped;
failed activation attempts restore the previous release where possible. Two
release directories are retained for rollback, while databases and profiles live
outside those release directories. Repeated deployment reuses healthy matching
services. Removing a managed Host revokes the local messaging pair; it does not
delete remote workspaces, native histories or installed services.

Distribution builds must include the native artifacts for their supported targets:

```sh
npm run build:remote -- --target x86_64-unknown-linux-musl
```

Other supported artifact targets are `aarch64-unknown-linux-musl`,
`aarch64-apple-darwin` and `x86_64-apple-darwin`. Linux cross-builds on macOS use
the existing Kode Docker build image. The deployment checks artifact availability
before upload; `remoteArtifactsDirectory` can supply an externally packaged tree
of `<platform>-<arch>/{kode-session-server,kode-ssh-tunnel}`. Same-platform source
checkouts can also use local compiled binaries.

### Desktop parity audit (2026-10-28)

| Capability | dsh integration status |
| --- | --- |
| Agent configurations, default/session avatars | Shared Kode registry and metadata; native dsh controls. |
| Local/SSH projects and independent native sessions | Available; managed SSH installation adds setup/progress/pairing. |
| Session creation and communication | `kode_sessions_*`, including authenticated cross-node delivery. |
| Resume, skills, images, approvals | Native protocol adapters; `/resume` lists registered Kode histories, not every arbitrary CLI history file. |
| Files, Git preview, manual terminal | Official dsh services, including terminal font preferences. |
| Sidebar browser | Official chrome with a private Chromium page provider; internal MR browsing. See input/accessibility limitations above. |
| New conversations in worktrees | Create a branch/checkout from a registered Git workspace and start the new session there, preserving draft and Agent/model. Moving an existing conversation back to the main checkout is not implemented. |
| Mid-turn steering | Codex uses native `turn/steer`. Claude, Cursor and CodeBuddy use the advertised ACP `_session/steering` extension when available; otherwise they cancel the active prompt, wait for its terminal response, and continue with the new input in the same native session. |
| Queued-message steering | Native admission is checked before transferring a queued input. The original queue occurrence is removed before insertion so every persisted prefix has unique pending IDs. Synchronous failure restores the original position; rejected native delivery returns the input to the queue. |
| Shared memory UI and synchronization controls | Shared backend switches are available in both frontends. The review queue, scope/relation editing and memory sync administration remain in the original GUI. |
| Native plugin/Hook installation and management | Missing desktop management UI; dsh's own plugin page manages dsh bundles, not all native CLI plugins. |
| Model usage and desktop floating monitor | Missing desktop-wide monitoring parity; dsh has its own per-session observations. |
| Phone pairing, cloud sync deployment | Settings → 手机与同步 shows a one-time pairing QR code and a manual pairing link through the shared backend. Cloud-service deployment remains in the original GUI. |
| Native screenshot tools, desktop window/tab actions, SpecOps window | Not ported; some are desktop-specific rather than Web-session requirements. |

For older logs failing with `invalid persisted inbox splice` or a non-ignorable `plugin:kode/model-fast` record, run `python3 scripts/repair-inbox-history.py --home <dsh-home> --session-id <id> --runtime-modules <released-node_modules> --node <node-24.22+>`. It reports changes by default. Add `--apply` to repair under the session writer lock, back up the artifact and projection cache, and invalidate the stale cache. Event sequence IDs and input content are retained; ambiguous transfers are refused.

Managed service supervision is currently process based; automatic startup on OS
boot and general service-manager integration are not included. Native Agent forks,
Teams and Ralph also need lifecycle-specific integration before they can be
advertised as substitutes for independent Kode conversations.

External Agents run through `@kode/dsh/native-factory`, an independent durable
inbox/driver built on the public Session API. It sends only new inputs to the
native CLI protocol and never assembles the shell's dsh system prompt or runs an
outer dsh LLM loop. The official dsh Trajectory displays the canonical session events projected by
the native driver. Raw native protocol events remain in the durable log.

The built-in dsh Agent uses the released `dsh acp` application in a separate
managed process. That application retains its own complete harness, presets,
tools, prompt and model loop. Its private launch patch reuses the configured
provider definitions; credentials are never sent to the browser. Kode owns the
process lifetime and closes it when its owning runtime stops. Plugins installed into the Web shell are not automatically installed into this
separate ACP runtime or external Codex/Claude runtimes. Mode selection is applied when that
native conversation starts. ACP permission policy is admitted in the launch
patch; the pinned upstream protocol does not advertise live permission changes.

`@kode/dsh-transport` routes the official Connection carrier through Kode's
owner-only HTTP/WebSocket SSH gateway. Host selection is tab-local; switching
releases the current view, negotiates a new Host generation and restores the
selected remote Session in the same page. The local native folder chooser and
the released remote directory browser coexist through a small pinned slot
priority adapter. Files, Git and terminals continue to use dsh's own services.

With `sharedBackendState: true`, the desktop and dsh read and edit the same
Agent registry in Kode's backend SQLite store. Agent IDs and protocol types are
independent of display names. Desktop `config.toml` and the former Host Agent
JSON file are migration inputs, retained for rollback; later Agent edits go to
the shared registry. New conversations use updated definitions, while existing
conversations keep their immutable launch bindings, including across frontends.
Compare-and-swap rejects stale updates.

Both frontends use the common native session catalog, keyed by Agent and native
thread identity. Closing a desktop tab does not delete its conversation.
Native CLI transcripts remain authoritative in their original homes; dsh keeps
its presentation events and resumes the original CLI thread without replaying
historical prompts. SSH Host definitions are also shared backend documents.

## Natural session cooperation and creation

The Agent receives five scoped `kode_sessions_*` tools. Users state the task in
ordinary language, such as “Ask the remote environment helper to check the OS
and project directory” or “Open a conversation on the remote host and have it
check this problem.” The Agent discovers names and addresses itself. Runtime
instructions describe the capabilities; acceptance prompts do not prescribe
tool names, ids or invocation sequences.

`kode_sessions_create` creates a named conversation on this Host or a saved SSH
Host. It selects an existing executable profile, inherits the caller's local
permission policy (remote admission never grants full access), and submits the
task as a durable peer message. The new helper can return its result to the
requesting conversation. A persisted creation key prevents duplicate sessions
or task replay; an uncertain submission requires inspecting the saved session.
The optional `model` field selects an exact model advertised by that Agent (for
example `agent: "CodeBuddy", model: "deepseek-v4.1-flash"`). The Host validates
it before creating a session and returns the resolved `model`; unsupported models
fail explicitly instead of selecting a default. This is session-local and does
not change the shared Agent configuration. Keep all creation parameters and the
same `idempotency_key` on retry. A legacy `prepared` request from a tool version
without `model` may add it once while preserving its existing session and input
identities. Completed or ambiguously submitted requests cannot change model.

Receipts are distinct from task results. Replies that complete a request require
no acknowledgement; a meaningful follow-up question remains possible.

Kode GUI saved tabs appear in the unified directory. Opening a supported Codex
or Claude tab imports its text history once and binds the original native thread;
no historical prompt is re-sent. Native CLI histories remain authoritative. A
saved CLI without a supported inline protocol reports its adapter limitation
rather than silently starting an unrelated Agent. GUI uses the optional private
`workbench-connection.json` descriptor to read/write the shared session index;
its old state file remains a backup. Set `publishWorkbenchConnection: true` on
the local Host to publish that descriptor. Remote metadata stays on its execution
Host; existing GUI SSH endpoint authentication remains separate from dsh web
authentication.

### Acceptance record, 2026-10-27

Real Codex conversations on the local machine and an actual SSH Linux Host were
given ordinary requests, without tool names or addresses in the user prompts:

- “请让远端环境助手帮我查清楚操作系统和项目目录，再把结果告诉我。”
  The local Agent discovered the named peer, requested checks, waited, asked a
  substantive directory clarification, and summarized the returned Linux facts.
- “请在远端新开一个叫‘远端计算助手’的会话，让它算一下 17×23，并把结果告诉我。”
  The Agent discovered the saved Host, created the helper, assigned the task as a
  peer message and returned the helper's answer, 391. No acknowledgement loop.

The browser stayed on the local origin while displaying the SSH conversation.
The native file panel showed the remote workspace; the sidebar terminal's `pwd`
returned that same remote directory. Optional dsh runtime enable/disable was
verified through the released Plugin Manager, and external runtimes remained.
The pinned released Session reader accepted native Codex/ACP logs after resume.

### Frontend coverage

The GUI directory chooser and session workspace registration use the canonical
Kode workspace REST API. Its backend can run independently of either frontend;
the GUI can start it without launching Tauri windows in service mode. Workspace
ownership/CRUD and SSH node isolation have backend, registry and GUI-client tests.

The shared Kode backend now owns the runtime session directory, durable semantic
history and control receipts. dsh publishes its existing Session controller and
canonical events; it continues to own Agent execution, queuing, sandbox policies,
approval audit, persistence and native CLI ownership. The GUI publishes its native
bridge through the same adapter. No second Agent loop is created when another
frontend opens an already running conversation.

Phone pairing has its own **Settings → 手机与同步** section. Select the Host,
enter a sync-server URL reachable from the phone, and choose **生成配对二维码**.
Scan it with Kode Mobile, or paste the displayed link into manual pairing. The QR
is generated locally from the same one-time invite; expired invites are hidden
and can be regenerated. **集成** contains only the Agent communication
and shared-memory integration switches.

The phone uses the existing `kode-sync-server` pairing and authenticated
REST/WebSocket protocol. Its backend/model catalog is provided by the attached
runtime (`dsh:<profile-id>` / `gui:<backend-key>`), and create, input, interrupt,
permission and human-response commands execute on that runtime. A stopped runtime
retains its published history; new execution requires its Host to reconnect.
Runtime history retains the latest 10,000 events per conversation. Shared session
IDs and command results persist across backend restarts. An uncertain operation is
never automatically submitted again with a new request ID.

A GUI-first installation and dsh discover the same authenticated loopback service
through `workbench-connection.json`. Existing native history remains available;
when its GUI owner is alive, dsh attaches a shared view. Once that owner is closed,
opening saved history uses the existing native import/resume path. Starting a
separate isolated backend (explicit URL/token/config or `KODE_DSH_HOME`) intentionally
creates a separate session directory.

Both frontends expose shared communication and memory switches. In the original
GUI use Settings → 会话互通与记忆 → Configure Agent access to register the managed
MCP launcher, then start a new Agent session. No manual `KODE_MESSAGING_CONFIG`
editing is required. dsh registers its scoped tools through the Host integration.
The backend enforces both switches on each tool call. Agent memory proposals stay
pending until reviewed through the original memory UI. MCP registration remains
inactive outside a Kode-managed GUI session; backend admin credentials stay out of
browser bundles and Agent tool arguments.

For isolated acceptance testing, build the frontend and debug Rust binaries, then
run `node integrations/dsh/scripts/test-mobile-sync.js` from the `kode` directory.
It starts real backend, cloud, GUI and dsh processes with deterministic native CLI
fixtures. It covers GUI-first attachment, mobile creation and replies through both
runtimes, deduplicated sends, dsh permission execution, shared settings and custom
ACP Agent restoration after a GUI restart. It does
not invoke a model or change user Agent configuration.

### Native process history

Recent-history imports retain native timestamps, turn boundaries, command/edit
calls and their results. Imports are seeded before publishing the Agent, so the
driver allocates its next turn after the imported maximum. Reasoning delta
variants and native command events use the same canonical chat event flow as
live text. Only genuine cancellation ends a turn as aborted.

Older text-only caches can be repaired without changing the native CLI thread or
session address. Stop the dsh Web Host first, leaving its Kode backend running:

```sh
node scripts/repair-native-history.js \
  --home /path/to/dsh-home \
  --url http://127.0.0.1:47870 \
  --token-file /path/to/admin.token \
  --runtime-modules /path/to/dsh/node_modules
```

The default command reports a repair plan. Add `--apply` to acquire each session's
kernel writer lock, back up its artifacts under `DSH_HOME/migrations`, preserve
subsequent live events and replace only the derived historical cache. The repair
validates released event relationships and writes a separate, checksummed header
frame. Restart the Web Host after repair. Original CLI history is never changed.

Native Agent model changes are recorded in the current session without saving dsh global defaults or reloading its session service. The Web transport waits for the owner read endpoint before opening its first subscription; it never retries session creation or prompt submission. Inline file citations split supported line suffixes before entering the existing dsh preview, preserving the owning Host and file policy. Historical tabs whose original Agent profile has been removed are left intact rather than rebound to another installation.

### Native commands and skills

Human `!command` input runs through the selected Host's existing dsh shell in the session workspace without starting a model turn. Output and exit status appear as a tool result; bounded context is durably forwarded with the next ordinary prompt. Peer messages never activate this shortcut.

The existing slash menu contains session-scoped native capabilities, including Claude and CodeBuddy commands/skills received after ACP setup. Namespaced commands also have a hyphenated menu alias because the pinned registry does not accept colons; dispatch retains the native name. `/help`, `/status`, `/model`, `/mode`, and `/shell` are session utilities. Codex additionally maps `/compact`, `/review`, `/mcp`, and `/skills` to app-server methods. Commands requiring a CLI window, login, or a different conversation identity are rejected explicitly. Native control commands never fall through to an ordinary model prompt.

Codex `$skill` completion reads `skills/list` for the current profile and workspace. Selection preserves existing draft references; matching explicit references become native skill inputs containing the discovered name and path. Claude and CodeBuddy skills remain native slash commands. Unique advertised display names and case variants resolve to canonical model IDs; unknown or ambiguous names are rejected.

Saved native tabs can be pinned, renamed, archived, and restored through canonical Kode metadata even if their Agent configuration or adapter is gone. These actions allocate no Agent, import no transcript, and never rewrite CLI logs. Archive state stays in the workspace document; the session index retains the identity a future import would use. Kode's catalog respects that archive state too.

SSH forwarding retains the saved tab's native backend/thread identity when applying these metadata operations on its owning Host. Foreign conversations without project membership remain under that Host in the sidebar instead of leaking into this computer's ungrouped sessions. Opening saved history resolves stable profile IDs and desktop backend aliases before unique legacy display names; an explicit missing or ambiguous Agent is never replaced with another configuration.

Packaged Desktop installations resolve their bundled `kode-ssh-tunnel` by absolute path before falling back to PATH. An explicit `sshTunnelCommand` still takes precedence.

Explicit runtime creation reserves a backend routing ID before the target receives its first prompt. Its empty DTO remains retired until content is published, so this does not reintroduce blank catalog entries. Creation returns both that numeric ID and the native runtime session ID. Legacy empty creation receipts can recover after a new Host boot using the same request ID and deterministic session identity; complete receipts and input submissions are never replayed.

A shared saved-session import marker is reused only when the current Host still lists its local persisted session. If that artifact is missing, opening the conversation reimports available native CLI history under the same session identity before attaching it to the workspace. Unavailable native history fails before workspace creation; cold runtime projections do not stand in for a live owner.

### Native conversation presentation

These extensions live entirely in this plugin; they do not require editing dsh
source or its installed files. The supported release is pinned to
`0.2.1-rc.2` with Node.js `>=24.9.0`. Slots, input-trigger sources and native UI
primitives provide the integration. A reversible presentation adapter wraps
that release's `commandUi.candidates` and input controller to share the native
menu for `/` and `$`; upgrading dsh requires checking those interfaces.
Installation still requires the Kode backend and configured, authenticated
Agent CLIs. `serverCommand`/`serverConfig` can start an existing backend binary;
the plugin is not a standalone backend installer.

Configured native CodeBuddy presets appear as built-ins without rewriting
their IDs, executables or saved bindings. Additional installations remain
independent custom Agents. Every built-in Agent uses its existing Kode icon.
Avatars belong to individual conversations: the header and sidebar menu open
a responsive chooser with eight columns at its desktop width. The chooser
reuses Kode's avatar library, or `avatarDirectory`/`KODE_AVATAR_DIR`. Artwork is
served by the entry Host even for SSH conversations. The execution Host saves
the gallery ID in canonical session-index metadata; an unbound conversation
temporarily uses `presentation.sessionAvatars` until its native identity is
saved. Agent launch bindings are unchanged.

Missing or nullable imported GUI avatar fields inherit the Agent default. A
non-null conversation choice overrides that default. An explicit choice of the
built-in icon is retained as a null entry in `presentation.sessionAvatars`, so
native catalog synchronization and cold restore cannot confuse user intent
with an unset optional GUI field.

Appearance (`ui-theme`, including native font roles) belongs to the entry Host,
so switching SSH execution does not change the window theme. Execution settings
remain owned by their selected Host. Native model discovery carries published
reasoning effort choices; the selector validates and forwards only those values.
Fenced `console` tool output uses dsh's Markdown code renderer.

The slash menu groups quick actions, Agent commands and skills with consistent
icons. Skill classification uses native metadata or bounded SKILL.md discovery.
Codex `$` completion uses dsh's menu and guarded draft insertion, including
namespaced skills. Shared `/rename`, `/diff`, `/stop` and frontend `/new` are
available; Codex rename also updates its native thread title. `/plan` is offered
when the app-server advertises that collaboration mode. For Claude adapters
without native `/autocompact`, `/autocompact on|off|status` records the preference
and passes SDK settings when reopening the same native thread at the next turn
boundary. This fallback does not implement numeric context-window arguments.

### Native command and appearance controls

Codex workspace skills appear in the `/` menu under **技能**, alongside the
existing `$` completion. Selecting a skill dispatches its original name and the
workspace-discovered path as a native Codex `skill` input; namespaced menu aliases
retain their original native identity.

Codex and Claude Code expose bare `/resume` as a session picker. It searches the
current execution Host's registered native history for the selected Agent
configuration, by title, workspace or native ID. Selecting a saved conversation
uses the existing history import and native resume/load flow; it does not send
`/resume` to the model or replace the current conversation's identity. Unregistered
CLI histories are outside this picker’s catalog.

Click an Agent's avatar in Agent settings to choose its default from the entry
frontend's existing avatar library. This works for built-in and custom Agents,
including DeepSeek Harness when installed. Individual session avatar overrides
(including an explicit reset to the native icon) take precedence. The dsh plugin
owns the picker and image delivery; Kode persists `presentation.agentAvatars`
alongside session appearance metadata. Executable profiles and bound launch
snapshots are unchanged by appearance edits.

### Ordered native output and compact operation cards

Native commentary, tool boundaries and final answers are committed to distinct canonical steps. The pinned official Chat UI is bundled as `@kode/dsh-chat`, using the native standard presentation. Text replies remain in chronological order outside the tool groups. Each consecutive run of tools shares one initially collapsed row whose title follows the latest running operation; expanding it reveals every call, including already completed ones. A later text reply ends that group. Completion-time Turn collapsing still leaves the final answer visible. Native tool renderers remain intact; individual tool completion never removes a row from history. The bundle adapts native Agent tool categories and uses its own `kode-chat` configuration namespace. Expanding the completed process reveals chronological text/tool groups; tool groups expand to individual operations. Commands use a compact monochrome summary and the official shell output renderer. Existing historical messages that were already concatenated are not rewritten.

Archived `/resume` targets are unarchived through the official workspace service before navigation. Directory-picker bindings stay stable across renders so remote browsing does not reset to the home directory. Advanced sections animate both opening and closing and respect reduced motion. Running and unread-completed sessions retain their avatars with a muted pulsing outline.

Validation for this update: released session-log compatibility and steering tests; real Codex same-turn steering; isolated browser acceptance for ordered output, nested tool expansion, archived resume, and a new worktree with preserved draft/model and verified session cwd. Internal browser acceptance reached an authenticated `git.woa.com` MR without opening an external browser.

### Saved-session and browser recovery

Opening an owner-selected saved native conversation registers its existing canonical working directory when the registry entry is missing. It never creates a missing directory, substitutes a parent workspace, or starts work while merely listing history. Unavailable transcripts and missing adapters fail before adding an empty project. Cached imported histories can restore their workspace registration without reseeding history.

The sidebar page provider leaves hidden pages unfrozen and pauses only their screencast. A browser-control timeout during tab allocation triggers one private-browser recovery and retry; it never restarts the Host or Agent services. Errors now retain their concrete description in the official browser error strip. Build the pinned presentation adapters with `npm run build:chat` and `npm run build:browser`.

Tool-group rows use a 2px vertical gap and compact 26px command headings without additional indentation. The running elapsed timer sits above the current reply. Completion transfers focus from a disclosed process to its surviving Turn header before folding, so focus protection cannot reopen intermediate replies. Interleaved steering also no longer forces a successfully completed process to remain open. Session avatar outlines use a stronger 2.5px amber/green pulse, retaining reduced-motion behavior.

### Agent configuration without changing the active Host

Settings → Agent has a configuration-Host selector. It uses the existing owner-authenticated SSH gateway for profile reads/writes while the current Session, filesystem view and terminal Host remain unchanged. Settings-only reads can request `configuration=1` to skip model discovery on updated Hosts. The default-Agent control persists the selected `kode-agent-*` provider and native default model through the official `agent-default-model` settings namespace, independently per Host. Explicit per-session Agent selection does not overwrite this default. Moving an unsent draft to another workspace preserves its chosen Agent; ordinary new conversations use the Host default. Existing bound sessions keep their immutable launch profile.

A command-line/home patch that pins `agent-default-model` blocks edits under dsh's normal precedence rules. Move that selection to the profile's editable patch (preserving provider/model) and restart the Host when idle; the bundled integration itself does not pin it.

The Agent scheduler and session messaging remain Kode-owned. The remote dsh service supplies the remote filesystem/Git/terminal/UI protocol endpoints, so remote work still needs a remote service connection; configuring remote Agent profiles does not require switching the active UI to that Host.

File-change summaries derive their labels from structured file paths, falling back to patch file headers and never to `@@` hunk lines. Plain-text HTTP failures now produce a Host/HTTP-status error instead of a JSON parser exception.

### Parallel operations and context pressure

The native driver defers a canonical step boundary while any advertised tool call is unsettled, including when reasoning, commentary and other tools arrive concurrently. Late events cannot advertise tools against a closed step. The Chat adapter retains superseded assistant messages from the same step at their original positions, so parallel native work does not erase earlier commentary.

`repairNativeStepBoundaries` is a lossless, explicit repair primitive for already affected native logs. It preserves event sequence IDs, message/tool payloads and real results; premature boundaries become ignorable audit records and step coordinates are normalized. Missing outcomes and active logs are refused. Physical artifacts must use `encodeHistoryArtifact` (separate checksum-protected header and event frames), and be validated with the released persistence reader. Back up originals before replacing any file.

The session-statistics icon is a context-pressure ring. Codex uses `tokenUsage.last.totalTokens / modelContextWindow`; ACP uses `usage_update.used / size`. Cumulative spend and cached-token counters are not added to context use. Unknown data is shown as unreported, not as zero. The same latest sample is projected on the Host and retained as a hidden client metadata node for older Hosts. The popup preserves native statistics and shows exact used/total token counts.

Owner configuration/SSH gateway routes no longer depend on the Session controller lifecycle; session-dependent synchronization is scoped separately. A history-loader failure therefore need not remove the management endpoints.

Saved native-session imports reuse existing bindings and preserve archive state. Unknown timestamps are not rendered as Unix epoch dates. Context statistics use the latest native window-usage sample, clear stale usage after compaction, and wait for a fresh sample instead of accumulating lifetime tokens.

Codex `/goal` uses native `thread/goal/*` APIs: `/goal <objective>`, `/goal` (or `status`), `edit <objective>`, `pause`, `resume`, and `clear`. The thread enables native goals without changing global CLI configuration. Mutations carry explicit user provenance. Running goal controls execute immediately; automatic native turns are consumed as dsh turns without manufacturing user prompts or dispatching a duplicate `turn/start`. Model and permission settings are applied before starting/resuming a goal.

### Sidebar browser display density

The private Chromium page follows the actual sidebar CSS viewport and the display pixel ratio (up to 2×, with an 8-megapixel backing-surface budget). Frames use lossless PNG so text stays sharp on Retina displays. High-density updates use coalesced surface captures triggered by browser frame changes, with one capture in flight and a 33 ms minimum start interval (up to 30 captures per second). Resizing the sidebar, entering fullscreen, and moving between display densities update the rendering dimensions; pointer coordinates remain in CSS pixels. Device metrics are restored after bringing a page to the foreground, avoiding deprecated visible-size overrides that can produce tiled captures.

Pointer motion is coalesced while requests are in flight, and adjacent wheel events retain their summed distance. Clicks, releases, keys, and resizes keep their order. Foreground targets reuse their focus and device metrics until the active page changes. Browser event streams bypass response compression and flush each frame immediately, avoiding delayed visual feedback from compression buffers. PNG captures use Chromium’s fast lossless encoder.

### Animated avatars and conversation backgrounds

The avatar picker now includes “创建头像与背景”, a refresh action, a background preview and a browser-local background visibility preference. Creation opens a separate, named local artwork conversation in the source workspace, inheriting its Agent and model selection, then stages an unsent prompt through dsh’s public draft-initialization API. The source conversation and its draft are untouched. Creating avatars and generating or replacing backgrounds all use this independent-session flow. The dsh-specific bundled copy of Kode’s avatar-generation workflow requests the existing 36-frame layout plus a separate landscape background. Kode desktop’s skill and prompt are unchanged. Existing avatars can generate or replace only their background without touching animation frames.

Conversation avatars open the picker directly. Settings → 个性化 shows the same picker as its page; Agent defaults are edited from each Agent's avatar edit badge. Choosing artwork previews it, and “确认应用” commits the selection and background visibility. The full-width background preview retains its original aspect ratio and keeps the avatar/name outside the image. User message bubbles retain their own surface over conversation backgrounds.

The edit icon beside the preview name renames the actual gallery directory. The owner-only rename API validates paths and collisions, migrates local native/GUI session references and Agent defaults, and rolls back the directory/catalog on metadata-write failure. `.dsh-gallery.json` retains old-to-new media aliases so older URLs and SSH appearance references continue to resolve without duplicating the old folder.

Gallery assets live on the browser entry Host, including when the conversation executes over SSH. Generation requires a local conversation so that its agent can write to the entry Host’s gallery. Each `gallery/<avatar-id>/` can contain `background.png`, `background.jpg`, `background.jpeg`, or `background.webp`; the selected avatar determines the conversation backdrop. Older galleries without a background continue to render normally. Backgrounds are subdued behind the conversation to preserve text contrast and can be disabled in the picker.

The picker previews idle frames; running conversations animate their avatar’s running frames at 180 ms per frame. Idle conversations remain still. Animation pauses offscreen, on hidden pages, or when reduced motion is requested. The owner-authenticated artwork API serves bounded frame sequences and optional backgrounds, checks real paths against the configured gallery, and never forwards local artwork through an SSH agent runtime.

### Recovering a missing settings API

Settings → 主机与服务 owns the service status and recovery controls for the selected local or saved SSH Host, alongside SSH connection management. 集成 and 手机与同步 show **前往主机与服务** when either the Web Host route or its Kode backend returns HTTP 404; the link selects the failing Host without switching the active workspace. `KODE_SERVICE_UPDATE_REQUIRED` identifies an older backend behind a current Host.

- **重启服务** restarts a local CLI Web Host and its verified, configured loopback Kode backend using installed files. Requests are rejected while sessions run or queue. A detached worker waits for graceful Host exit, verifies the backend command again before signalling it, and relaunches the original Web command with its original environment. It never force-kills an unidentified process.
- **更新并部署服务** updates the selected saved SSH Host through the existing deployment job, retaining SSH settings and busy-session checks. Progress is shown and settings are retried after deployment.
- **重新连接** retries settings without restarting. Desktop and unsupported launchers explain how to restart manually. A Host predating the recovery API needs one manual update/restart first. Local recovery uses installed files; it does not download a newer plugin.

Recovery is owner-authenticated. Duplicate requests are disabled; failures and readiness timeouts remain visible. `node --test test/service-recovery.test.js` exercises isolated recovery-worker processes without restarting the user's service.


### Compatibility with other Host plugins

Kode routes only sessions with an explicit `kode-agent-*` model route, the
`kode-native` preset, or an existing Kode binding to its native execution driver.
Other providers continue through the official AgentLoop, including third-party
plugins such as QQ bots. Official prompts, tools, presets and the Host default
preset remain enabled. Kode's default Agent is stored in its own registry and
does not rewrite the Host's `agent-default-model` settings.

The Kode browser workspace switches a blank conversation to the native driver
only when its Agent selector chooses a Kode route. Host-side plugin calls retain
their original creation/resume options.
The UI, transport and workspace catalog still share the Host; this is not a
blanket compatibility guarantee for arbitrary plugins that replace those same
services. Regression tests exercise official and Kode factories side by side.

### Kode 设置

全局设置中只新增一个 **Kode** 入口。页内导航可直达 Agent、集成、手机与同步、主机与服务、头像与背景；其他插件继续使用各自的设置入口。

前四个分区共享“配置主机”选择，修改配置不会切换当前工作区。头像与背景应用到当前打开的会话。会话中的 Agent 配置、主机管理和服务恢复快捷入口会打开 Kode 页内对应分区；dsh 模型设置仍打开原有模型页面。

### Agent sharing, extensions and screen-off execution

Open **Settings → Kode → Agent 共享** on the desired Host. Configuration and handoff receipts are owned by the Kode backend SQLite store.
Extension snapshots live beside that database in its `.agent-hub` directory.
Local and SSH Hosts keep separate configuration. dsh is an authenticated API
adapter and holds no independent extension configuration.

- **息屏后继续运行** persists a Host setting. macOS uses an owned `caffeinate -i -w`
  process; Linux uses `systemd-inhibit` when available. The display can turn off.
  Disabling the setting or stopping the Kode backend releases the inhibitor. Lid close,
  explicit sleep, shutdown and unsupported system power services remain governed
  by the OS. A failed inhibitor is shown in settings.
- A native Codex `/goal` produces a durable strip above the composer. Click its
  objective to edit, or use **暂停 / 继续**. Native notifications, including model
  goal updates and completion, update the same session projection. Existing dsh
  goal UI continues to handle dsh's own goal protocol. Agents without a native
  goal protocol do not advertise this control.
- Add an HTTPS/SSH Git repository or an absolute local directory, optionally
  select a subdirectory and choose targets, then click **更新并同步**. Packages are
  snapshotted with their relative resources intact. Portable skills are linked
  under `~/.agents/skills`, `~/.codex/skills`, `~/.claude/skills`,
  `~/.codebuddy/skills`, and `~/.cursor/skills`, named `<source>--<relative-skill>`.
  Existing unmanaged files cause a visible conflict. Failed file commits restore
  previous links; removed skills/targets remove only the links Kode still owns.
- Native `.claude-plugin`, `.codebuddy-plugin` and `.cursor-plugin` manifests
  add repeatable `--plugin-dir` arguments to subsequent Kode runtime launches.
  `.codex-plugin` packages use a generated local marketplace and the native
  `codex plugin` installer, including cleanup on source removal. Native hooks
  and MCP definitions stay in their original package; they are not translated
  between incompatible agent formats. Missing target manifests mean skill-only
  synchronization. Each target's status and native installation errors are shown.
  Outside Kode, the portable skill directories and installed Codex plugins are
  available normally; the other native plugin launch arguments apply in Kode.
  Existing processes may require a new session to discover changed packages.
- **换 Agent 续接** in the conversation header creates a new conversation on the
  same Host/workspace using the selected Agent and continues the latest user
  request with its readable transcript as context. The original stays intact.
  It transfers at most the latest 48,000 characters of user/assistant text,
  excluding hidden reasoning, tool lifecycles, peer messages and attachments.
  Backend-owned request identities and frozen source snapshots make network retries reuse the
  same target instead of sending work twice. This is a context handoff, not a
  conversion of proprietary native thread files. Existing shared directories,
  native session imports and `kode_sessions_*` messaging remain the unified
  discovery and collaboration paths across Agents and SSH Hosts.

Extension releases are kept while older runtime processes may still reference
those snapshots. Native plugin packages must provide manifests compatible with
any selected native targets; arbitrary proprietary plugin code is not portable.
All hub endpoints are owner-only; configuration and handoff transcripts are
stored in the private backend SQLite store. The GUI can use the same service
through `agent_hub_action` and `shared_session_handoff` IPC adapters. Managed
plugin launch arguments are returned separately from editable Agent configuration.
Native installer checks run through an isolated backend without inference or
changes to a real account:

```sh
KODE_TEST_NATIVE_PLUGIN_CLI=1 node scripts/test-integration.js
```

### Exact model reasoning capabilities

ACP Agents may advertise thought-level options only for the model currently
selected in their protocol session. Both selector discovery and runtime exact
model resolution must select the requested model before reading its capabilities;
the generic default-model catalog is not authoritative for another model. The
probe cache is scoped by profile revision, workspace, requested model and
extension revision, and refresh invalidates all model entries for that provider.
Canonical reasoning metadata is published from the same advertised effort list.
Unsupported effort values remain errors; saved user choices are never silently
downgraded. Cold resume and prepared calls use the same exact resolution path.

### Optional plugin history records

Kode metadata writers must use `appendPluginRecord` from the installed dsh
Session package. A raw `session.append('plugin:…', …)` creates a required unknown
event and can block every session listing, resume, and handoff after reload.
Regression checks must include `validateStoredEvents` from the released
persistence package; relationship checks alone do not enforce event vocabulary.

Upgrading the plugin fixes future writes; it does not rewrite existing session
artifacts. If a history still reports an unknown non-ignorable Kode record after
upgrading, repair that stored history once using the commands below. No Host
restart is needed for the offline repair; retry loading the history afterward.

For older Fast/shared-interaction metadata written without `ignorable`, run
`scripts/repair-plugin-records.py --home <dsh-home> --session-id <id>
--runtime-modules <released-node-modules> --node <node-24.22+>` to report first.
`--apply` requires the kernel writer lock, validates with the released reader,
backs up the original log and projection cache, and atomically replaces the log.
Only the two known optional Kode record types are admitted; their sequence,
timestamp, payload and all other events stay intact. Other unknown required
events still fail validation. Stop the owning session before applying repairs.


### Native executor reload and misplaced system heads

The native model adapter also rejects ordinary-loop `prepareCall` admission.
Configured restores can enter the released loop through `resumeWith`, bypassing
the factory wrappers. The rejection runs before the loop commits its system
prompt. Model discovery uses `resolveModel`, and the native driver dispatches
through `stream`. The direct-restore regression exercises the released loop,
checks that native execution never starts, and validates the resulting history.

A native CLI history does not contain the harness-owned protected system head.
During a Kode plugin reload its durable sessions must fail closed until their
native executor is available. The routing sentinel preserves this distinction
while allowing ordinary dsh sessions to keep using their official executor.

The inbox maintenance script also recognizes a late harness `system/message`
after proven native CLI history. It preserves the entire misplaced event as an
ignorable `plugin:kode/system-head-repair` record, retaining its sequence and
original prompt, and validates the full result with the released V4 reader.
It never rewrites normal protected system heads or unproven/foreign histories.
Repairs still require the writer lock, exact artifact/cache backup and atomic
replacement. Applying a repair does not replay any user input.


Run `node scripts/audit-history.js --home <dsh-home> --runtime-modules
<released-node_modules>` (Node 24.22+) for a read-only audit. It enumerates current
session folders every time, including conversations created since the last
scan, and validates released V4 envelopes, relationships, fork cuts and inbox
prefixes. It reports artifacts changing during a read and exits nonzero on
validation failures. It never repairs a log or replays a prompt.


Runtime delivery evidence uses a separate durable ledger. The dsh Host records a stable
message/input binding before queuing work, reports `queued` after persistence, and
reports `consumed` only after observing the corresponding persisted `user/message` event.
Recovery inspects recorded events without resubmitting the input. Missing evidence stays
unconfirmed. Existing PTY paths retain their approximate acceptance semantics. The execution Host mirrors observations to the sender only when both peers negotiate
`delivery_observations_v1`; durable acknowledgement cursors and idempotent batches recover
from lost replies. The query identifies the execution node and whether data is a remote
mirror. Missing evidence is not proof of non-execution. Cancellation is not yet implemented. Old backends without `delivery_tracking` retain their existing path.

### Input-scoped cancellation (incremental)

`kode_sessions_cancel_input(message_id)` requests cancellation of the caller's own message after a runtime input binding exists. `kode_sessions_cancellation_status(message_id)` reads the persisted result. These controls are separate from message receipt and task completion. A request is idempotent per message; the execution session polls controls without waiting for a model turn.

The Kode native driver removes only the matching queued input and flushes before reporting `queued_removed`. A sole active input may request abort, but reports `cancel_unconfirmed / stop_requested` until adapter-specific process termination evidence is implemented. Shared turns refuse the abort (`shared_turn`); unsupported runtimes report `runtime_unsupported`. Unrelated queued inputs remain intact. Lost queue-removal responses can be recovered from session splice evidence. Unknown inputs do not imply successful cancellation.

Remote requests require a mirrored input binding and previously authenticated `input_cancellation_v1` negotiation. The sender persists and periodically resends requests until the execution Host returns a durable result. Duplicate requests return the same result without re-enqueuing control; source/target identity and input binding are checked. A v1 reconnect disables new remote requests; existing pending controls remain pending until a compatible connection returns. The sender does not poll remote controls as local work even if session names coincide. Durable stop acknowledgements, pre-binding withdrawal, lease/attempt fencing and subprocess termination proofs remain pending. This is not the complete workflow cancellation contract.

Native RPC and ACP processes now share owned-process cleanup. On POSIX, cleanup signals their own process group, escalates TERM to KILL and waits at most five seconds for leader exit. The returned evidence distinguishes leader exit from descendant termination; it does not certify escaped descendants or external operations stopped. Windows cleanup reports leader-only scope. These observations do not yet change `cancel_unconfirmed` into a confirmed workflow cancellation.

Interrupted native turns append `kode/process_stop` evidence to the existing native-event audit and persist it on their binding. If a spawned leader has not exited or termination signalling fails, the binding is fenced (`stopBlocked`) across restart: new inputs remain queued and no new native turn is admitted. Busy ownership is held throughout cleanup. The fence requires explicit Host-owner reconciliation; it is never automatically cleared by a new message. Leader exit still does not certify descendant or external-operation termination, and the interrupted task remains uncertain.

Owner-only stop reconciliation uses JSON POST `/api/kode/session-stop-control` through the existing authenticated Host connection (including its owner-authenticated remote transport). Status body: `{"action":"status","session_id":"…"}`. Reconcile body: `{"action":"reconcile","session_id":"…","expected_fence_id":"…","processes_checked":true,"reason":"What was inspected and resolved","resume":false}`. Obtain the current fence ID from status after checking owned processes and external work. Reconciliation is a recorded human attestation, not an automatic observation or successful-task verdict. It rejects active cleanup and stale fence IDs; repeated requests do not duplicate the audit. `resume:true` explicitly wakes an already loaded session's queue; cold sessions are not silently opened. No model-side release tool is provided.

Model-facing message reads are bounded to 16 events / 8,192 conservative estimated token units for the entire JSON payload, with at most 1,024-code-point content previews. Until an executor-specific tokenizer is available, one serialized UTF-8 byte counts as one estimated unit; `token_budget` marks `accounting: serialized_utf8_bytes` and `exact_tokens: false`. This is a conservative fallback for byte-backed tokenizers, not actual provider usage and not a bound on surrounding prompt/tool framing. Full-message pages share this budget and the existing 4,096-code-point maximum; JSON escapes and metadata count. A first preview may shrink to fit, with its continuation offset adjusted; oversized metadata fails explicitly without advancing the cursor. Follow the returned cursor until an empty page (`may_have_more` is conservative); cursors never skip events omitted from the page. Automatic inbox delivery fits the complete followup JSON object (attribution, routing instructions and escaped text) within the same 8,192-unit estimate and a maximum 4,096-code-point preview. Its continuation offset is the actual retained code-point count. This bounds each input, not cumulative conversation context or repeated tool reads. Use `kode_sessions_message_read(message_id, offset)` and follow `next` until null for full content; offsets count Unicode code points. The underlying participant-authorized message endpoint retains the original text. Preview consumption proves only that preview entered the runtime, not that every byte was read. Truncated reply previews do not trigger the existing read-in-turn queue removal shortcut. The v1 backend event API keeps complete Message DTOs but caps aggregate stored event bytes per page at 256 KiB (always allowing a first event for progress).

`kode_sessions_lifecycle_read(after)` reads the new participant-scoped audit projection via `/api/v1/messaging/lifecycle-events`. Its cursor is separate from legacy message-event cursors. Kinds are `message` (status only, no full content), `delivery`, `remote_delivery` and `cancellation`. The backend returns up to 100 records / approximately 32 KiB. Host, JS MCP and Rust MCP expose the lifecycle tool only when advertised by the Hub, and project at most 16 records within the same 8192-unit serialized-byte estimate as message reads. Complete audit records are preserved; an individually oversized record fails without advancing the cursor. Follow cursor until an empty page. Source mutations and audit projection are transactional, including remote mirror imports. Older records are imported once and marked `historical:true`; their import sequence does not prove chronology across the former independent logs. New sequences order local commits, not distributed causality or task completion. This stream does not yet cover the future team/workflow/usage audit domains.

Messaging databases now use SQLite `user_version` migrations (current schema 3, also exposed as `messaging_schema_version` in node metadata). Before upgrading an existing lower-version store, the owning bridge creates a private, consistent SQLite snapshot named `*.pre-vN-<UUID>.sqlite`, including committed WAL contents. Upgrade DDL, lifecycle import and version advancement are transactional. Wrong-node and newer-schema stores are refused; reopening an up-to-date database does not repeat backups or historical import. This does not migrate or install anything until the new backend is explicitly run against a store. Retained backups contain the whole store and must retain owner-only access; never restore over an active bridge.

An initial home-Hub operation ledger is available at POST `/api/v1/messaging/operations` (`owner_session`, `request_key`, local `worker` address), GET/POST `/operations/:id`, and GET `/operations/:id/events?after=…` under the messaging API prefix. Commands carry `attempt`, `epoch`, `expected_revision` and a typed `action`: claim/renew (1–60 second lease), report, cancel, admin-only stop attestation, or next attempt after stopped. Preparation does not start a Worker. Lease expiry produces uncertain, revokes the epoch and never retries. Reports deduplicate by report ID and preserve late results without advancing state; reported is not completed. New attempts require a stopped prior attempt, with owner attestation when prior execution was uncertain. Events are scoped and paginated.

This ledger has an explicit owner opt-in for native turn and Host-mediated tool admission; automatic dispatch, CLI-internal side-effect fencing, remote operation routing and workflow evidence gates remain incomplete. Existing ordinary session messages retain their behavior. Do not treat these endpoints alone as enforcement against external Worker side effects; full managed execution still requires the adapter integration and capability gate.

Owner JSON POST `/api/kode/session-operation` attaches a prepared local operation using `session_id`, `operation_id` and `expected_revision`. It requires an idle loaded native session with an empty inbox and no unresolved assignment; attachment runs under the driver's maintenance exclusion and does not inject work. The response explicitly labels enforcement `turn_and_host_tools_only`. The next ordinary input acquires its lease with the session-scoped credential; active/uncertain operations are never blindly reacquired after a lost response/restart.

The bound turn renews conservatively and uses a monotonic local deadline armed independently of network calls. Revocation, identity changes, transport failure or deadline expiry abort the turn. Host-mediated tools and approval decisions recheck authority; steering, native slash commands, human shell shortcuts and continuation turns cannot share/bypass this binding. Ended executions persist `operationClosed`, leaving later input queued until explicit owner attachment to another prepared operation. Successful native return reports only `reported`, not workflow completion. This does not fence every CLI-internal action or already-issued external side effect and is not advertised as a fully compatible automatic Worker capability.

### Execution evidence (development)

Owner-authenticated `POST /api/kode/session-execution-evidence` accepts
`{"session_id":"<existing-native-session>"}`. It reads persisted metadata only,
including cold sessions; it never opens an executor or refreshes an account.
The response separates model/effort `selection` evidence from `quota`.
`acknowledged` means the executor accepted a request; `reported` means it returned
configuration values. Neither proves the provider's actual inference model.
Quota windows carry individual freshness (`reported`, `unknown`, `stale`, or
`reset_passed`). A notification for one bucket does not refresh other buckets.
Current observations are explicitly account-unbound and ineligible for dispatch;
they are not team budgets or an account-wide remaining balance. The endpoint does
not return profile environment variables, credentials, or session transcripts.

### Internal budget recovery (development)

The Hub budget API currently requires its existing administrator authorization;
these routes are not exposed as model spending tools. Amounts are integer units
chosen in the budget configuration, separate from provider quota observations.

- `GET /api/v1/messaging/budgets/:id` reports internal budget, reserved/spent,
  estimated charges and signed available amount, labelled `团队预算`.
- `GET /api/v1/messaging/budget-reservations/:id` reads the current reservation
  and `billing_status`; pending reconciliation is not a refund or task completion.
- `GET /api/v1/messaging/budget-reservations/:id/settlements/:event` retrieves
  an immutable settlement receipt after a lost response. Its result is the state
  at that settlement; query the reservation for current state.
- `GET /api/v1/messaging/budgets/:id/events?after=<sequence>` pages audit events.
- `GET /api/v1/messaging/budgets/:id/reservations?after=<reservation-id>` pages
  reservations in ID order. Follow the returned cursor until an empty page;
  `may_have_more` is conservative. Queries never reserve, settle or release funds.

Budget-backed operation leases are opt-in primitives pending team/assignment
policy integration. A finalized budget reservation does not prove an operation
stopped, and an expired/cancelled operation does not automatically refund it.

Internal pricing is configured through administrator-only `price-versions` routes.
Each immutable version specifies an exact model ID, accounting unit, and integer
rates per million input, cached-input and output tokens. Bind its ID through
`POST /api/v1/messaging/budget-reservations/:id/pricing` before billing begins.
`POST /api/v1/messaging/metered-usage` accepts a globally unique event ID,
reservation ID/revision and cumulative input/cached-input/output counts. Input
includes cached tokens; output includes all output charged under the configured
rate. The Hub rounds the cumulative estimate once and writes usage plus settlement
atomically. `GET /api/v1/messaging/metered-usage/:event` recovers the receipt.
These charges remain estimates with remaining holds until explicit reported or
manual reconciliation. This API currently requires trusted administrator evidence;
automatic native usage collection is not yet connected.

Internal price versions optionally set `model_policy: "requested_model"` to
explicitly allow estimates against the requested model. The default retains the
trusted administrator's model assertion; it does not imply runtime verification.
Requested-model usage must include `attribution: {kind: "requested_model",
rerouted: false, cache_write_input_tokens: 0}` and match the frozen price model.
Rerouted work or unresolved cache-write pricing cannot use this policy. Receipts
preserve attribution and remain estimated/nonfinal, never provider invoices.
The native evidence conversion helper does not itself submit ledger mutations;
durable attempt-scoped automatic submission remains pending.

Budget-required managed native operations now pin their attempt's reservation and
price before opening the executor. Admin-only
`GET /api/v1/messaging/operations/:id/budget?attempt=N` returns this accounting
context. Missing pricing or a previously charged untracked reservation requires
reconciliation before starting; ordinary unbudgeted sessions retain their behavior.
Native usage is persisted in an attempt-scoped Host outbox, then sent with a frozen
revision and event ID. Recovery first looks up the exact usage receipt, so a lost
response cannot cause a new debit. New cumulative observations coalesce while an
older immutable command is in flight. Unknown evidence and concurrent ledger edits
remain pending reconciliation; replay never invents a new revision to bypass them.
Owner execution-evidence exposes accounting status and the last estimated receipt.
A bounded backlog fences new accounting contexts instead of dropping unresolved
records. Completed local tails may be trimmed; Hub receipts/audit remain durable.
This currently meters supported Codex usage with explicitly configured internal
requested-model prices. It does not collect final supplier invoices, meter all
executors, enforce future team grants, or verify production provider charges.

Remote operation leases use negotiated `operation_leases_v1` on the
existing authenticated Hub link. A Host owner can attach an idle native session
with `home_node` in `/api/kode/session-operation`; the worker's scoped backend
client routes reads/claims/renewals/reports through
`POST /api/v1/messaging/operation-relay/:home_node`. The home ledger verifies both
peer node and assigned worker session. Owner cancellation and human stop
attestation are never delegated to this worker channel. Each transport request
is sent at most once, including reconnects; a lost response is uncertain and must
be inspected on the home ledger, not blindly repeated. Existing report IDs still
deduplicate in the durable ledger. Old peers explicitly reject the capability.
Remote budget-required runtime attachment additionally requires the separate
`operation_accounting_v1` path described below; the lease relay itself grants no
remote administrator or quota access.

The integration harness includes actual spawned native fixture tests across two
isolated loopback Hubs: home cancellation, SIGSTOP/SIGCONT pause, and SIGKILL plus
restart from the same ledger. These verify local process-stop evidence, refusal
to replay the old turn and home-side expiry fencing. The worker deadline starts
before its claim reaches home, so home can briefly retain an active lease after
the worker has conservatively stopped; eventual expiry is tested independently.
This proves the fixture/transport behavior, not provider execution or escaped
child-process termination. All fault signals target harness-owned processes.


Remote internal estimates use separately negotiated `operation_accounting_v1`.
Only the Host administrator can call
`POST /api/v1/messaging/operation-accounting-relay/:home_node`; session principals
are rejected on both this endpoint and attempts to smuggle accounting through the
worker lease relay. The authenticated execution peer may read its assigned
attempt's frozen accounting context, submit requested-model usage, and recover
receipts for that exact reservation. Home rejects foreign attempts/reservations,
foreign receipts and administrator-attested usage. No budget/price mutation or
final invoice settlement is exposed. The durable Host outbox pins home identity;
recovery always returns to that home ledger, including after either side restarts.

Budget-required native admission now checks the resolved protocol's usage collector,
a trustworthy pre-turn baseline, explicit automatic internal-price policy and exact
selected-model/price match before claiming an operation. A cold resumed native
thread has no attributable baseline and requires a fresh Worker; an already-live
thread may retain its observed baseline. Unsupported collectors are not treated
as zero-cost resources. Decisions are persisted and audited as
`kode/accounting_admission`, exposed through owner execution-evidence.
If a turn ends without attributable final usage (including rerouting or unresolved
cache costs), it cannot report ready: the local outcome is uncertain and its
reservation remains for reconciliation. This does not promise future provider
telemetry, support all adapters, or enforce supplier quota admission yet.

Resource-constrained operations opt in with `resource_required: true` at creation
(the flag is immutable for that request key). Admin attaches one policy per attempt
through `POST /api/v1/messaging/operations/:id/resource`, with attempt/revision and
`policy: {host,profile,account_id,account_epoch,binding_revision,limit_ids,
unknown_quota}`. `unknown_quota` is `require_fresh` or `team_budget`; the latter
requires `budget_required: true` and the same claim transaction still checks the
actual budget reservation. This opt-in is a foundation for future mandatory team
grants; it does not retroactively constrain ordinary legacy sessions.

Admin `POST /api/v1/messaging/resource-admission` evaluates that policy without
reserving or executing. `allowed` describes only the resource predicate, not a
complete dispatch permission; `requires_team_budget` signals the additional budget
constraint. Claims/renewals evaluate account epoch, binding revision, configured
limit IDs and sample freshness in the ledger transaction. Known exhaustion remains
blocking past sample TTL until reset or newer evidence; reset alone is unknown.
Fresh leases are capped at earliest sample expiry/reset and budget period boundary.
Assignment and successful decision are audited. Workers cannot attach or change
policy. The current native lease adapter verifies the assigned profile and aborts
on resource revocation. Provider-wide coverage, all executor capability gates and
mandatory team dispatch policy still remain to be implemented.

Resource-required claims now use `claim_resource` and renewals `renew_resource`,
with `resource: {profile,account_epoch,binding_revision}` alongside `lease_ms`.
The Host takes profile identity from its actual session binding and the versions
from the frozen operation policy. Home rejects legacy claim/renew commands for
these operations and rejects missing/mismatched confirmation without changing
revision. Ordinary unconstrained operations keep the original commands. Remote
resource commands require separately negotiated `operation_resources_v1`, so old
peers never receive an unknown action. This confirms adapter protocol support and
policy identity; it is not proof of provider identity or arbitrary CLI tool fencing.

The trusted remote accounting envelope additionally supports separately negotiated
`operation_quota_v1`: `resource_context`, `quota {sample}` and `invalidate_quota`.
Home reads the exact attempt's immutable resource policy; samples must match its
Host/profile/account/epoch/revision and then pass ordinary quota freshness and
binding validation. Invalidation targets only that frozen binding revision, with
idempotent acknowledgement; an old assignment cannot revoke a newer binding.
Worker credentials cannot access the Host-only relay. Envelopes are limited to
64 KiB before queueing. Quota propagation does not grant budget or price authority.

`prepareRemoteQuotaCollector` pins this scope and shares the allowlisted sample
normalizer with the local collector. Its caller must persist account-change fences
before publication/recreation. The helper/API are tested with idle native fixture
telemetry. Native runtimes bound to remote managed operations now select the home-scoped collector and persist account-change fences before publication. A bounded replay loop retries frozen operation attempts after restart; acknowledged fences remain effective locally and never mix revisions from different homes. On a failed invalidation, replay reads the frozen attempt resource context and only reconciles an obsolete fence when the authoritative binding is newer or already inactive; it never invalidates the newer binding. The runtime callback path is covered with a spawned native protocol fixture and two isolated Hubs, including idle telemetry, durable fencing before transport, and replay after a lost committed response. This does not establish live provider or all-executor coverage. Quota events may be archived without a turn while idle; tool lifecycle events still require an open step.

Quota invalidation state is included in the owner-only session execution evidence as `quota_fences`: local recorded/reconciled revisions and allowlisted remote home/profile/attempt records. Clearing an otherwise unused session binding refuses when any quota fence exists. Reconciled remote history compacts to the highest revision per home/profile within each binding; pending attempts are never discarded. This bounds acknowledged history per resource scope, not the number of unresolved attempts or registered resources.

### Registered Host resource coverage

Owner-only `GET /api/kode/resource-coverage?limit=25&after=...` inventories configured profiles and configuration versions retained by session bindings, including idle, unavailable-runtime and retired configurations. It also includes registered and declared dormant official-loop provider routes using cached public metadata; native routes are not duplicated. Pagination returns `next_cursor` (URL-encode it for the next request). The projection reads local Hub account binding and quota snapshots; it never starts a runtime, reads provider credentials or calls a model. It distinguishes unbound, unsupported source, unavailable authority/binding, missing sample, partial, stale, reset-passed, reported and exhausted states. Snapshot/binding revisions must agree.

The response deliberately reports `scope: host_execution_resources` and `eligible_for_dispatch: false`: coverage is not an admission decision. Remote home identities and up to 16 registered assignment contexts per profile version are projected through the existing authorized relay, with explicit truncation. Each includes current authoritative quota and whether the original assignment binding is still current. Missing snapshot support, offline authority and scope mismatch are explicit. Remote resources without a registered assignment and official-loop model/account/usage coverage remain gaps. Team budget details require assignment context and are not synthesized from usage or quota. Profile environment, executable arguments and other configuration payloads are excluded.

Official provider rows use `resource_kind: official_loop_provider`, `route_registered` and explicit `model_catalog_status: not_collected`. They do not imply usable credentials, a known balance, integrated usage metering or automatic dispatch permission. `official_directory_status` distinguishes complete registered/declared enumeration, registered-only compatibility and an unavailable directory. Coverage does not call `listModels`, export provider settings or start discovery.

The Hub now exposes trusted local official-call collector receipts/events under `/api/v1/messaging/official-calls`. Ordinary Worker credentials cannot read or write them. Exact retries recover the same evidence; an interrupted call remains uncertain across Hub restart. This API is not yet connected to the official-loop middleware or pricing settlement, and remote call collection remains unsupported.

`OfficialCallOutbox` now connects call-meter hooks to the local collector API with persisted begin identity and ordered evidence. An ambiguous begin refuses inference; startup recovery only reads receipts and replays evidence, never restarts a model call. Missing receipts remain pending. Completed local evidence tails are bounded, unresolved calls are retained with a 128-call admission cap. Evidence acknowledgement is explicitly pending accounting, not a billing settlement. The Host does not yet install this path for production official-loop execution; lease policy, pricing and remote transport remain required. Agent profile state writes now sync the temporary file, atomically rename it and sync the containing directory before resolving.

Budgeted official-call evidence now drives internal estimated debit using the attempt's frozen requested-model price. Distinct calls aggregate once; duplicate event receipts do not re-debit. Unknown final counters preserve known charges and block the next budgeted call in that attempt until reconciliation. These estimates remain separate from provider balances and finalized invoices. The production official-loop policy/lease adapter and remote collector path are still pending.

`streamLeasedOfficialCall` is the controlled local official-call entry. It uses the public LLM stream pipeline with a cloned request carrying the combined caller/operation abort signal, checks authority before and after begin admission, and persists an uncertain interruption if authority disappears before dispatch. It never reports the enclosing operation complete. Actual Cordis/LlmRuntime plus real Hub tests verify cancellation while a no-network adapter is blocked. This entry is not a blanket interceptor for arbitrary official agents, tool calls, auxiliary loops or ACP child processes; production team runtime installation is still required.

Remote controlled official calls use `OfficialCallOutbox` with a managed operation's
`home_node`. Begin, evidence and recovery reads travel through the administrator-only
operation accounting relay, gated by `operation_official_calls_v1`. Each outbox row
persists its home, so reopening the collector reconciles with the original authority.
Recovery never invokes a provider. Calls from session credentials, another operation
or another attempt are rejected. This supports the controlled call entry; production
session ownership, tool boundaries and ACP child coverage remain separate work.

`kodeAgents.officialExecution.open(agent, { tools, signal })` is the Host-owned
entry for an explicitly managed `dsh` profile. It restores pending call evidence
at service startup, claims the bound operation lease and exposes `stream`, `execute`,
`finish`, and `dispose`. Tool names must be supplied explicitly (default none).
Stream advertisements and actual tool requests are checked against that list;
Agent object replacement, profile revision or operation binding changes fence
subsequent execution. Model calls, tools and finish are serialized by rejecting
concurrent actions. Disposing aborts the lease without claiming completion.
The Host registers these explicitly managed official Agents on lease acquisition.

This service is intended for the upcoming coordinator/Worker loop. Ordinary dsh
loops do not automatically use it, ACP subprocesses are not intercepted, and the
caller-provided tool list is not yet an authoritative TeamGrant. Tool-level audit
and mandatory workflow/permission wiring remain required before product acceptance.

Controlled official tool execution now persists a bounded execution-Host journal
before calling the public tool service. Stable call IDs cannot be replayed, even
after restart; unfinished records become `uncertain`. Unresolved tool outcomes
prevent the controlled entry from reporting the operation complete. The owner-only
execution evidence endpoint exposes tool identity, task/attempt, timestamps and
status, without raw arguments, results or error messages. `returned` means the tool
returned under a valid lease; it is not independent verification of its effects.
These records explicitly remain `home_reconciled: false`: archival/home-Hub relay
and reconciliation authorization are still required. The 256-record limit rejects
new execution rather than silently deleting audit history.

Local controlled-tool journals now submit terminal metadata to the home Hub's
operation audit stream. Successful immutable receipts set `home_reconciled` and
`home_sequence`; lost responses leave the durable entry pending for recovery or
the next terminal flush. No tool is re-executed during reconciliation. Remote-home
rows use the tool-specific relay capability described below.
The journal retains records after home acknowledgement; archive/retention and
owner-authorized resolution of uncertain effects are still pending.

Remote tool journals now route immutable terminal evidence through the trusted
Host accounting relay, gated by `operation_tool_evidence_v1`. The original home
node is preserved on disk. Startup recovery or the next terminal flush retries
pending evidence; home acknowledgement updates the local queue without copying
the authoritative audit ledger into the execution Hub. Older peers leave evidence
pending, and ordinary Worker credentials cannot submit through either relay path.

The controlled execution entry now refuses subsequent model/tool/finish actions
while prior tool evidence is unacknowledged or uncertain. A home administrator may
record a separate adjudication with an evidence reference through `tool-resolutions`.
Journal receipt refresh observes this both locally and through the remote evidence
relay. Only `verified_applied` clears the tool-outcome gate; `verified_not_applied`
and `abandoned` retain the need for explicit task recovery. Every original call ID
remains non-replayable, and every action still requires a current lease. No user UI
for adjudication is delivered yet.

The tool journal compacts once it reaches 128 entries, retaining at least 32 recent
rows. Only home-acknowledged returned or verified-applied records are eligible;
unacknowledged/uncertain records continue counting toward the 256-entry admission
limit. Each eligible row is first written as a private immutable file beside the
profile store, with file and directory sync, then removed from the active profile
transaction. Home audit history is retained. Archived call IDs are checked before
admission, so compaction never enables replay. Shared-registry bindings retain the
archive identity; a Host using a different or missing archive fails closed.

The owner evidence view exposes archived count without the filesystem path. Detailed
history remains available through home operation events. Archive disk usage is not
bounded or automatically pruned; deleting it is unsupported because it also stores
replay guards. Filesystem fault tests cover a queue write failing after archive
creation, retry/reopen, immutable ID rejection and unavailable archive refusal;
they do not claim physical power-loss testing.

The backend now exposes an administrator-owned TeamGrant registry with immutable
revisions, explicit expiry/revocation and scope checks. It distinguishes read,
workspace-write, commit, push, merge, deploy, external-message and delegate
capabilities; these are not inferred from a permission-mode string. Policies also
name exact Host/workspace/root targets, tools, network access and budget IDs.
This registry is not yet wired as mandatory admission for official/native Workers;
operation binding and execution-Host enforcement must precede team activation.

Grant-required operations now refuse claim until an administrator binds an exact
TeamGrant revision/scope. Home checks that grant on claim, renewal and official-call
admission; leases cannot outlive grant expiry. The dsh lease controller aborts when
home reports grant_available=false. Revoked reports remain audit-only, and owner
cancel/stop controls remain usable. New attempts require a new binding. Team
creation must require this mode; existing legacy operations are not silently
converted. Concrete tool, workspace, network and budget intersections are still
needed for full team enforcement.

Grant-required budgeted operations now check the actual reservation's budget IDs
against the pinned scope, including team ownership. Both grant-first and
budget-first attachment orders reject mismatches transactionally. Explicit shared
budgets remain usable; another team's budget is not accepted merely because its
ID appears in the requested scope. Tool/workspace/network enforcement remains
separate work.

Local grant-required `officialExecution` now reads the authoritative attempt scope
and checks the registered workspace ID, execution Host, canonical root and actual
session cwd before execution. A symlink resolving the cwd outside the root rejects.
Grant/workspace/policy changes abort the controlled lease. Remote official execution
uses the separately negotiated scoped grant projection described below.

Host plugins can register explicit policies through `kodeOfficialToolPolicies`:
`register(name, { capabilities, network, authorize(request, { root, scope }) })`.
Registration returns a disposer. Capabilities must fit the frozen scope, network
use requires permission, and authorize must return true for the concrete arguments.
Unknown tools, changed registrations and missing argument authorization reject.
There is no heuristic tool-name mapping or permissive fallback. These are trusted
plugin contracts; each plugin still must enforce its actual file/network effects.
This is not an OS sandbox, and native CLI descendants/ACP children remain outside
this controlled official-tool boundary. Built-in general-purpose shell policies
are not automatically granted.

Remote `officialExecution` now obtains grant context from the persisted home through
`operation_grants_v1`. All workspace realpath and registered tool-policy checks run
on the execution Host, while current grant/revocation decisions come from home.
No grant replica or administrator grant-write access is given to the Worker.
Missing capability, foreign attempt/Worker and unavailable home fail closed.
The same controlled entry routes model and tool evidence to home; a home revocation
aborts its lease and prevents subsequent execution.

Grant-required lease admission now requires a trusted Host execution-enforcement
signal. Production Host supplies it only for an exact Agent/operation owned by the
controlled OfficialExecution entry after its grant guard succeeds; profile metadata
or a caller-selected model cannot enable it. Ordinary native CLI drivers without
internal-tool enforcement are rejected before claim/runtime startup, with
`executionAdmission.reason=grant_enforcement_unsupported` visible to the owner.
Legacy non-grant sessions retain their behavior. Resource inventory marks native
grant support according to the execution route. Controlled Codex workflow Workers
use `managedInference`, Home admission, bounded native decisions and trusted Host
tools. Team eligibility also requires the complete resource and authority checks.

`kode_sessions_diagnostics` is a session-bound cold diagnostic tool: it reports
local durable incoming/outgoing status counts, bounded message metadata samples,
delivery-evidence phase counts and pending cancellations. It does not expose
message content or probe/wake runtimes or peers. Queue emptiness must not be
interpreted as runtime health. Use the returned message IDs with existing
message delivery, cancellation and lifecycle tools for investigation.

Model/command discovery uses a separate cache revision from execution authority:
name, origin and role-assignment metadata do not trigger a new CLI probe. Launch
settings, environment, unknown future fields, working directory and model hint
remain part of discovery identity. Ordinary profile saves retain compatible cached
results; explicit model refresh and runtime plugin registration/removal invalidate
them. Full profile revisions used by execution/accounting guards remain unchanged.

Native selection evidence is stamped by the Host with input IDs, the immutable
profile revision and the bound operation identity before recording and flushing.
ACP configuration mismatch emits rejected evidence before any session/prompt;
missing confirmation remains unverifiable rather than being labeled a known
mismatch. The adapter persists this evidence, rejects continuation, and never
reports successful operation completion. Existing stop/replay fences still apply
after reopening. Evidence describes executor configuration, not independently
verified inference. Latest owner-readable binding evidence and native session
history are local records; home-Hub selection reconciliation remains separate.

Managed native turns now persist selection observations in a bounded Host outbox
and reconcile them with the local or remote home Hub. Pending records survive
restart and retry only the evidence request. Complete receipt identity and the
Hub rejection decision must match before reconciliation is accepted; current
attempt failures cannot be cleared by a later positive observation. Owner
execution evidence exposes `selection_reconciliation` without opening a runtime.
The installed runtime service starts/stops background retries with its lifecycle.
ACP configuration evidence gates session/prompt; Codex evidence follows turn/start
and cannot prove that inference had not begun. Request acknowledgement without
reported values remains pending; strict inference confirmation is still pending.
New selection observations await their own receipt rather than an unrelated
background replay batch. Concurrent sends of the same record share one request;
shutdown aborts and drains both foreground and background reconciliation. Real
ACP-process tests cover the successful managed prompt/report path and lost
receipt refusal before prompt. Recovery acknowledges evidence only and never
reports the cancelled/nonexecuted operation as successful.
Strict selection admission runs before lease claim in the current Host service.
Unsupported scope/request mismatch keeps the home operation prepared, without
starting a native executor. The persisted `selection_admission` owner projection
explains rejection; capable means only that configuration verification can be
attempted. It does not mean actual values are confirmed. Lease renewal/read checks
reject a changed home policy. Local and remote ACP paths use the same check.
For strict operations, claim/renew also transmit the exact frozen selection_ack.
Home rejects missing/different acknowledgements; old clients cannot silently
claim a strict task. This acknowledgement grants no evidence exemption: actual
reported selection is still required for strict successful reports. Commands
with this field are not relayed to peers lacking selection capability.
Codex model/rerouted notifications now produce selection evidence only when both
threadId and turnId exactly identify the active turn. A different known target
model rejects the managed turn and reconciles that evidence with home. Missing
values stay unverifiable; effort is never inferred from routing. These are runtime
routing/configuration reports after turn/start, not provider-attested inference
values or pre-inference validation. Foreign/historical/unscoped notifications do
not change current-turn selection or usage attribution.
Standalone session MCP now matches Host event pagination and exposes
kode_sessions_message_read. Long previews carry the continuation tool/offset;
follow event cursors until empty and message next offsets until null. GUI's Rust
session MCP follows the same limits. Reading a preview is not a consumed receipt.

### Creation recovery identity

The creator persists `creating` before invoking the controller. A retry resolves
only the original session ID; it never repeats controller creation, which can
otherwise allocate a replacement when the requested session cannot be reused.
Recovery requires a readable blank session history before configuration or task
submission. An unresolved identity or an already active session stays uncertain.
Late create responses cannot rewind the durable stage, and concurrent creators
cannot submit the initial task twice. Frozen plans compare structural content,
so JSON key ordering after Hub persistence does not falsely signal a change.

`session-create-durable.test.js` uses a real Hub across SIGKILL/restart with a
controlled session-controller boundary. It proves persistence and retry behavior,
not full installed dsh controller/runtime recovery.

Recovery also verifies the original session's cwd and archive state. If controller
creation succeeded but workspace attachment failed, it restores membership using
the Workspace API before returning ready or submitting a task. Missing membership
metadata, a different owning workspace, or unconfirmed attachment stops recovery.
`session-create-controller.test.js` exercises the installed official controller,
SessionStore, AgentRegistry and native factory with controlled persistence and
workspace services. It reproduces the post-creation attachment failure without
inference. Whole-Host restart and real workspace-storage recovery remain separate
acceptance requirements.

Native factory publication waits for the persistence handle's flush barrier after
writing the header and setup events. Session creation storage may otherwise defer
materialization until flush. A failed flush releases the writer without publishing
an Agent or Session; successful creation and resume expose only that durable prefix.
Native factory tests cover delayed and failed flushes and exact-identity restoration
in rebuilt Host services using a controlled disk persistence adapter. This does not
claim process-kill testing of the installed production persistence backend.

Standalone and desktop session MCP now expose delivery status and input
cancellation/status alongside send/read. Cancellation tools are advertised only
when supported by the Hub; cancellation of another sender's message is denied.
Use persisted cancellation status to distinguish requested, queue removal and
unconfirmed stopping. Never interpret a request receipt as confirmed termination.

Host cancellation polling has its own loop, separate from delivery recovery and
receipt posting. A slow delivery request cannot by itself delay cancellation.
Shutdown aborts and drains both loops. This separation does not bypass runtime
persistence or turn an unconfirmed stop request into a confirmed result.

`native-persistence-crash.test.js` uses the official
`@deepseek-ai/dsh-session-persistence-jsonl` backend in disposable child Hosts,
including plain and default Zstandard storage. It SIGKILLs and recreates the Host
around queued-input and cancellation persistence. No user configuration or model
credentials are loaded, and the fixture prevents inference.

Use a Node >=24.9 runtime able to load the official native file-lock addon. A
hardened application-bundled Node may reject it because of signing Team IDs;
`KODE_TEST_HOST_NODE=/path/to/ordinary/node` selects a separate executable for these
owned child Hosts without changing the application or system signing settings.

`collaboration-host-crash.test.js` combines actual Host tools, official session
controller/query services, Kode workspace storage, native driver and official zstd
persistence against an isolated Hub. It discards an assignment response after commit,
kills both Host and Hub, resumes the original Worker, and checks that later persisted
cancellation survives another crash without requeueing work. Auxiliary title/image
services are fixtures and inference is fenced. It checks automatic cold activation
before any explicit resolve/retry, and that terminal cancellation does not wake a
cold Worker. Snapshot inspection afterward explicitly opens the saved session.

`remote-collaboration-host-crash.test.js` runs two such child Hosts against paired
isolated Hubs. Production owner HTTP creation/lookup handlers and remote client
helpers are shared with the desktop portal; only SSH tunneling and owner admission
transport are substituted by loopback HTTP and a generated fixture cookie. It drops
a remote creation response after commit, queries/retries the same identity, checks
Hub-relayed queued evidence, SIGKILLs all four processes, checks automatic recovery,
and verifies remote cancellation remains durable after a second four-process crash.
This proves these application protocol/storage boundaries, not SSH connectivity,
production authentication, paid inference, or full workflow completion.

Runtime delivery confirmation requires a matching queue or consumption event.
If the executor cannot expose readable history, successful followup alone returns
an `uncertain` message receipt explicitly describing approximate submission;
the delivery binding stays `prepared`. It does not claim durable queue or model
consumption. When history becomes readable, recovery can publish flushed evidence
for that original input without resending it. A readable log missing that input
also leaves the outcome uncertain. This distinction applies to legacy/custom
runtimes as well as temporary loss of their observation capability.

Owners can query `GET /api/v1/messaging/workbench/communication-health` on their
Hub for read-only transport observations. Session/Agent credentials cannot call
this endpoint. It reports responding Hub plus per-peer connected/stale/not_connected
states, protocol versions and recent receive timestamps without disclosing URLs,
SSH settings or link secrets. It uses existing authenticated connections and never
wakes a Worker or sends a test task. Connected is not runtime readiness; absence of
a connection does not distinguish network failure, handshake failure or shutdown.
The existing session diagnostics endpoint still reports durable queue/evidence
state and deliberately does not infer runtime liveness.

Capability knowledge can now be saved as immutable home-Hub revisions through the
owner-only `/api/v1/messaging/capability-profiles` API (see remote protocol). It records
user/documented/measured soft evaluations with evidence references, confidence, expiry
and protected pins. These records do not establish executor support or live prices.
Builder configuration and resource ranking integration are still pending.

Home-Hub owner API `POST /api/v1/messaging/resources/rank` now recommends candidates
from exact capability revisions after account/quota and quality checks. It returns
exclusions and score evidence; preferred status cannot bypass these checks. Missing
cost gets no preference credit and is not presented as a zero price. Recommendations
remain `eligible_for_dispatch:false` until activated team, executor, permission,
independence, metering and atomic reservation checks are integrated at dispatch.

`src/provider-balances.js` adds explicit-poll DeepSeek balance and OpenRouter key/credits
connectors. A trusted Host must supply the authorized HTTP transport; the module does
not load credentials or activate itself. Monetary scopes and decimal values remain
separate from Codex percentage windows and platform team budgets. Binding, durable
monetary snapshots and execution admission integration remain pending; fixture HTTP
checks do not establish live provider connectivity.

Home-Hub `/api/v1/messaging/monetary-quota` now durably stores scoped monetary facts,
collection failures and the last successful observation, fenced by account epoch and
resource binding revision. `prepareMonetaryCollector` pins that authority before querying
and retries an unacknowledged publication before another query. Resource coverage exposes
this under `provider_monetary`, independently of Codex percentage-window data. Automatic
collector activation and scope-aware dispatch admission remain pending; collecting a
balance does not itself authorize execution.

Resource admission now accepts optional monetary source/currency requirements. The same
Hub evaluator checks them for recommendation and operation leases; fresh positive facts
do not replace budget reservations. Explicit exhaustion and auth/payment/rate-limit
failures survive missing/partial samples and cannot be bypassed by team-budget fallback.
Free-model request limits are selected explicitly, so they do not block paid-model work.
Automatic source-policy configuration and real provider activation remain pending.

Assigned remote Hosts can use `prepareRemoteMonetaryCollector` to publish through the
home Hub's scoped accounting relay. New monetary actions require their own negotiated
capability; old peers fail explicitly. Source/attempt/resource identity is checked on
home, ordinary Worker tokens cannot publish, and only home stores the authoritative
monetary facts. This is not yet automatic provider activation or unassigned idle polling.

Trusted Host plugins can now register an explicit source through
`ctx.kodeMonetaryCollectors.register({ profile, source, authorizedFetch, ttlMs, remote })`.
`remote`, when present, is `{home_node,id,attempt,session}` from an existing assigned
operation. The registration returns an async disposer. The registry is installed with
the Kode runtime only when its home identity is available and shuts down with that runtime.
No registrations are inferred from model names, profiles or account settings. The public
dsh LLM service examined in 0.2.1-rc.2 has no generic authenticated HTTP query seam; the
trusted provider plugin must supply its own controlled request function and dispose the
registration when credential identity changes. This integration does not read credentials
or automatically bind the separate DeepSeek Platform-wallet service to API balances.

The registry polls idle sources, deduplicates home/profile/source targets, bounds active
registrations, isolates slow sources, and aborts transport on removal/shutdown. Binding
failure needs explicit re-registration; uncertain publication retries the same pinned
sample. Coverage includes sanitized collector status, never transport functions or errors.
Live provider transport registration and user-account acceptance are still pending.

Managed official agents now have a process-local entry guard on the public dsh LLM/tool
waterfalls. Direct managed calls outside `OfficialExecution` are rejected; ordinary
sessions keep their normal path. Stream permits belong to one exact options object;
tool permits use async-local authority and bind Agent identity, call ID, name and argument
snapshot, then recheck the lease before dispatch. Permits are neither serialized nor
model-visible. Closing execution keeps the denial fence until the owning Cordis scope
is disposed. Concrete trusted tool implementations and the full controlled official-loop
adapter still need integration; this guard prevents fallback to an uncontrolled path.

Trusted official tool policies must now include the exact registered implementation:
`implementation: agent.ctx.tools.get(name, agent)`. Opening a grant-bound tool set rejects
missing implementation lookup or mismatched definitions, and every ownership/argument
check verifies the definition has not been replaced or shadowed. Name-only authorization
is insufficient. Real ToolRuntime regression coverage now includes prepared-argument
changes, nested dispatch, permission revocation and same-name implementation replacement.
This does not yet supply production Coordinator tools or a complete official loop.

Official tool results with `isError: true` are recorded as uncertain and published to
the home Hub, just like thrown execution failures. A normalized error does not prove
that no side effect happened. Further calls and completion require explicit outcome
reconciliation; automatic retry is not authorized. This conservatively includes errors
that may have occurred before a side effect, until stronger evidence is available.

Controlled official execution exposes `prepareCall(config, signal, configure)` for the
AgentLoop preparation contract. It preserves resolved controls, metadata and the exact
upstream adapter registration, then dispatches its one-use handle through ownership,
lease and call-accounting gates. Preparation cancellation remains attached to dispatch.
This API is tested with actual LlmRuntime and Hub; wiring the full AgentLoop scheduler
and production tools remains pending.

`OfficialExecution.loopServices()` now supplies an isolated service view for the actual
upstream AgentLoop. Install its `llm` and `tools` in a child Cordis isolation before
mounting that loop. It resolves the active run by exact initiating Agent identity;
missing/disposed ownership fails closed. Root services and ordinary loops are unchanged.
Tool calls are exclusive: the public ToolRuntime execute pipeline completes pre/body/
post/content finalization before the loop commits the result. The scheduler bridge does
not repeat finalization. Its symbol must come from AgentLoop's own dependency instance;
this is an internal upstream contract guarded by actual-loop compatibility tests, not a
stable plugin API promise. Parallel official tools are not enabled by this adapter.

Actual AgentLoop + LlmRuntime + ToolRuntime + session registries + Hub tests now cover a
model/tool/model turn with a grant-bound workspace, two ordered tools, call/tool evidence,
and a failing post-execute hook that prevents later tools/inference/completion. Responses
and tools are controlled fixtures, with no live inference. Coordinator/Builder lifecycle
and production tool registration still need to consume this service view.

The runtime now exposes `kodeAgents.officialLoops`, a lazy `OfficialLoopHost`. Its
`create(options, { tools })` accepts the upstream creation options (including scoped
setup) only for a pre-bound managed official operation, and returns `{ agent, run,
dispose }`. It mounts a separate official loop factory over the shared live registry;
the ordinary registry factory is not replaced. Duplicate live/pending identities are
rejected. Admission failure/cancellation disposes the new handle; close aborts pending
creation, drains owned handles and releases the loop. No inference starts just by
mounting the service. Callers must not treat live-handle cleanup as deletion of persisted
history: crash recovery integration and Coordinator/Builder provisioning remain pending.

`officialLoops.resume(options, { tools })` restores a persisted upstream session under
an explicitly assigned managed operation. Both create and resume now acquire controlled
execution at the registry announcement boundary, before serial creation listeners can
release queued work. Failed announcement unwinds that run with the factory transaction.
Resume does not reclaim an old active lease or invent a new attempt: the caller supplies
an admitted assignment and explicit provider/model options. Actual zstd persistence
coverage restores prior model/tool history, queues input during resume announcement and
verifies no old tool effects repeat. This verifies orderly release/reload; SIGKILL recovery
of this official lifecycle remains separate acceptance work.

Official lifecycle crash coverage now also SIGKILLs an owned native-runtime process
inside a real grant-bound tool after its file side effect and session flush. A new process
opens the same journal and zstd session storage, changes the started tool to uncertain,
and publishes acknowledged home evidence. It rejects resume under the old active lease,
performs no new model/tool calls, and leaves the effect count at one. This verifies safe
refusal and recovery evidence, not automatic continuation after uncertain side effects;
explicit reconciliation/new assignment remains necessary.

`kodeAgents.mountOfficialResourceTools(agentCtx, agent, policy)` can be used in controlled
Host setup to register two scoped read-only tools: `kode_resources_coverage` and
`kode_resources_rank`. Owner policy fixes local profile IDs and ranking candidates,
revision references, quality floors and weights. Model arguments only choose coverage
pagination or task tag; unknown argument fields fail the grant check. Configuration is
copied at mount. Coverage reads only selected local profiles and strips other session/
remote-assignment detail; it does not discover remote resources or credentials. Ranking
uses the actual home Hub and remains advisory (`eligible_for_dispatch: false`).

Trusted policies now support per-Agent identity in addition to legacy global policies,
so multiple teams can have same-named tools with different definitions/scopes. The loop
service view exposes a scope-preserving registration accessor for trusted Host setup.
Linked runtime packages must use compatible scope identities; tests use the ToolRuntime
instance belonging to the actual AgentLoop dependency graph. Provider activation, full
remote coverage and Builder conversation/TeamSpec configuration remain pending.

Controlled Host setup now installs a fixed per-Agent global-tool allow mask and native
tool presentation before publication. Only explicitly allowed existing global definitions
survive the mask; later global registrations stay hidden. Scoped definitions still pass
OfficialExecution's explicit name/implementation/argument gates. Ordinary global tools
remain available outside the controlled scope. Real AgentLoop coverage now exercises the
concrete resource tools as model → coverage → model → rank → model, for two isolated
Agents, with old/new ambient global tools absent from model schemas and acknowledged
home evidence for the actual tool results. Provider responses remain deterministic test
fixtures; this does not yet implement the Builder interview or create a TeamSpec.

Official execution now acknowledges home selection policies only for matching profile
revision, configured model/effort and executor_configuration scope. Inference-attestation
requirements remain unsupported and reject before claim. Policy-bound calls must use
prepareCall: both requested and resolved controls are checked, provider routing stays
pinned, and the prepared configuration is recorded through the durable SelectionOutbox
before call admission. A missing home receipt prevents dispatch; replay sends evidence
only. Selection evidence uses the official call ID as its configuration observation ID
(turn_id) and session/input identities for correlation. It does not attest the provider's
actual inference model. Completion requires reconciled matching evidence. Legacy calls
without a selection policy retain their existing behavior.
Before claiming a policy-bound lease, official execution also checks the current
profile fingerprint and allowedModels, then calls the registered LlmRuntime
resolveCallConfig adapter metadata resolver for the exact provider/model/effort.
It rechecks the fingerprint after that asynchronous lookup and before subsequent
controlled actions, including dispatch of an already prepared call. Missing providers,
unsupported explicit effort and changed profiles reject without inference. Admission
records label this as adapter_configuration_metadata with inference_verified=false;
metadata availability is not proof of provider routability or inference identity.

Home-Hub team draft APIs now persist stable Superagent/conversation identities and
immutable configuration revisions separately from runtime sessions. Owner callers can
save/read/list revisions and audit; draft save confers no execution authority. Builder
interview/tools and workflow activation still need to consume these endpoints. See the
remote protocol team-draft contract for exact routes and bounds.

`artifact-snapshot.js` provides read-only capture for an explicitly authorized Git
repository root. It hashes raw tracked, baseline and unignored untracked paths,
file executable bits, symlink text and deletions. Staging unchanged content does
not change its identity. `tree_hash` identifies the sorted raw file manifest;
`patch_hash` identifies the base Git tree plus that manifest, not textual diff bytes.
Ignored files are outside this capture and are not claimed as covered build outputs.
No Git clean/textconv/external diff filters run; no index/commit is written. Local
Git must exist at `/usr/bin/git`; unborn repositories, unresolved merges, submodules,
non-UTF8 paths, special files and exceeded bounds fail explicitly. Two consecutive
matching captures and per-file stability checks detect ordinary concurrent edits;
this is not an atomic filesystem snapshot or OS sandbox. Callers must retain workspace
locks during capture/use and revalidate before acceptance. Its
integration test captures a newly created fixture repository and records the result
through the real home artifact-evidence API; it does not inspect user repositories.

`ArtifactOutbox` now persists fixed artifact/review/verification observations in
AgentProfiles before sending. Recovery resends the same evidence and verifies the
receipt sequence, evidence, producer session and snapshot digest. Reusing a saved
capture ID replays its observation without reading the workspace again; fresh
captures require fresh IDs. Remote operations route through the execution Host's
negotiated artifact accounting relay to home; unsupported peers leave evidence
pending. Pending records are never pruned; the per-binding 128-record bound
fails explicitly pending archival support. OfficialExecution owns the outbox,
recovers/polls/closes it, and blocks prepared model calls and operation completion
while the current operation's observations are unreconciled. This does not implement
WorkRun acceptance.

Host setup can call `kodeAgents.mountOfficialArtifactTool(agentCtx, agent,
{workspaceRoot,repositoryId})` to register scoped `kode_artifact_capture`. The tool
accepts only evidence_id, pins owner configuration and the managed operation, requires
the exact canonical workspace grant with read capability, and uses the durable
outbox. Output distinguishes pending/home-reconciled evidence and never claims
completion. Returned pending evidence is not a replayable tool failure. The actual
official lifecycle/ToolRuntime integration test verifies private tool registration,
argument scope, immutable capture IDs, fresh snapshots after edits and grant
revocation. This mount API still needs automatic role provisioning, workspace locks
and WorkRun artifact acceptance; it does not enable unconfigured agents by default.
For remote assignments the tool reads grant context from the authoritative home
through the execution Host's scoped accounting relay, captures the execution Host's
fixed local repository and sends observations through ArtifactOutbox back to home.
It never creates a shadow operation at the execution Host. Local and two-Hub actual
official lifecycle/ToolRuntime/Git tests cover this path and home grant revocation;
automatic assignment creation and remote SSH deployment are separate concerns.

`WorkspaceLocks` provides Host-local POSIX kernel exclusion using the native flock
entry already used by dsh session persistence. Canonical workspace paths map to
stable lock inodes; release never unlinks them. Contention fails explicitly, with no
TTL takeover. SIGKILL releases the descriptor in the kernel. Cancellation does not
release a still-running callback; withLock releases only after it settles. Native
loading failures and Windows are unsupported rather than silently running unlocked.
OfficialExecution owns a manager under `workspace-locks` beside its profile state
(or accepts an injected shared manager), and the capture tool holds that lock through
capture/outbox recording. Grant-required official tools with a trusted
`workspace_write` policy are automatically locked at the execution boundary;
read-only tools may explicitly request the same exclusion with workspaceLock=true
(capture does). Lock acquisition occurs after grant authorization but before the
tool journal begins, so contention executes nothing and creates no uncertain tool
record. Release follows the complete tool pipeline and evidence recording, including
failure paths. Hosts/profiles that share workspaces must use the same
trusted lock directory outside the repositories. Other writers still need to join
this cooperative protocol; no protection against arbitrary external editors is
claimed. Legacy non-granted execution, native executors and external writers are not
covered by this official-tool boundary. Distributed reservation and WorkRun stage
ownership remain separate work.
Native test launchers clear NODE_TEST_CONTEXT and check explicit child pass counts,
so a child test-runner environment cannot yield an empty apparent success.


Controlled official loop Hosts expose `officialLoops.dispatches.dispatch(command,
{setup, signal})` and `get(session_id, command_id)` to trusted Host orchestration.
Commands pin session, operation/attempt/epoch, profile revision, provider/model/effort,
workspace cwd and tool names. The profile store durably records intent before
AgentLoop creation, then a `created` receipt. Concurrent identical requests join;
changed content under the same command ID rejects. Historical receipts do not
assert that the Agent is still running, and replay after disposal never recreates it.
An interrupted/failed creation remains `uncertain`; persisted `creating` records
without an in-process owner project as uncertain. Recovery must reconcile the
runtime/session before any new command; this API does not automatically resume it.
Each session permits one creation command, without eviction. Changing command ID
cannot bypass an earlier uncertain or successful creation; later authorized work
uses the separate resume path after reconciliation. The ledger assumes the existing
single Host owner of the profile store. This is controlled session
creation only: it sends no input, performs no inference, and is not yet the WorkRun
Assignment/outbox dispatcher. Trusted setup still passes the actual tool/grant gates.


`officialLoops.dispatches.reconcile(session_id, command_id)` can resolve a lost
creation acknowledgement without making a session live. Successful controlled
creation appends `plugin:kode/official-creation` through the official ignorable
plugin-record API and flushes the session before saving its command receipt.
Reconciliation opens only a read handle, checks exact session/cwd and non-fork
identity, and requires one matching command/fingerprint marker in the first 4096
events. Matching durable evidence records historical `created` plus its sequence;
missing/unreadable/mismatched evidence keeps uncertainty. No absence proves no effect.
This does not renew a lease, resume an Agent, send input or authorize work. A plugin
record lost during format migration likewise leaves recovery uncertain. An existing
created receipt remains historical and does not assert a currently running Agent.


Managed official bindings may include `managedAssignment: { id }`. Before lease
claim the controlled Host validates actual configuration/tools/canonical workspace,
holds a native workspace lock and requests owner-Hub Assignment admission. The
current path supports local first stages only; downstream evidence and remote
admission remain pending. The lock spans execution and is borrowed by scoped tools;
cancellation cannot release it while a controlled action is still in flight.
Live Assignment authority/resources gate claims, renewals and active availability.
No model inference is used to attest configuration identity.


`kodeAgents.assignmentDispatches` provides owner-only creation delivery:
`dispatch(assignmentId, {setup})` or `drain({prepare: async assignment => ({setup})})`.
`prepare` is trusted Host code mounting exact scoped implementations/policies; return
null to leave unsupported work queued. Managed profile/operation/Assignment binding
is created atomically and never replaces another session identity. Resource holds
and existing official admission precede creation. Hub receipt loss replays the same
local command; uncertain creation reconciles persisted evidence without a new Agent.
Results from dispatch/drain acknowledge creation only. Use start below for mandate
delivery; neither entry infers stage completion, automatically resumes Agents or
starts a background scheduler.


`assignmentDispatches.start(assignmentId, {setup})` additionally queues the frozen
first-stage mandate through the Hub's existing durable message inbox. It requires
a currently owned live official handle; historical creation alone cannot restart
work. The actual Host pump validates the bound message ID/hash and full input
rather than using the ordinary 4096-character peer preview. Existing delivery
tracking distinguishes durable queue from consumed context. Model calls still need
the configured reservation pricing and live grant/budget/resource admission.
There is no automatic background scheduler, downstream evidence delivery or stage
completion implied by `start`. Large mandates exceeding 64 KiB reject without
partial inbox/Assignment writes; paging is not implemented yet.


Assignment model entry checks the actual projected user input against the exact
Hub mandate and flushes session persistence before metered admission. Direct Agent
followup, extra user input or altered mandate text cannot bypass the Host inbox
check. Approved follow-up/context replacement/takeover are not implemented yet;
they must not be simulated by injecting another user turn into the same Assignment.


Artifact observations for a managed Assignment require its durable mandate to have
been consumed. Home-Hub stage output selection binds exact stored observation
sequences to the frozen WorkRun project/workflow/producer context. This is an
immutable output selection, not stage completion or authorization to release locks.
Actual fixture validation captures a generated Git workspace under the controlled
execution lock and proves a foreign repository label cannot satisfy the frozen output.


AssignmentDispatchHost.stop(id) drains an actually owned local official execution
and persists a stop receipt before retryable Hub delivery. It waits for controlled
actions and workspace lock release, and cannot infer stop from a missing handle.
The owner-only stop-receipt API fences interrupted attempts but keeps budget and
resource holds pending settlement. A reported operation remains reported; this is
not workflow completion or a claim about detached external processes.


Explicit budget policy settlement=internal_price permits owner Assignment
accounting finalization after a durable drain and complete official usage. It
settles only configured internal team credits; provider cost remains unconfirmed.
Without this policy, or with any unresolved call, reservations stay pending.


ArtifactOutbox.capture now persists a local content archive before recording its
observation. Archives live beside the profile store in artifact-archive, addressed
by snapshot hash. They contain the exact raw manifest and content-addressed bytes,
including executable modes, deletion entries and symlink text (never target reads).
Files are private, written/synced before atomic publication, and verified on replay;
corruption rejects rather than silently replacing an existing archive. Capture
retry reads its saved archive and does not rescan the workspace. Legacy manually
recorded observations without archives remain observations only.

Local retention alone is not a Hub content-transfer acknowledgement. The outbox
now uploads captured content in idempotent chunks and separately records
home_archive_reconciled after Hub validation. Hash-only observations are never
presented as retrievable contents. Remote relay, stage-authorized use of restored workspaces and archival
lifecycle/GC remain to be integrated.


The owner artifact archive API retains 256 KiB chunks and exposes download only
after digest/manifest/content validation against the original evidence sequence.
fetchArtifactArchive validates retrieved bytes against the expected snapshot; it
does not materialize or execute them. Completion does not pass a workflow stage.


OfficialExecution.artifactWorkspaces provides owner-side prepare of an immutable
Hub snapshot into a new private cache directory. Requests pin request_id, evidence
sequence and snapshot_hash. It validates content before writing, rejects escaping
symlink targets and file/directory conflicts, writes with exclusive creation, syncs
files/directories and records ready only after exact no-extra/missing-file checks.
Source files/directories are read-only, preserving executable distinction; contained
relative symlinks are retained. This is a raw source tree, not a Git checkout or an
execution sandbox. Nothing is run during restore.

Same request revalidates the existing contents; changed or incomplete preparation
rejects without overwriting or repairing files. A ready receipt always has
execution_authorized=false. Worker grant/root registration, downstream Assignment
binding and independent review/verification scheduling are separate pending gates.
Runtime close aborts/waits for pending preparations; no automatic cache GC occurs.


Managed official finish checks selected artifact bytes against a fresh capture
under the held workspace lock. A mismatch keeps the operation unreported. After
accepted report it persists finalArtifact; Assignment stop includes this proof for
Hub validation against the selected stage outputs and complete archives. Reporting
before selection remains possible but does not create final-artifact proof or
complete a stage. No independent review or verification is inferred.


Owner stage completion now validates selected archived artifacts, the final source
observation, reported/drained execution and finalized Assignment accounting in one
Hub transaction before passing the stage and releasing its resource/team slots.
Exact receipt replay cannot release a later Assignment's hold. This currently
supports local artifact-only stages; independent review/verification and external
execution require additional proof. A passed stage never implies a completed Run
or automatically starts its successor.


OfficialExecution.prepareAssignmentInput({assignment_id, source_stage, output})
restores only an artifact named by the Hub's frozen Assignment input manifest.
It checks Host ownership and complete archive identity, derives a private cache key,
revalidates bytes on reuse and rechecks the Assignment before returning. Caller
paths/hashes are not accepted. The receipt links source and Assignment identities
but retains execution_authorized=false; derived grants and independent downstream
execution are still pending.


Derived Assignment finish now persists finalInput after revalidating source bytes
under its workspace lock. Hub stop checks this proof against admitted context,
archive and exact selection. Read-only review stages can pass only with matching
passed/nonblocking review evidence plus reported/drained/settled execution; resource
release is atomic. This does not finalize the WorkRun or execute verification commands.

### Versioned workflow instruction resources

The owner registers a Skill or Plugin instruction artifact through `POST /api/v1/messaging/project-configs`. Use an immutable configuration `id` and `version`, with `spec.kind` set to `workflow_dependency` and `spec.artifact` containing the following fields.

- `kind` selects `skill` or `plugin`.
- `source` identifies the reviewed source, and `source_version` records its version.
- `instructions` contains the complete UTF-8 instruction text. `content_hash` is its exact SHA-256 digest.
- `hosts` lists the execution Hosts supporting this resource.
- `tools`, `capabilities`, and `network` declare its execution requirements.

Each artifact supports up to 16 KiB of instruction text. A stage supports up to eight references and 32 KiB of serialized frozen artifact records. Oversized resources receive a validation error.

Reference the returned `{id,version,hash}` through the stage's optional `execution.dependencies` array. Builder's `dependency` catalog exposes owner-registered resources for the selected Hosts. The activation review displays their source, version, hashes, required tools and permissions, and expandable instruction text. Missing versions, mismatched hashes, unsupported Hosts and requirements beyond the stage scope block activation and WorkRun creation.

Home freezes the resolved artifacts into the WorkRun context. Dispatch and admission validate the exact artifact bytes and Host. A Worker receives only its stage's resources, and the model-call provenance records their source and hashes. Later versions apply when explicitly selected for a new team revision. Empty dependency arrays preserve existing workflow hashes and mandate content.

These resources transport reviewed workflow instructions. Their required tools pass the existing Host tool and grant checks. Executable plugin installation uses the owner's separate installation procedure.

### Controlled Codex wrapper bootstrap

An owner-configured Codex workflow profile can declare `managedInference.bootstrap`
when its CLI wrapper supports an explicit engine-path environment variable. The
bootstrap records the selected existing engine and its hook in the profile revision.
For example, the installed TCodex wrapper supports the following configuration.

```json
{
  "endpoint": "https://example.com/responses",
  "reasoningEfforts": ["high"],
  "bootstrap": {
    "executable": "/absolute/path/to/installed/codex",
    "pathVariable": "TCODEX_CODEX_PATH"
  }
}
```

The endpoint is the exact inference URL authorized by the owner. Authentication uses
the existing optional `apiKeyVariable` name and explicit profile environment. Engine
selection and wrapper update controls are configured by the owner. Each native decision
creates a private launcher and manifest, then applies Host configuration after wrapper
defaults. The launcher restores its owned HOME, CODEX_HOME and XDG_CONFIG_HOME and checks
wrapper feature switches against disabled Host features.

The wrapper's public `model_catalog_json` is bounded to 8 MiB and 1024 models. A private
copy sets each model's `apply_patch_tool_type` to null, preserving its other model
capabilities. Granted workspace edits use Host tools. Source and effective catalog hashes
and model count enter the native configuration and persisted decision records. The
original public catalog retains its bytes. The actual inference request still passes
model, effort and tool validation and the one-request admission gate.

TCodex 0.1.4 with Codex 0.154.0 has controlled-model acceptance for this bootstrap,
including a human question, answer continuation in the same Worker, independent review,
real verification and final reply. Real provider delivery requires its own acceptance.

To use a wrapper's existing authenticated loopback proxy, omit `endpoint` and
`apiKeyVariable`, and set `bootstrap.provider` to its selected provider identifier.
Optional `bootstrap.home` selects the owner's existing wrapper HOME. The engine still
uses the private decision HOME. The wrapper handles its own authentication. Host reads
only the selected provider's loopback routing metadata and forwards authentication
fields opaquely. No login file or authentication header enters decision records.
This mode accepts literal HTTP loopback routes, rejects redirects and URL credentials,
and configures transport once before admission. Persisted transport evidence contains
the provider, loopback origin and endpoint hash. The full route remains decision-private.

TCodex 0.1.4 with Codex 0.154.0 also passed one live hy4-preview-ioa text decision
through this transport, with one admission, one request, token usage and confirmed
process-group exit. Full live-provider WorkRun delivery remains pending acceptance.

The opt-in `test/codex-wrapper-live-tools.test.js` exercises two real decisions with a
Host tool result between them. Set `KODE_TEST_LIVE_FREE_WRAPPER=1` only for an explicitly
authorized free resource. Also supply `KODE_TEST_MANAGED_CODEX_WRAPPER`,
`KODE_TEST_MANAGED_CODEX_EXECUTABLE`, `KODE_TEST_WRAPPER_HOME`,
`KODE_TEST_WRAPPER_PROVIDER` and `KODE_TEST_NATIVE_MODEL`. The engine-path hook in this
acceptance test is TCodex's `TCODEX_CODEX_PATH`. Production profiles configure that hook.
No Host tool is released until the admitted response drains and the native process
group stops. Cancellation interrupts drainage. Every fresh decision receives explicit
instructions to continue the serialized workflow history using completed Host results.

Assignment evidence tools distinguish a declared parameter-shape failure detected before
dispatch from an uncertain implementation outcome. The former returns a durable
`INVALID_TOOL_ARGUMENTS` result, records the rejected call at Home and allows a corrected
call with a new ID. It invokes no tool implementation. Extra authority fields and
semantic/path checks retain their grant-denial behavior. Failures after implementation
dispatch keep the existing reconciliation requirement. A real Home workflow regression
injects an invalid output ID, corrects it and completes independent review and verification
using controlled model responses.

`test/coordinator-live-worker.test.js` is a separate opt-in Home workflow acceptance.
It uses the same live-wrapper variables above, an actual hy4 implementation Worker,
controlled Coordinator/reviewer/verifier models and a real verification command. Two
consecutive runs completed all three stages, budget accounting, final reply and restart
receipt checks. Its test credits use an explicit internal price, distinct from provider
currency. Whole-team live-model acceptance remains separate.

Failed native decisions persist `failure_details` with a fixed transport phase, HTTP
status, allowlisted transport error code and cancellation flag. Error text, authentication
fields and response content are excluded. Text completion and dynamic-tool interruption
both drain the admitted response before native shutdown, with cancellation still active.
