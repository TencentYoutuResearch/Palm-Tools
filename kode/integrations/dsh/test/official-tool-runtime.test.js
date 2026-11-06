/** Actual Hub + actual dsh ToolRuntime + controlled execution/journal, without inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { mkdir, realpath, writeFile, readFile } from 'node:fs/promises'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { OfficialExecution } from '../src/official-execution.js'
import { acquireOperationLease } from '../src/operation-lease.js'

for (const scenario of ['grant_revoked', 'tool_replaced', 'tool_error']) test(`real official tool dispatch records results and fences ${scenario}`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('official-tool-runtime'), ctx = new Context()
  let execution, run
  try {
    const call = (path, body) => hub.client.call(`/api/v1/messaging/${path}`, body)
    await mkdir(join(hub.root, 'workspace'))
    const root = await realpath(join(hub.root, 'workspace'))
    await writeFile(join(root, 'input.txt'), 'fixture file')
    const registration = await call('sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await call('operations', { owner_session: 'owner', request_key: 'official-tool', worker: { node_id: hub.node, session_id: 'worker' }, grant_required: true })
    const policy = { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000, targets: [{ host: hub.node, workspace: 'workspace', root }], capabilities: ['read'], tools: ['read_fixture'], network: false, budget_ids: [] }
    await call('team-grants', { expected_revision: 0, policy })
    await call(`operations/${op.id}/grant`, { expected_revision: op.revision, binding: { grant_id: 'grant', attempt: 1, epoch: 1,
      scope: { team_id: 'team', revision: 1, target: policy.targets[0], capabilities: ['read'], tools: ['read_fixture'], network: false, budget_ids: [] } } })
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'official', name: 'Official', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: { id: op.id, attempt: 1, epoch: 1 } })
    const agent = { id: 'worker', ctx, session: { id: 'worker', header: { cwd: root } } }
    ctx.provide('systemPrompt', { tools: () => () => {} }); await ctx.plugin(Tools)
    ctx.provide('agents', { get: id => id === 'worker' ? agent : undefined })
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', path: root }] })
    ctx.provide('kodeOperationLeases', { acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding,
      { node_id: hub.node, session_id: agent.id, grant_enforcement: true }, { signal, leaseMs: 10000 }) })
    const policies = new OfficialToolPolicies()
    ctx.provide('kodeOfficialToolPolicies', policies)
    let reads = 0, failNext = false
    const definition = { name: 'read_fixture', description: 'Read fixed fixture', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => {
        reads++
        if (failNext) {
          await writeFile(join(root, 'partial.txt'), 'partial side effect')
          throw new Error('fixture failed after side effect')
        }
        return readFile(join(root, 'input.txt'), 'utf8')
      },
    }
    const removeTool = ctx.tools.register(definition)
    policies.register('read_fixture', { capabilities: ['read'], network: false, implementation: ctx.tools.get('read_fixture', agent), authorize: async request => request.arguments?.path === 'input.txt' })
    execution = new OfficialExecution(ctx, profiles, hub.client, { host: hub.node })
    const request = { agent, name: 'read_fixture', arguments: { path: 'input.txt' }, callId: 'read-1', signal: new AbortController().signal }
    assert.equal((await ctx.tools.execute(request)).isError, true); assert.equal(reads, 0)
    run = await execution.open(agent, { tools: ['read_fixture'] })
    const result = await run.execute(request)
    assert.equal(result.isError, false); assert.equal(result.content[0].text, 'fixture file'); assert.equal(reads, 1)
    assert.equal(profiles.binding('worker').officialTools['read-1'].status, 'returned')
    assert.equal(profiles.binding('worker').officialTools['read-1'].home_reconciled, true)
    assert.ok(Number.isSafeInteger(profiles.binding('worker').officialTools['read-1'].home_sequence))
    await assert.rejects(run.execute(request), /already recorded/); assert.equal(reads, 1)
    await assert.rejects(run.execute({ ...request, callId: 'denied', arguments: { path: 'outside' } }), /arguments exceed grant/)
    assert.equal(profiles.binding('worker').officialTools.denied, undefined)
    if (scenario === 'tool_error') {
      failNext = true
      await assert.rejects(run.execute({ ...request, callId: 'partial' }), /requires reconciliation/)
      assert.equal(await readFile(join(root, 'partial.txt'), 'utf8'), 'partial side effect')
      const record = profiles.binding('worker').officialTools.partial
      assert.equal(record.status, 'uncertain')
      assert.equal(record.home_reconciled, true)
      assert.ok(Number.isSafeInteger(record.home_sequence))
      await assert.rejects(run.execute({ ...request, callId: 'retry' }), /reconcil/i)
      await assert.rejects(run.finish(), /reconcil/i)
      assert.equal(reads, 2)
      assert.equal(profiles.binding('worker').officialTools.retry, undefined)
      assert.notEqual((await call(`operations/${op.id}`)).state, 'reported')
      return
    }
    if (scenario === 'tool_replaced') {
      removeTool()
      ctx.tools.register({ ...definition, execute: async () => { reads++; return 'replacement body' } })
    } else await call('team-grants', { expected_revision: 1, policy: { ...policy, enabled: false } })
    await assert.rejects(run.execute({ ...request, callId: 'revoked' }), /grant|resource|lease|implementation changed/i)
    assert.equal(reads, 1)
    assert.equal((await ctx.tools.execute({ ...request, callId: 'raw-after-revoke' })).isError, true)
    assert.equal(reads, 1)
    assert.notEqual((await call(`operations/${op.id}`)).state, 'reported')
  } finally { run?.dispose(); await execution?.close(); await ctx.fiber.dispose(); await hub.close() }
})
