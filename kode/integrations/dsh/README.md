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

The current adapter accepts text input. Auxiliary compaction/title calls through an external Agent route are refused. Work-bearing native turns are not automatically retried: input admission is persisted before dispatch, and a crash or lost result is marked uncertain. New followups can resume the native thread; the admitted input is never silently submitted a second time. Account login remains the configured CLI's own login.

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

`ui-sidebar-browser` is bundled with the pinned dsh release but disabled by its default Web profile. The Kode patch enables it. It retains dsh's sandboxed HTTP(S) iframe implementation, address bar, reload and external-open actions. Sites that reject embedding still require opening externally; this is not an unrestricted desktop browser engine.

Communication remains model-tool driven. The transcript shows sender session name → recipient session name and the actual message, with no raw source addresses, message IDs, reply IDs or JSON in the communication cards. Long received messages expand in place. Send statuses are explicitly the recorded status at send time, not a claim of task completion. The original protocol is still available to the model and in the native trajectory/log.

The owner-only, read-only `GET /api/kode/sessions` endpoint returns a minimal session-name directory through dsh authentication. Full `(node_id, session_id)` pairs resolve names; a remote session is never looked up against a same-ID local session. The client shares one directory read across cards and refreshes every 10 seconds while cards are mounted and the page is visible. Missing names display a readable unavailable/unnamed state instead of an ID.

The messaging backend adds session-scoped `POST /api/v1/messaging/sessions/:id/title` with `{ "title": "…" }`. It changes directory metadata without rotating credentials, reviving offline sessions, or disturbing claimed messages. The Host reads dsh's authoritative `sessionTitle` service, updates changed live titles, and backfills already-owned persisted session titles at startup without resuming Agents. Existing authenticated peer-directory frames carry these names across SSH; the wire frame format is unchanged.

Validation: 36 integration-runner tests passed, followed by 6 focused client/name-API tests including the additional inactive-session backfill case. The messaging Rust suite passed 10 tests (the environment-gated disposable SSH test was not enabled in that command). Live browser checks verified project search/switching/native directory selection, sidebar HTTP(S) loading, cross-node name resolution, and immediate current-session rename updates. Exact, settled, text-only assistant echoes of a verified Kode incoming envelope are now suppressed in Chat beside the received-message card. Matching is restricted to the same turn and the complete envelope (optionally prefixed by a one-line Agent label); substantive replies, mixed content, and streaming output remain visible. This presentation rule uses rc.2 Chat data attributes, retaining the native assistant renderer and all durable events/trajectory content; revalidate those attributes when upgrading dsh.


### SSH execution Hosts and settings (2026-10-26)

The local plugin starts `kode-ssh-tunnel`, which reuses `kode-bridge::ssh::Tunnel` and its SSH config / known-host checks. An authenticated loopback portal forwards the complete remote dsh HTTP/WebSocket application. Agent execution, directory browsing, file preview, Git and PTY terminals therefore belong to the remote dsh Host. Kode does not reimplement these services. Switching Hosts selects a different dsh session store; it does not migrate an existing conversation.

Build the helper with `cargo build -p kode-bridge --bin kode-ssh-tunnel`, then put it on PATH or set the Kode Host plugin’s `sshTunnelCommand` to its absolute path. Install the same pinned dsh and Kode plugin on the remote machine, apply `cordis.remote.patch.yml` in addition to the bundle, and start `dsh web --no-open` bound to loopback. Automatic remote installation is not implemented. In Create Project → Add SSH Host, provide the SSH config alias, port, and complete loopback access URL printed by the remote dsh. Profiles are saved mode 0600; remote tokens stay server-side. The browser receives a single-use portal ticket and a separate HttpOnly cookie. Closing the owning dsh Host closes its portals and tunnels.

Settings → Agent now contains custom Agent CRUD, including multiple instances of the same type. The composer’s Custom Agent action opens this exact native settings section. Agent settings follows dsh’s Models list layout: one row per Agent, an Edit action, and an Add Agent row. The standalone Models navigation item is removed; editing DeepSeek Harness expands the complete native Models section inside its Agent row, retaining provider and credential behavior. The composer retains a per-conversation model shortcut, and dsh retains its work-mode selector. Settings navigation uses the pinned rc.2 settings slot’s shared `openSection` action. Because rc.2 has no navigation-filter extension, a scoped adapter wraps the existing settings component in place and restores it on unload; its original store, locale, injected hooks and child-slot authorizations are retained. Native model-settings deep links are redirected to Agent with the dsh editor expanded. Revalidate this integration on dsh upgrades.

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

The `kode-dsh-conversation` entry is an optional plugin, disabled by default.
Enable or disable it through dsh's Plugin Manager (`setPluginEnabled` with the
entry ID returned by `listPlugins`). Its lifecycle owns the dsh Agent capability
and mode declarations. Removing it withdraws its selector, mode and model/key
settings; historical logs and immutable bindings remain stored. There is no
`hideDshAgent` setting.

External Agents run through `@kode/dsh/native-factory`, an independent durable
inbox/driver built on the public Session API. It sends only new inputs to the
native CLI protocol and never assembles the shell's dsh system prompt or runs an
outer dsh LLM loop. The conversation's Agent trajectory consumes durable native
Agent events (reasoning, replies, commands, file changes and tool activity), not
an edited presentation of dsh prompt records.

The optional dsh Agent uses the released `dsh acp` application in a separate
managed process. That application retains its own complete harness, presets,
tools, prompt and model loop. Its private launch patch reuses the configured
provider definitions; credentials are never sent to the browser. Kode owns the
process lifetime and closes it on unplug. Mode selection is applied when that
native conversation starts. ACP permission policy is admitted in the launch
patch; the pinned upstream protocol does not advertise live permission changes.

`@kode/dsh-transport` routes the official Connection carrier through Kode's
owner-only HTTP/WebSocket SSH gateway. Host selection is tab-local; switching
releases the current view, negotiates a new Host generation and restores the
selected remote Session in the same page. The local native folder chooser and
the released remote directory browser coexist through a small pinned slot
priority adapter. Files, Git and terminals continue to use dsh's own services.

With `sharedBackendState: true`, Agent configurations/immutable CLI bindings and
SSH Host definitions are versioned documents in the Kode backend SQLite store.
Existing Host JSON files are imported once and retained for rollback; compare-
and-swap rejects stale updates. The owner-only workbench catalog also reads
Kode GUI's persisted tab/endpoint metadata. Native CLI transcripts remain in
their original homes. Saved GUI tabs are adopted on first open: compatible text history is imported,
and the original CLI thread is resumed on the next new user input.

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
