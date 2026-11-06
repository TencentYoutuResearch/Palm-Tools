/** Isolated official Worker Host used by cross-Hub workflow integration fixtures. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { readdir, chmod } from 'node:fs/promises'
import { AgentProfiles } from '../../src/agent-profiles.js'
import { OfficialExecution } from '../../src/official-execution.js'
import { OfficialLoopHost } from '../../src/official-loop-host.js'
import { OfficialToolPolicies } from '../../src/official-grant-guard.js'
import { AssignmentDispatchHost } from '../../src/assignment-dispatch-host.js'
import { RemoteAssignmentDiscovery } from '../../src/remote-assignment-discovery.js'
import { RemoteAssignmentService } from '../../src/remote-assignment-service.js'
import { apply as applyHost } from '../../src/host.js'
const requireLoop = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(requireLoop.resolve('@deepseek-ai/dsh-tools'))

export async function remoteWorkflowRuntime({ hub, root, adapter, errors }) {
  const ctx = new Context()
  let execution, host, discovery, service
  const states = [], requests = new Map(), completed = []
  let sequence = 0
  const client = { async call(path, body, signal) {
    const id = ++sequence, row = { id, action: body?.accounting?.action?.kind ?? path, started_at: Date.now() }
    requests.set(id, row)
    try { return await hub.client.call(path, body, signal) }
    finally { requests.delete(id); completed.push({ ...row, finished_at: Date.now() }); if (completed.length > 32) completed.shift() }
  } }
  const close = async () => {
    host?.stop.abort(new Error('Remote fixture closing'))
    await discovery?.close(); await service?.close(); await host?.close(); await execution?.close(); await ctx.fiber.dispose()
    // Derived sources are intentionally read-only during execution.
    for (const name of await readdir(join(hub.root, 'artifact-workspaces')).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
      await chmod(join(hub.root, 'artifact-workspaces', name, 'source'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
    await ctx.plugin(persistence, { root: join(hub.root, 'sessions'), compression: 'zstd' })
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'profile', name: 'Coordinator', type: 'dsh' }])
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'remote-workspace', path: root }] })
    ctx.provide('kodeOfficialToolPolicies', new OfficialToolPolicies())
    ctx.on('agent/error', event => errors.push(event.error.message))
    ctx.llm.registerAdapter(['fixture'], adapter)
    execution = new OfficialExecution(ctx, profiles, client, { host: hub.node })
    host = new OfficialLoopHost(ctx, execution)
    ctx.provide('kodeAgents', { profiles, officialExecution: execution, officialLoops: host })
    await applyHost(ctx, { url: hub.url, tokenFile: join(hub.root, 'admin.token'), stateFile: join(hub.root, 'host-state.json'), agentRuntime: false, runtimeBridge: false, pollMs: 10 })
    const dispatcher = new AssignmentDispatchHost(host)
    discovery = new RemoteAssignmentDiscovery(dispatcher, { intervalMs: 100, onState: state => states.push(state) })
    service = new RemoteAssignmentService(dispatcher, { intervalMs: 100, onState: state => states.push(state) })
    discovery.start(); service.start()
    return { ctx, profiles, execution, host, states, requests, completed, close }
  } catch (error) { await close(); throw error }
}
