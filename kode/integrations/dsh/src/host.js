import { assignmentInput } from './assignment-input.js'
import { coordinatorInput } from './coordinator-input.js'
import { builderInput } from './builder-input.js'
import { acquireOperationLease } from './operation-lease.js'
import { eventPage, messagePage, relayInput, lifecyclePage } from './message-pages.js'
/** Kode Host integration: durable backend messaging and independently owned native Agent execution. */
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { BackendClient } from './backend-client.js'
import { connectBackend } from './service-launcher.js'
import { searchSessions } from './session-search.js'
import { installAgentRuntime } from './agent-runtime.js'
import { prepareRuntimeConfig } from './bundle-runtime.js'
import { registerIntegrationApi, memoryTools } from './integration-api.js'
import { ExtensionHub } from './extension-hub.js'
import { registerAgentHubApi } from './agent-hub-api.js'
import { registerSharedSessionApi } from './shared-session-api.js'
import { createDeliveryTracker, deliveryInputId, DeliveryEvidenceUnavailable } from './delivery-tracker.js'
import { controlledBinding } from './managed-codex-profile.js'

export const name = 'kode'
export const inject = ['agents', 'tools', 'sessions']
const PREFIX = '/api/v1/messaging/'
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve()
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms)
  signal?.addEventListener('abort', done, { once: true })
})
const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export async function apply(ctx, config = {}) {
  const runtimeConfig = await prepareRuntimeConfig(config)
  const token = runtimeConfig.tokenFile ? (await readFile(runtimeConfig.tokenFile, 'utf8')).trim() : process.env.KODE_BRIDGE_TOKEN
  if (!token) throw new Error('kode requires tokenFile or KODE_BRIDGE_TOKEN on the dsh Host')
  const admin = new BackendClient(runtimeConfig.url, token)
  ctx.provide?.('kodeBackend', admin)
  const backend = await connectBackend(admin, runtimeConfig)
  ctx.effect(() => backend.close, 'kode.backend-lifetime')
  const node = backend.node
  if (runtimeConfig.publishWorkbenchConnection && runtimeConfig.sharedBackendState) {
    const path = runtimeConfig.workbenchConnectionFile ?? join(homedir(), process.platform === 'darwin' ? 'Library/Application Support/kode/workbench-connection.json' : '.config/kode/workbench-connection.json')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify({ url: admin.url, token_file: runtimeConfig.tokenFile, server_command: runtimeConfig.serverCommand, server_config: runtimeConfig.serverConfig, server_args: runtimeConfig.serverArgs ?? [] }), { mode: 0o600 })
  }
  const stateFile = runtimeConfig.stateFile ?? join(homedir(), '.config', 'kode', `dsh-${node.node_id}.json`)
  let tokens = Object.create(null)
  try { tokens = Object.assign(Object.create(null), JSON.parse(await readFile(stateFile, 'utf8'))) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const active = new Map()
  const installing = new Map()
  const stop = new AbortController()
  let wakeTask
  let runtimeReady = !(runtimeConfig.agentRuntime !== false && ctx.inject && ctx.get?.('llm'))
  let saving = Promise.resolve()
  const persist = () => {
    saving = saving.then(async () => {
      await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
      const temporary = `${stateFile}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(tokens), { mode: 0o600 })
      await rename(temporary, stateFile)
    })
    return saving
  }
  function sessionTitle(agent) {
    return ctx.get?.('sessionTitle')?.get(agent.session)?.title ?? agent.session?.header?.title ?? '未命名会话'
  }
  if (ctx.inject) ctx.inject(['webServer', 'connection'], async webCtx => {
    webCtx.effect(() => registerIntegrationApi(webCtx, admin), 'kode.integration-api')
    webCtx.effect(() => registerSharedSessionApi(webCtx, admin), 'kode.shared-session-api')
    const { installSessionCreator } = await import('./session-create.js')
    installSessionCreator(webCtx, admin, node.node_id)
    const { registerProjectHosts } = await import('./project-hosts.js')
    await registerProjectHosts(webCtx, { ...runtimeConfig, backendClient: admin })
    const { registerMessagingApi, syncSessionTitles } = await import('./messaging-api.js')
    webCtx.effect(() => registerMessagingApi(webCtx, admin, node.node_id), 'kode.messaging-directory-api')
    webCtx.inject(['sessionController'], sessionCtx => sessionCtx.effect(() => {
      const lifetime = new AbortController()
      const task = syncSessionTitles(sessionCtx.sessionController, admin, new Set(Object.keys(tokens)), lifetime.signal).catch(error => { if (!lifetime.signal.aborted) ctx.logger.warn('Kode session name sync failed: %s', error.message) })
      return async () => { lifetime.abort(); await task }
    }, 'kode.session-name-sync'))
  })
  if (runtimeConfig.runtimeBridge !== false && ctx.inject) ctx.inject(['sessionController', 'kodeAgents', 'sessionPersistence'], async scope => {
    if (!scope.get?.('sessionController') || !scope.get?.('kodeAgents')) return
    const { installRuntimeBridge } = await import('./runtime-bridge.js')
    installRuntimeBridge(scope, admin)
  })
  function install(agent) {
    // Third-party model sessions retain their own tools and execution context.
    if (agent.options && !agent.isKodeNativeAgent && !agent.options.provider?.startsWith('kode-agent-')) return Promise.resolve()
    if (installing.has(agent.id)) return installing.get(agent.id)
    const task = performInstall(agent).finally(() => installing.delete(agent.id))
    installing.set(agent.id, task)
    return task
  }
  ctx.provide?.('kodeOperationLeases', { acquire: async (agent, binding, signal, admission = {}) => {
    const managed = ctx.get('kodeAgents')?.profiles.binding(agent.id)
    if (!active.has(agent.id) && controlledBinding(managed) && managed.managedOperation?.id === binding.id && ctx.agents.get(agent.id) === agent) {
      // Explicit controlled official execution opts into Host registration.
      await performInstall(agent)
    }
    const entry = active.get(agent.id)
    if (!entry || entry.agent !== agent) throw new Error('Operation worker is not registered on this Host')
    return acquireOperationLease(entry.client, binding, { node_id: node.node_id, session_id: String(agent.id), profile_id: managed?.profile.id, grant_enforcement: controlledBinding(managed) && ctx.get('kodeAgents')?.officialExecution?.authorizesLease(agent, binding) === true }, { signal, beforeClaim: admission.beforeClaim })
  } })
  async function performInstall(agent) {
    if (active.has(agent.id) || stop.signal.aborted) return
    const registration = await admin.call(`${PREFIX}sessions`, {
      session_id: String(agent.id), title: sessionTitle(agent),
      runtime: 'dsh', owner_token: tokens[agent.id] ?? null,
    }, stop.signal)
    tokens[agent.id] = registration.owner_token
    await persist()
    const client = admin.forSession(registration.owner_token)
    if (stop.signal.aborted) {
      await client.call(`${PREFIX}sessions/${encodeURIComponent(agent.id)}/offline`, {})
      return
    }
    const entry = { agent, client, registration, stop: new AbortController(), task: undefined, tools: [], receipts: [], readReplies: new Set(), queuedReplies: new Map(), title: registration.session.title, titleRetryAt: 0 }
    if (node.delivery_tracking) entry.delivery = createDeliveryTracker(agent, client)
    entry.inputCancellation = node.input_cancellation === true
    active.set(agent.id, entry)
    const tools = agent.ctx.get?.('tools') ?? agent.ctx.tools
    // Multiple official agents share the service, but each owns its session tools.
    // Registering on the service itself collides when a Coordinator starts a Worker.
    const toolRuntime = typeof tools.forScope === 'function' ? tools.forScope(agent.ctx) : tools
    const binding = ctx.get?.('kodeAgents')?.profiles.binding(agent.id)
    const managedRole = controlledBinding(binding) && binding.managedOperation
      && (binding.managedCoordinator || binding.managedBuilder || binding.managedAssignment)
    // Managed roles use their explicitly granted role tools. Host inbox transport
    // still runs, but general session creation/messaging tools must not leak in.
    const add = (name, description, parameters, execute) => managedRole ? undefined : entry.tools.push(toolRuntime.register({ name, description,
      parameters: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(parameters).map(([key, value]) => { const { required, ...property } = value; return [key, property] })), required: Object.entries(parameters).filter(([, value]) => value.required).map(([key]) => key) }, output,
      execute: async (args, exec) => { if (exec.agent !== agent) throw new Error('foreign agent'); if (name.startsWith('kode_sessions_')) { const settings = await client.call(`${PREFIX}integrations`, undefined, exec.signal); if (!settings.messaging_enabled) throw new Error('会话通信已在 Kode 设置中关闭。') }; return execute(args, exec.signal) },
    }))
    add('kode_sessions_list', 'Find local and SSH-connected conversations by human-readable title, and discover saved execution Hosts for creating a helper. Start with the user name or keywords. Inspect matches and disambiguate duplicate names before sending; never guess addresses. Use the address returned with the selected session.', { query: { type: 'string', description: 'Session name or partial title; omit to browse all.' } }, async (args, signal) => ({
      ...searchSessions(await client.call(`${PREFIX}sessions`, undefined, signal), args.query),
      hosts: await (ctx.get?.('kodeProjectHosts')?.workspaceCatalog?.() ?? [{ name: '此计算机', kind: 'local', workspaces: [] }]),
      agentConfigurations: ctx.get?.('kodeAgents')?.profiles.list().filter(profile => ctx.get('kodeAgents').hasRuntime(profile.type)).map(profile => ({ name: profile.name, type: profile.type })) ?? [],
    }))
    add('kode_sessions_create', 'Create a new local or SSH Agent conversation and give it a task. Use this when the user asks to open another conversation or delegate work to a new helper. Select an existing Host and Agent configuration by human name; omitted Host means this computer. Returns the new named session address for follow-up communication. Reuse the same creation key only when retrying this exact task.', {
      title: { type: 'string', required: true, description: 'Human-readable name for the new conversation.' }, task: { type: 'string', required: true, description: 'Task to give the new helper, written as a normal request.' },
      host: { type: 'string', description: 'Saved SSH Host name; omit to create on this Host.' }, agent: { type: 'string', description: 'An existing Agent configuration name, such as tcodex.' },
      model: { type: 'string', description: 'Explicit advertised model ID; otherwise inherit a compatible caller selection or use the configured default.' }, reasoningEffort: { type: 'string', description: 'An effort ID advertised for the selected model; unsupported values are rejected.' },
      workspace: { type: 'string', description: 'Workspace name or path returned for the selected execution Host by kode_sessions_list. Required when more than one target workspace exists.' },
      workspace_id: { type: 'string', description: 'Exact workspace identity returned for the selected Host; never copy one from a different Host.' },
      cwd: { type: 'string', description: 'Existing registered Kode workspace path on the selected Host. Does not create a workspace.' }, idempotency_key: { type: 'string', required: true },
    }, async (args, signal) => {
      const hosts = ctx.get?.('kodeProjectHosts')
      let created
      if (args.host && !['local', '此计算机', '本机'].includes(args.host.trim())) {
        if (!hosts) throw new Error('SSH Host service is unavailable')
        await hosts.load()
        const normalize = text => text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
        const query = normalize(args.host), matches = hosts.hosts.filter(host => normalize(host.name) === query || normalize(host.host) === query)
        if (matches.length !== 1) throw new Error(`Host is ambiguous or unavailable. Available names: ${hosts.hosts.map(host => host.name).join(', ')}`)
        const mode = agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })?.mode ?? 'read-only'
        created = await (await hosts.connect(matches[0].id)).createSession({ ...args, host: undefined, permission: mode === 'danger-full-access' ? 'workspace-write' : mode, requester: `${node.node_id}/${agent.id}` }, signal)
      } else {
        const creator = ctx.get?.('kodeSessionCreator')
        if (!creator) throw new Error('Session creation service is unavailable')
        created = await creator.create(args, agent)
      }
      const assignment = await client.call(`${PREFIX}messages`, { target: created.address, content: args.task, idempotency_key: `create:${createHash('sha256').update(args.idempotency_key).digest('hex')}`, in_reply_to: null }, signal)
      return { ...created, status: 'assigned', assignment }
    })
    add('kode_sessions_creation_status', 'Read the durable outcome of an earlier creation using its original key and Host. This does not create or start a session. A completed creation does not prove task assignment or task completion; inspect message receipts separately. After a lost response, query before retrying the original request.', {
      idempotency_key: { type: 'string', required: true }, host: { type: 'string', description: 'The same saved SSH Host used for creation; omit for this Host.' },
    }, async (args, signal) => {
      if (args.host && !['local', '此计算机', '本机'].includes(args.host.trim())) {
        const hosts = ctx.get?.('kodeProjectHosts')
        if (!hosts) throw new Error('SSH Host service is unavailable')
        await hosts.load()
        const normalize = text => text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
        const query = normalize(args.host), matches = hosts.hosts.filter(host => normalize(host.name) === query || normalize(host.host) === query)
        if (matches.length !== 1) throw new Error('Host is ambiguous or unavailable')
        return (await hosts.connect(matches[0].id)).lookupSessionCreation({ idempotency_key: args.idempotency_key, requester: `${node.node_id}/${agent.id}` }, signal)
      }
      const creator = ctx.get?.('kodeSessionCreator')
      if (!creator) throw new Error('Session creation service is unavailable')
      return creator.lookup(args, agent)
    })
    if (entry.inputCancellation) add('kode_sessions_cancel_input', 'Request cancellation of your own message with a runtime input binding. Queue removal is distinct from stopping execution. Active/shared/unsupported execution may remain cancel_unconfirmed. Remote cancellation requires negotiated peer support; queued offline requests remain pending.', {
      message_id: { type: 'string', required: true },
    }, (args, signal) => client.call(`${PREFIX}messages/${encodeURIComponent(args.message_id)}/cancellation`, {}, signal))
    if (entry.inputCancellation) add('kode_sessions_cancellation_status', 'Read the persisted input cancellation result. A stop request never proves process termination.', {
      message_id: { type: 'string', required: true },
    }, (args, signal) => client.call(`${PREFIX}messages/${encodeURIComponent(args.message_id)}/cancellation`, undefined, signal))
    add('kode_sessions_delivery_status', 'Inspect persisted runtime input evidence for a message visible to this session. Queued is not consumed; consumed is not task completion. Remote evidence is mirrored only when both nodes negotiate delivery observations; a missing observation never proves non-execution.', {
      message_id: { type: 'string', required: true },
    }, (args, signal) => client.call(`${PREFIX}messages/${encodeURIComponent(args.message_id)}/delivery`, undefined, signal))
    const params = {
      node_id: { type: 'string', required: true }, session_id: { type: 'string', required: true },
      content: { type: 'string', required: true }, idempotency_key: { type: 'string', required: true, description: 'Stable key for one logical send; reuse only when retrying the same content.' },
      in_reply_to: { type: 'string' },
    }
    add('kode_sessions_send', 'Ask a named peer for help or send a requested result. Discover the peer from the session list first. Acceptance is not task completion: use read/wait to collect its answer. Reply with in_reply_to when answering a request; do not send acknowledgement-only replies or answer a completed reply again.', params, async (args, signal) => ({ message: await client.call(`${PREFIX}messages`, {
      target: { node_id: args.node_id, session_id: args.session_id }, content: args.content,
      idempotency_key: args.idempotency_key, in_reply_to: args.in_reply_to ?? null,
    }, signal) }))
    const readEvents = async (after, signal) => {
      const cursor = Math.max(0, after ?? 0)
      const result = eventPage(await client.call(`${PREFIX}events?after=${cursor}`, undefined, signal), cursor)
      for (const event of result.events) {
        const message = event.message
        if (message?.content_truncated || !message?.in_reply_to || message.target?.node_id !== node.node_id || message.target.session_id !== agent.id) continue
        entry.readReplies.add(message.id)
        const queued = entry.queuedReplies.get(message.id)
        if (queued) { agent.inbox?.remove(queued); entry.queuedReplies.delete(message.id) }
      }
      return result
    }
    if (node.lifecycle_events) add('kode_sessions_lifecycle_read', 'Read scoped delivery, consumption, cancellation and message-status audit events. This cursor is separate from kode_sessions_read; continue until an empty page. Historical imports are not cross-node causal order. Consumed is not task completion.', {
      after: { type: 'integer' },
    }, async (args, signal) => lifecyclePage(await client.call(`${PREFIX}lifecycle-events?after=${Math.max(0, args.after ?? 0)}`, undefined, signal), args.after ?? 0))
    add('kode_sessions_message_read', 'Read a complete persisted message in bounded pages. Only this session’s messages are visible. Offsets count Unicode code points; follow next until null. Reading a preview does not prove the full message was consumed.', {
      message_id: { type: 'string', required: true }, offset: { type: 'integer' },
    }, async (args, signal) => messagePage(await client.call(`${PREFIX}messages/${encodeURIComponent(args.message_id)}`, undefined, signal), args.offset ?? 0))
    add('kode_sessions_diagnostics', 'Inspect this session’s durable message counts, bounded message IDs, delivery evidence and pending cancellation count. Read-only; does not probe peers, resume a runtime or prove health. Use message IDs with delivery/cancellation status tools.', {}, async (_args, signal) => client.call(`${PREFIX}sessions/${encodeURIComponent(agent.id)}/diagnostics`, undefined, signal))
    add('kode_sessions_read', 'Read bounded message/receipt pages after a durable cursor. Follow cursor until an empty page. Truncated content includes an authenticated full-message continuation tool.', { after: { type: 'integer' } }, async (args, signal) => readEvents(args.after, signal))
    add('kode_sessions_wait', 'Wait up to 30 seconds for a message or receipt event. Does not send or interrupt.', { after: { type: 'integer', required: true }, timeout_seconds: { type: 'integer' } }, async (args, signal) => {
      const until = Date.now() + Math.max(1, Math.min(30, args.timeout_seconds ?? 15)) * 1000
      do {
        const events = await readEvents(args.after, signal)
        if (events.events.length) return events
        await sleep(500, signal)
        signal?.throwIfAborted()
      } while (Date.now() < until)
      return { events: [], cursor: args.after, timed_out: true }
    })
    for (const tool of memoryTools) add(tool.name, tool.description, tool.parameters, (args, signal) => client.call(`${PREFIX}memory/tool`, { name: tool.name, arguments: args }, signal))
    entry.task = pump(entry)
    entry.controlTask = entry.inputCancellation ? pumpCancellation(entry) : Promise.resolve()
  }
  // Control must not queue behind delivery recovery, inbox flushing or receipts.
  // Both loops share the session lifetime, but neither awaits the other to run.
  async function pumpCancellation(entry) {
    const { agent, client } = entry
    const signal = AbortSignal.any([stop.signal, entry.stop.signal])
    while (!signal.aborted) {
      if (!runtimeReady) { await sleep(runtimeConfig.pollMs ?? 1000, signal); continue }
      try {
        let after = ''
        do {
          const page = await client.call(`${PREFIX}sessions/${encodeURIComponent(agent.id)}/cancellations?after=${encodeURIComponent(after)}`, undefined, signal)
          for (const control of page.cancellations) {
            const result = typeof agent.cancelInput === 'function'
              ? await agent.cancelInput(control.input_id)
              : { state: 'cancel_unconfirmed', reason: 'runtime_unsupported' }
            await client.call(`${PREFIX}messages/${encodeURIComponent(control.message_id)}/cancellation/result`, {
              session_id: String(agent.id), input_id: control.input_id, ...result,
            }, signal)
          }
          after = page.next
        } while (after)
      } catch (error) {
        if (!signal.aborted) ctx.logger.warn('Kode input cancellation connection failed: %s', error.message)
      }
      await sleep(runtimeConfig.pollMs ?? 1000, signal)
    }
  }
  async function pump(entry) {
    const { agent, client } = entry
    const signal = AbortSignal.any([stop.signal, entry.stop.signal])
    while (!signal.aborted) {
      if (!runtimeReady) { await sleep(runtimeConfig.pollMs ?? 1000, signal); continue }
      try {
        const title = sessionTitle(agent)
        if (title !== entry.title && Date.now() >= entry.titleRetryAt) {
          try {
            await client.call(`${PREFIX}sessions/${encodeURIComponent(agent.id)}/title`, { title }, signal)
            entry.title = title
          } catch { entry.titleRetryAt = Date.now() + 30000 }
        }
        await entry.delivery?.recover(signal)
        while (entry.receipts.length) {
          const receipt = entry.receipts[0]
          await client.call(`${PREFIX}messages/${receipt.id}`, receipt.body, signal)
          entry.receipts.shift()
        }
        const pending = await client.call(`${PREFIX}sessions/${encodeURIComponent(agent.id)}/claim`, {}, signal)
        for (const message of pending.messages) {
          let status = 'accepted', detail
          try {
            if (message.in_reply_to && entry.readReplies.has(message.id)) {
              await client.call(`${PREFIX}messages/${message.id}`, { session_id: String(agent.id), status: 'accepted' }, signal)
              continue
            }
            // Prepare before any runtime side effect; failures follow the uncertain settlement path.
            if (entry.delivery) await entry.delivery.prepare(message, signal)
            // Reading a reply can race the durable prepare request above.
            // Recheck immediately before the synchronous inbox submission.
            if (message.in_reply_to && entry.readReplies.has(message.id)) {
              await client.call(`${PREFIX}messages/${message.id}`, { session_id: String(agent.id), status: 'accepted' }, signal)
              continue
            }
            // followup queues a distinct turn; it never answers an outstanding approval.
            const inputId = entry.delivery ? deliveryInputId(message.id) : randomUUID()
            if (message.in_reply_to) entry.queuedReplies.set(message.id, inputId)
            const binding = ctx.get?.('kodeAgents')?.profiles?.binding(agent.id)
            const mandate = await coordinatorInput(admin, binding, message, inputId, signal) ?? await builderInput(admin, binding, message, inputId, signal) ?? await assignmentInput(admin, binding, message, inputId, signal)
            signal.throwIfAborted()
            agent.followup(mandate ?? relayInput(message, inputId))
            // Acceptance is reported only after the inbox has reached persistence listeners.
            // Tracked delivery owns its evidence flush in confirm().
            if (!entry.delivery) await agent.ctx.parallel('session/flush', agent.session)
          } catch {
            status = 'uncertain'; detail = 'dsh inbox submission outcome is uncertain; no automatic retry'
          }
          if (entry.delivery && status === 'accepted') {
            // On transport failure, recovery inspects the durable input instead of replaying it.
            try {
              await entry.delivery.confirm(message, signal)
              continue
            } catch (error) {
              // Only a known lack of runtime evidence settles as uncertain.
              // Network/flush errors retain recovery ownership, never overwrite
              // a receipt that may already have committed remotely.
              if (!(error instanceof DeliveryEvidenceUnavailable)) throw error
              status = 'uncertain'; detail = error.message
            }
          }
          const body = { session_id: String(agent.id), status, detail }
          entry.receipts.push({ id: message.id, body })
          await client.call(`${PREFIX}messages/${message.id}`, body, signal)
          entry.receipts.shift()
        }
      } catch (e) {
        if (!signal.aborted) ctx.logger.warn('Kode session connection failed: %s', e.message)
      }
      await sleep(runtimeConfig.pollMs ?? 1000, signal)
    }
  }
  ctx.effect(() => async () => {
    stop.abort()
    await Promise.allSettled([...installing.values()])
    await wakeTask
    const entries = [...active.values()]; active.clear()
    for (const entry of entries) { entry.stop.abort(); for (const dispose of entry.tools) dispose() }
    await Promise.allSettled(entries.map(async entry => { await Promise.allSettled([entry.task, entry.controlTask]); await entry.client.call(`${PREFIX}sessions/${encodeURIComponent(entry.agent.id)}/offline`, {}) }))
    await saving
  }, 'kode.lifetime')
  ctx.on('agent/created', async ({ agent }) => { await install(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const entry = active.get(agent.id)
    if (!entry || entry.agent !== agent) return
    active.delete(agent.id); entry.stop.abort()
    for (const dispose of entry.tools) dispose()
    void entry.client.call(`${PREFIX}sessions/${encodeURIComponent(agent.id)}/offline`, {}).catch(() => {})
  })
  for (const agent of ctx.agents.list()) await install(agent)
  // Runtime profiles are independent from messaging; the Kode factory drives native protocols.
  // Minimal/headless Hosts may omit the model and Web capabilities entirely.
  if (runtimeConfig.agentRuntime !== false && ctx.inject) ctx.inject(['llm', 'sessionProjections'], async runtimeCtx => {
    const service = await installAgentRuntime(runtimeCtx, { ...runtimeConfig, quotaHost: node.node_id, backendClient: admin, agentProfilesFile: runtimeConfig.agentProfilesFile ?? join(dirname(stateFile), `agents-${node.node_id}.json`) }).catch(error => { console.error('Kode Agent runtime initialization failed:', error.stack); throw error })
    const hub = new ExtensionHub(admin)
    service.adapter.extensionRevision = async () => (await hub.read()).revision
    const resolveProfile = service.adapter.resolveProfile
    service.adapter.resolveProfile = async (profile, agent) => hub.nativeProfile(await resolveProfile(profile, agent))
    runtimeReady = true
    runtimeCtx.inject(['sessionController', 'typertGateway'], async guardCtx => {
      const { installManagedSessionCommandGuard, installManagedSessionGatewayGuard } = await import('./managed-session-access.js')
      guardCtx.effect(() => installManagedSessionGatewayGuard(guardCtx.get('typertGateway'), service.profiles), 'kode.managed-session-gateway-guard')
      guardCtx.effect(() => installManagedSessionCommandGuard(guardCtx.get('sessionController'), service.profiles), 'kode.managed-session-command-guard')
    })
    runtimeCtx.inject(['webServer', 'connection', 'agentDefaultModel'], async webCtx => {
      const { registerAgentApi } = await import('./agent-api.js')
      webCtx.effect(() => registerAgentHubApi(webCtx, { hub, backend: admin, service }), 'kode.agent-hub-api')
      webCtx.effect(() => registerAgentApi(webCtx, service), 'kode.agent-api')
      const { registerManagedSessionAccess } = await import('./managed-session-access.js')
      webCtx.effect(() => registerManagedSessionAccess(webCtx, service, node.node_id), 'kode.managed-session-access')
      const { registerResourceCoverage } = await import('./resource-coverage.js')
      const { officialResourceDirectory } = await import('./official-resource-directory.js')
      const { registerBuilderModels } = await import('./builder-models-route.js')
      webCtx.effect(() => registerBuilderModels(webCtx, runtimeCtx.llm, node.node_id), 'kode.builder-models-api')
      const { registerBuilderDefaults } = await import('./builder-defaults-route.js')
      webCtx.effect(() => registerBuilderDefaults(webCtx, { backendClient: admin, service: { ...service, officialResourceDirectory: () => officialResourceDirectory(runtimeCtx.llm) }, llm: runtimeCtx.llm, home: node.node_id, defaults: () => {
        const current = webCtx.agentDefaultModel.currentSelection()
        const official = current?.provider && !current.provider.startsWith('kode-agent-') ? { provider: current.provider, model: current.model, effort: current.reasoningEffort ?? null } : {}
        return { ...official, ...runtimeConfig.builderDefaults }
      } }), 'kode.builder-default-selection-api')
      webCtx.effect(() => registerResourceCoverage(webCtx, { ...service, officialResourceDirectory: () => officialResourceDirectory(runtimeCtx.llm) }, admin, node.node_id), 'kode.resource-coverage-api')
      if (service.appearance) { const { registerAvatarApi } = await import('./session-appearance.js'); webCtx.effect(() => registerAvatarApi(webCtx, service.appearance), 'kode.avatar-api') }
      if (runtimeConfig.sharedBackendState) webCtx.inject(['sessionController'], sessionCtx => sessionCtx.effect(() => {
        const lifetime = new AbortController()
        const task = import('./workbench-import.js').then(({ syncNativeTabs }) => syncNativeTabs(sessionCtx.sessionController, admin, service.profiles, lifetime.signal))
          .catch(error => { if (!lifetime.signal.aborted) ctx.logger.warn('Kode native session catalog sync failed: %s', error.message) })
        return async () => { lifetime.abort(); await task }
      }, 'kode.native-catalog-sync'))
    })
  })
  // Resume through the public Session controller: it restores the recorded preset,
  // model selection, persistence ownership and archive admission policy.
  if (runtimeConfig.resumeInactive !== false && ctx.get) wakeTask = wakeInactive()
  async function wakeInactive() {
    const retryAfter = new Map()
    while (!stop.signal.aborted) {
      // Services mount independently; the Web Session controller can become
      // available after this plugin has finished starting.
      const controller = ctx.get('sessionController')
    if (!controller || !runtimeReady) { await sleep(runtimeConfig.resumePollMs ?? 2000, stop.signal); continue }
      for (const id of Object.keys(tokens)) {
        if (stop.signal.aborted) return
        if (active.has(id) || installing.has(id) || ctx.agents.get(id) || (retryAfter.get(id) ?? 0) > Date.now()) continue
        try {
          const pending = await admin.forSession(tokens[id]).call(`${PREFIX}sessions/${encodeURIComponent(id)}/pending`, undefined, stop.signal)
          if (!pending.pending) continue
          // The Session API has no cancellation argument. Stop waiting on plugin
          // teardown, while still observing rejection of a late resolution.
          let aborted
          const cancelled = new Promise(resolve => {
            aborted = () => resolve(undefined)
            stop.signal.addEventListener('abort', aborted, { once: true })
            if (stop.signal.aborted) aborted()
          })
          let result
          try { result = await Promise.race([controller.resolveAgent(id), cancelled]) }
          finally { stop.signal.removeEventListener('abort', aborted) }
          if (!result || stop.signal.aborted) return
          if (result.error) throw new Error(result.error.message)
          await install(result.agent)
        } catch (e) {
          if (stop.signal.aborted) return
          retryAfter.set(id, Date.now() + 30_000)
          ctx.logger.warn('Kode could not resume session %s: %s', id, e.message)
        }
      }
      await sleep(runtimeConfig.resumePollMs ?? 2000, stop.signal)
    }
  }
}
