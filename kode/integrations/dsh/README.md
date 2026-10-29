# kode sessions for dsh

This integration adds **model-callable session communication** to DeepSeek Harness. It uses kode's Rust backend for durable local/SSH routing and dsh's original conversation, tool execution and inbox. It does not add a messaging page or replace kode's GUI.

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
| `kode_sessions_send` | Send content using an explicit target and a stable idempotency key |
| `kode_sessions_read` | Read this session's communication events after a cursor |
| `kode_sessions_wait` | Wait up to 30 seconds for communication events |

A reply is another send with `in_reply_to` set to the original message ID. The backend checks both participants. Delivery acceptance does not mean task completion.

Incoming messages are attributed peer messages in the original dsh conversation. They queue a separate turn and do not answer pending approvals. On a Web Host with the native `sessionController`, the plugin automatically resumes a previously registered dsh session when it has pending messages. The native controller restores its recorded preset, model selection and persistence ownership; dsh's archive admission still controls whether it runs. Only session IDs already owned in this Host's token state file are eligible, never arbitrary sessions discovered on another Host. Set `resumeInactive: false` to require manual resume; Hosts without the controller retain queued messages until manual resume. The wakeup probe does not claim messages, so a failed resume leaves delivery pending.

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

`test/fixture-model.js` is a local OpenAI-compatible inference fixture for manual dsh runtime verification. It handles fixture prompts only and never calls a remote model. Real dsh 0.2.1-rc.2 was used to verify model tool discovery/calls, native inbox persistence, and a request/reply roundtrip between two dsh Hosts through OpenSSH. A second verification stopped the receiving dsh Host, queued a message over SSH, restarted dsh without opening the session, and observed native cold resume, a model-issued reply linked by `in_reply_to`, and accepted receipts on both nodes. Both bridge binaries must use the same protocol revision. This is integration evidence, not a model-quality evaluation.

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
| Mid-turn steering | Codex uses native `turn/steer` with the expected active turn. ACP Agents without protocol support explicitly require queueing. |
| Queued-message steering | Native admission is checked before transferring a queued input. Rejection retains the queue item and content; unsupported Agents disable queue steering and submit busy composer inputs as queued followups. |
| Shared memory UI and synchronization controls | Missing: desktop review queue, scope/relation editing, memory sync controls. Existing CLI MCP/hook configuration can still operate independently. |
| Native plugin/Hook installation and management | Missing desktop management UI; dsh's own plugin page manages dsh bundles, not all native CLI plugins. |
| Model usage and desktop floating monitor | Missing desktop-wide monitoring parity; dsh has its own per-session observations. |
| Phone pairing, cloud sync deployment | Missing Kode desktop/mobile cloud-management flow. |
| Native screenshot tools, desktop window/tab actions, SpecOps window | Not ported; some are desktop-specific rather than Web-session requirements. |

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

Mobile is not yet connected to the new native dsh session runtime. Existing
mobile uses the GUI CoreEvent cloud-sync adapter, kode-sync-server and paired
mobile REST/WebSocket access. Sharing Kode's workspace database does not publish
dsh Agent sessions into that stream, and does not provide mobile input, interrupt
or approval handling for them. The existing mobile protocol was not changed in
this workspace change. A common backend session/event/control adapter is still
required before claiming full desktop/dsh/mobile remote collaboration.

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
