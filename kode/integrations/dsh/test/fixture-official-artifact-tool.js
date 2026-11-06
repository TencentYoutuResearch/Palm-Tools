import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { mountOfficialArtifactTool, OFFICIAL_ARTIFACT_TOOL } from '../src/official-artifact-tool.js'
import { acquireOperationLease } from '../src/operation-lease.js'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
const exec = promisify(execFile)

for (const remoteMode of [false, true]) test(`scoped official capture uses fixed workspace and home revocation (remote=${remoteMode})`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 60000 }, async () => {
  const hub = await isolatedHub('official-artifact'), ctx = new Context(); let execution, host, home
  try {
    home = remoteMode ? await isolatedHub('artifact-authority') : hub
    if (remoteMode) await pairHubs(home, hub)
    const call = (path, body) => home.client.call(`/api/v1/messaging/${path}`, body)
    await mkdir(join(hub.root, 'repo')); const root = await realpath(join(hub.root, 'repo'))
    const git = args => exec('/usr/bin/git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } })
    await git(['init', '-q']); await writeFile(join(root, 'main.txt'), 'initial'); await git(['add', '.']); await git(['commit', '-qm', 'fixture'])
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }); await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' }), worker = hub.client.forSession(registration.owner_token)
    const op = await call('operations', { owner_session: 'owner', request_key: 'capture', worker: { node_id: hub.node, session_id: 'worker' }, grant_required: true })
    const scope = { team_id: 'team', revision: 1, target: { host: hub.node, workspace: 'fixture', root }, capabilities: ['read', 'workspace_write'], tools: [OFFICIAL_ARTIFACT_TOOL, 'fixture_write'], network: false, budget_ids: [] }
    const policy = { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000, targets: [scope.target], capabilities: scope.capabilities, tools: scope.tools, network: false, budget_ids: [] }
    await call('team-grants', { expected_revision: 0, policy })
    await call(`operations/${op.id}/grant`, { expected_revision: op.revision, binding: { grant_id: 'grant', attempt: 1, epoch: 1, scope } })
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'official', name: 'Official', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: { id: op.id, attempt: 1, epoch: 1, ...(remoteMode ? { home_node: home.node } : {}) } })
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'fixture', path: root }] }); ctx.provide('kodeOfficialToolPolicies', new OfficialToolPolicies())
    ctx.provide('kodeOperationLeases', { acquire: (agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: hub.node, session_id: agent.id, grant_enforcement: true }, { signal, leaseMs: 15000 }) })
    execution = new OfficialExecution(ctx, profiles, hub.client, { host: hub.node }); host = new OfficialLoopHost(ctx, execution)
    const captureUnderLock = execution.artifacts.capture.bind(execution.artifacts)
    execution.artifacts.capture = async (...args) => {
      await assert.rejects(execution.workspaceLocks.acquire(root, 'competing-writer'), { code: 'WORKSPACE_BUSY' })
      return captureUnderLock(...args)
    }
    const fixed = { workspaceRoot: root, repositoryId: 'fixture' }
    const owned = await host.create({ sessionId: 'worker', agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: root }, setup: (agentCtx, agent) => {
      agentCtx.effect(() => mountOfficialArtifactTool(agentCtx, agent, execution, fixed))
      agentCtx.effect(() => {
        const tools = agentCtx.get('tools').forScope(agentCtx)
        const remove = tools.register({ name: 'fixture_write', description: 'Write fixed fixture file', parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: async () => {
            await assert.rejects(execution.workspaceLocks.acquire(root, 'competing-reader'), { code: 'WORKSPACE_BUSY' })
            await writeFile(join(root, 'main.txt'), 'changed'); return 'written'
          },
        })
        const unpolicy = agentCtx.get('kodeOfficialToolPolicies').register('fixture_write', { capabilities: ['workspace_write'], network: false,
          implementation: tools.get('fixture_write', agent), authorize: async (request, scope) => request.agent === agent && scope.root === root && Object.keys(request.arguments).length === 0,
        }, agent)
        return () => { unpolicy(); remove() }
      })
    } }, { tools: [OFFICIAL_ARTIFACT_TOOL, 'fixture_write'] })
    fixed.workspaceRoot = '/outside-fixture'
    assert.equal(ctx.tools.get(OFFICIAL_ARTIFACT_TOOL), undefined)
    const request = (id, args) => ({ agent: owned.agent, name: OFFICIAL_ARTIFACT_TOOL, callId: id, arguments: args })
    const writer = id => ({ agent: owned.agent, name: 'fixture_write', callId: id, arguments: {} })
    const competing = await execution.workspaceLocks.acquire(root, 'external-controlled-writer')
    try {
      await assert.rejects(owned.run.execute(request('blocked-capture', { evidence_id: 'blocked' })), { code: 'WORKSPACE_BUSY' })
      await assert.rejects(owned.run.execute(writer('blocked-write')), { code: 'WORKSPACE_BUSY' })
      assert.equal(profiles.binding('worker').officialTools?.['blocked-capture'], undefined)
      assert.equal(profiles.binding('worker').officialTools?.['blocked-write'], undefined)
    } finally { await competing.release() }
    await assert.rejects(owned.run.execute(request('escape', { evidence_id: 'snapshot', workspaceRoot: '/outside-fixture' })), /arguments exceed grant/)
    const capture = async (callId, evidenceId) => JSON.parse((await owned.run.execute(request(callId, { evidence_id: evidenceId }))).content[0].text)
    const first = await capture('capture-1', 'snapshot-1')
    const releasedLock = await execution.workspaceLocks.acquire(root, 'after-capture'); await releasedLock.release()
    assert.equal(first.home_reconciled, true); assert.equal(first.completion_authorized, false)
    assert.equal((await owned.run.execute(writer('write-1'))).isError, false)
    assert.deepEqual(await capture('capture-retry', 'snapshot-1'), first, 'same evidence identity never recaptures')
    const next = await capture('capture-2', 'snapshot-2')
    assert.notEqual(next.snapshot_hash, first.snapshot_hash)
    const audit = await call(`operations/${op.id}/events`)
    assert.equal(audit.events.filter(e => e.data.kind === 'artifact_evidence').length, 2)
    assert.ok(audit.events.filter(e => e.data.kind === 'artifact_evidence').every(e => e.data.producer.node_id === hub.node))
    if (remoteMode) await assert.rejects(hub.client.call(`/api/v1/messaging/operations/${op.id}`), /404/)
    assert.equal(audit.events.filter(e => e.data.kind === 'tool_evidence').length, 4)
    await call('team-grants', { expected_revision: 1, policy: { ...policy, enabled: false } })
    await assert.rejects(capture('revoked', 'snapshot-3'), /grant|lease|resource/)
    assert.equal(Object.keys(profiles.binding('worker').artifactOutbox).length, 2)
  } finally { await host?.close(); await execution?.close(); await ctx.fiber.dispose(); await hub.close(); if (home && home !== hub) await home.close() }
})
