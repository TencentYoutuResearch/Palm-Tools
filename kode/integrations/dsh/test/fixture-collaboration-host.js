/** Owned integration Host: official controller/storage plus Kode workspace and messaging services. */
import { createServer } from 'node:http'
import { createRemoteSession, lookupRemoteSessionCreation, registerSessionCreationRoutes } from '../src/creation-capabilities.js'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import Tools from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as factory from '../src/native-agent-factory.js'
import * as workspaceBackend from '../src/workspace-backend.js'
import WorkspaceRegistry from '../src/workspace-registry.js'
import * as messaging from '../src/host.js'
import { installSessionCreator } from '../src/session-create.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { BackendClient } from '../src/backend-client.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const [root, url, tokenFile, node, executionMode] = process.argv.slice(2)
try {
  const ctx = new Context(), backend = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(ProjectionRegistry)
  ctx.provide('systemPrompt', { tools: () => () => {} }); await ctx.plugin(Tools)
  ctx.provide('agentPresets', { register: async () => () => {}, resolve: async id => ({ id }), mount: async () => {} })
  ctx.provide('agentLoop', {})
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: executionMode === 'native' ? 'codex' : 'custom', executable: process.execPath, ...(executionMode === 'native' ? { args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))] } : {}), defaultModel: 'fixture' }])
  const executionEnabled = new Set()
  let streamStarts = 0, streamAborts = 0
  ctx.provide('kodeAgents', { profiles, hasRuntime: () => true, recordBinding() {}, adapter: { stopBlocked: id => !executionEnabled.has(id), closeSession: async () => {}, listModels: async () => [{ id: 'fixture', isDefault: true }], async *stream({ sessionId, signal }) {
    if (!executionEnabled.has(sessionId)) throw new Error('Fixture execution not enabled')
    streamStarts++
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
    streamAborts++
    throw signal.reason ?? new Error('Fixture aborted')
  } } })
  if (executionMode === 'native') {
    const adapter = new AgentRuntimeAdapter(ctx, profiles)
    const stream = adapter.stream.bind(adapter), blocked = adapter.stopBlocked.bind(adapter)
    adapter.stopBlocked = id => !executionEnabled.has(id) || blocked(id)
    adapter.stream = async function* (options) {
      streamStarts++
      try { yield* stream(options) } finally { if (options.signal.aborted) streamAborts++ }
    }
    ctx.kodeAgents.adapter = adapter
  }
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) })
  ctx.agents.setFactory({ createAgent() { throw new Error('Unexpected official inference') }, resume() { throw new Error('Unexpected official resume') } })
  await ctx.plugin(persistence, { root: join(root, 'sessions'), compression: 'zstd' })
  await ctx.plugin(factory); await ctx.plugin(SessionQuery)
  await ctx.plugin(messaging, { url, tokenFile, stateFile: join(root, 'host-tokens.json'), pollMs: 20, resumePollMs: 20, agentRuntime: false, runtimeBridge: false })
  await ctx.plugin(Storage)
  await ctx.plugin(workspaceBackend); await ctx.plugin(Domain, { backend: 'kode-workspaces' }); await ctx.plugin(WorkspaceRegistry)
  const workspace = await ctx.workspaceRegistry.create(root, 'Fixture workspace')
  for (const [name, value] of Object.entries({
    agentDefaultModel: { currentSelection: () => ({ provider: 'kode-agent-fixture', model: 'fixture' }) },
    attachments: { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: [] } }, fileUploads: { registerAgentResolver: () => () => {} }, fs: {}, llm: {}, remoteAccess: { allows: () => true },
    typert: { resources: { register() {} }, lookups: { configure() {} }, contexts: { configureHost() {} } },
    sessionTitle: { get: () => undefined, rename: (_session, title) => ({ title, eventSeq: 0 }) },
  })) ctx.provide(name, value)
  await ctx.plugin(SessionController, { nativeOpen: false })
  installSessionCreator(ctx, backend, node)
  const selection = { provider: 'kode-agent-fixture', model: 'fixture' }
  const stored = await ctx.sessionPersistence.stat('coordinator')
  const { agent: source } = stored
    ? await ctx.agents.resume({ resumeSessionId: 'coordinator', agentOptions: selection })
    : await ctx.agents.create({ sessionId: 'coordinator', agentOptions: selection, meta: { cwd: root, agentPreset: 'kode-native' } })
  await workspace.attachSession(source.id)
  // Loopback HTTP substitutes only the SSH tunnel and owner admission transport.
  // Creation handlers, portal requests, creator, storage and Hub relay are real.
  const routes = new Map(), cookie = `fixture=${(await readFile(tokenFile, 'utf8')).trim()}`
  let dropCreation = false, remote
  registerSessionCreationRoutes({
    get: name => ctx.get(name), effect: install => install(),
    connection: { admit: req => req.headers.cookie === cookie ? { peer: { principal: { kind: 'owner' } } } : { rejection: {} } },
    webServer: { register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  })
  const server = createServer((req, res) => {
    const handler = routes.get(req.url)
    if (!handler) { res.writeHead(404); res.end(); return }
    if (dropCreation && req.url === '/api/kode/session-create') {
      dropCreation = false
      res.end = () => { res.destroy(); return res }
    }
    Promise.resolve(handler(req, res)).catch(() => res.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  ctx.provide('kodeProjectHosts', {
    hosts: [{ id: 'remote', name: 'Remote fixture', host: 'worker.example' }], load: async () => {},
    connect: async () => {
      if (!remote) throw new Error('Fixture remote is not connected')
      return {
        createSession: (input, signal) => createRemoteSession(remote.url, remote.cookie, input, signal),
        lookupSessionCreation: (input, signal) => lookupRemoteSessionCreation(remote.url, remote.cookie, input, signal),
      }
    },
  })
  process.on('message', async request => {
    try {
      let result
      if (request.name === 'connect-fixture') {
        remote = { url: request.args.url, cookie: `fixture=${(await readFile(request.args.tokenFile, 'utf8')).trim()}` }
        result = { connected: true }
      } else if (request.name === 'drop-creation-response') {
        dropCreation = true; result = { armed: true }
      } else if (request.name === 'enable-execution') {
        const found = await ctx.sessionController.resolveAgent(request.args.session_id)
        if (found.error) throw found.error
        executionEnabled.add(found.agent.id); found.agent.wake()
        result = { enabled: true }
      } else if (request.name === 'cancel-runtime-input') {
        const found = await ctx.sessionController.resolveAgent(request.args.session_id)
        if (found.error) throw found.error
        result = await found.agent.cancelInput(request.args.input_id)
      } else if (request.name === 'native-ready') {
        result = { ready: ctx.kodeAgents.adapter.canSteer?.(request.args.session_id) === true }
      } else if (request.name === 'stop-observation') {
        const found = await ctx.sessionController.resolveAgent(request.args.session_id)
        if (found.error) throw found.error
        result = found.agent.session.snapshotEvents().filter(event => event.type === 'plugin:kode/native-event' && event.data.event.method === 'kode/process_stop').map(event => event.data.event.params)
      } else if (request.name === 'execution-state') {
        result = { starts: streamStarts, aborts: streamAborts }
      } else if (request.name === 'live') {
        result = { active: !!ctx.agents.get(request.args.session_id) }
      } else if (request.name === 'snapshot') {
        const found = await ctx.sessionController.resolveAgent(request.args.session_id)
        if (found.error) throw found.error
        const agent = found.agent
        result = { id: agent.id, workspace: workspace.id, members: [...workspace.sessionIds].sort(), queued: [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(row => row.id), consumed: agent.session.snapshotEvents().filter(row => row.type === 'user/message').length, stored: (await ctx.sessionPersistence.list()).map(row => row.header.id).sort() }
      } else {
        let original
        if (request.dropAssignment) {
          original = BackendClient.prototype.call
          BackendClient.prototype.call = async function(path, body, signal) {
            const value = await original.call(this, path, body, signal)
            if (path === '/api/v1/messaging/messages' && body?.idempotency_key?.startsWith('create:')) throw new Error('Fixture lost assignment response after commit')
            return value
          }
        }
        try {
          const output = await source.ctx.tools.execute({ callId: randomUUID(), agent: source, name: request.name, arguments: request.args, signal: new AbortController().signal })
          if (output.isError) throw new Error(output.content.map(row => row.text ?? '').join(''))
          result = JSON.parse(output.content[0].text)
        } finally { if (original) BackendClient.prototype.call = original }
      }
      process.send({ id: request.id, result })
    } catch (error) { process.send({ id: request.id, error: error.message }) }
  })
  process.send({ type: 'ready', workspace: workspace.id, url: `http://127.0.0.1:${server.address().port}` })
} catch (error) { process.send?.({ type: 'error', error: error.stack ?? error.message }); process.exitCode = 1 }
