import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, realpath, symlink, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { OfficialToolPolicies, officialGrantGuard } from '../src/official-grant-guard.js'
import { acquireOperationLease } from '../src/operation-lease.js'

test('derived writable task retains live original Host registration and Home grant checks', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kode-task-grant-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const original = join(directory, 'original'), task = join(directory, 'task'), another = join(directory, 'another')
  for (const path of [original, task, another]) await mkdir(path)
  const authority = { team_id: 'team', revision: 1, target: { host: 'host', workspace: 'source', root: original },
    capabilities: ['read', 'workspace_write'], tools: ['write'], network: false, budget_ids: [] }
  const operation = { id: 'operation', attempt: 1, epoch: 1 }
  const row = { operation_id: operation.id, attempt: 1, epoch: 1, worker: { node_id: 'host', session_id: 'worker' },
    grant_required: true, available: true, binding: { grant_id: 'grant', scope: authority },
    execution_workspace: { kind: 'derived_task_worktree', scope_authorized: true, operation_id: operation.id, attempt: 1, epoch: 1,
      repository: original, authority_scope: authority, scope: { ...authority, target: { host: 'host', workspace: 'task-key', root: task } } } }
  const implementation = {}, policies = new OfficialToolPolicies()
  policies.register('write', { implementation, capabilities: ['workspace_write'], network: false, authorize: () => true })
  const agent = { id: 'worker', session: { header: { cwd: task } }, ctx: { tools: { get: () => implementation } } }
  let registrations = [{ id: 'source', path: original }]
  const ctx = { get: key => key === 'workspaceRegistry' ? { list: () => registrations } : key === 'kodeOfficialToolPolicies' ? policies : null }
  let validations = 0
  const guard = await officialGrantGuard(ctx, { call: async () => structuredClone(row) }, agent, operation, ['write'], 'host', async () => { validations++; return task })
  assert.equal(await guard.check(), task)
  const before = validations
  registrations = []
  await assert.rejects(guard.check(), /source registration changed/)
  registrations = [{ id: 'source', path: another }]
  await assert.rejects(guard.check(), /source registration changed/)
  assert.equal(validations, before, 'known Host registration loss is rejected before using the checkout')
  registrations = [{ id: 'source', path: original }]
  assert.equal(await guard.check(), task)
  row.available = false
  await assert.rejects(guard.check(), /grant changed/)
})

test('official grant guard enforces registered real workspace and trusted tool policy before execution', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub, execution, run
  try {
    hub = await isolatedHub('official-grant-guard')
    await mkdir(join(hub.root, 'workspace')); await mkdir(join(hub.root, 'outside'))
    const root = await realpath(join(hub.root, 'workspace'))
    await symlink(join(hub.root, 'outside'), join(root, 'escape'))
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    await hub.client.call('/api/v1/messaging/team-grants', { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000, targets: [{ host: hub.node, workspace: 'workspace', root }], capabilities: ['read'], tools: ['read', 'write', 'fetch', 'unknown'], network: false, budget_ids: [] } })
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'guard', worker: { node_id: hub.node, session_id: 'worker' }, grant_required: true })
    const binding = { grant_id: 'grant', attempt: 1, epoch: 1, scope: { team_id: 'team', revision: 1, target: { host: hub.node, workspace: 'workspace', root }, capabilities: ['read'], tools: ['read', 'write', 'fetch', 'unknown'], network: false, budget_ids: [] } }
    await hub.client.call(`/api/v1/messaging/operations/${op.id}/grant`, { expected_revision: 1, binding })
    await assert.rejects(worker.call(`/api/v1/messaging/operations/${op.id}/grant`), /403/)
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    const operation = { id: op.id, attempt: 1, epoch: 1 }
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    let calls = 0, readError = false
    const agent = { id: 'worker', session: { header: { cwd: root } }, ctx: { tools: { execute: async () => { calls++; return readError ? { isError: true, content: [{ type: 'text', text: 'Source missing' }] } : 'fixture result' } } } }
    const implementation = {}
    agent.ctx.tools.get = name => name === 'read' ? implementation : undefined
    const policies = new OfficialToolPolicies()
    assert.throws(() => policies.register('unsafe-errors', { capabilities: ['workspace_write'], network: false, authorize: () => true, readOnlyErrors: true }), /local read/)
    const remove = policies.register('read', { implementation, capabilities: ['read'], network: false,
      readOnlyErrors: true,
      validateArguments: args => typeof args?.path === 'string', authorize: async request => request.arguments?.path === 'safe' })
    policies.register('write', { capabilities: ['workspace_write'], network: false, authorize: async () => true })
    policies.register('fetch', { capabilities: ['read'], network: true, authorize: async () => true })
    const services = { kodeOfficialToolPolicies: policies, workspaceRegistry: { list: () => [{ id: 'workspace', path: root }] }, kodeOperationLeases: { acquire: (_agent, value, signal) => acquireOperationLease(worker, value, { node_id: hub.node, session_id: 'worker', grant_enforcement: true }, { signal, leaseMs: 15000 }) } }
    const ctx = { agents: { get: () => agent }, get: key => services[key] }
    execution = new OfficialExecution(ctx, profiles, hub.client, { host: hub.node })
    for (const tool of ['write', 'fetch', 'unknown']) await assert.rejects(execution.open(agent, { tools: [tool] }), /exceeds grant|trusted policy/)
    assert.equal(execution.authorizesLease(agent, operation), false)
    run = await execution.open(agent, { tools: ['read'] })
    assert.equal(execution.authorizesLease(agent, operation), true)
    assert.equal(execution.authorizesLease({ ...agent }, operation), false)
    assert.equal(execution.authorizesLease(agent, { ...operation, attempt: 2 }), false)
    const invalid = await run.execute({ agent, name: 'read', callId: 'invalid-shape', arguments: { path: 4 } })
    assert.equal(invalid.error.code, 'INVALID_TOOL_ARGUMENTS')
    assert.equal(calls, 0)
    assert.equal(profiles.binding('worker').officialTools['invalid-shape'].home_reconciled, true)
    await assert.rejects(run.execute({ agent, name: 'read', callId: 'denied', arguments: { path: 'outside' } }), /arguments exceed grant/)
    assert.equal(calls, 0)
    assert.equal(profiles.binding('worker').officialTools?.denied, undefined)
    assert.equal(await run.execute({ agent, name: 'read', callId: 'allowed', arguments: { path: 'safe' } }), 'fixture result')
    assert.equal(calls, 1)
    readError = true
    const missing = await run.execute({ agent, name: 'read', callId: 'missing-source', arguments: { path: 'safe' } })
    assert.equal(missing.isError, true)
    assert.equal(profiles.binding('worker').officialTools['missing-source'].status, 'returned')
    assert.equal(profiles.binding('worker').officialTools['missing-source'].reason, 'readonly_tool_error')
    assert.equal(calls, 2)
    agent.session.header.cwd = join(root, 'escape')
    await assert.rejects(run.execute({ agent, name: 'read', callId: 'escape', arguments: { path: 'safe' } }), /outside grant workspace/)
    assert.equal(run.signal.aborted, true); assert.equal(calls, 2)
    assert.equal(execution.authorizesLease(agent, operation), false)
    await assert.rejects(run.execute({ agent, name: 'read', callId: 'invalid-after-authority-loss', arguments: { path: 4 } }))
    assert.equal(profiles.binding('worker').officialTools['invalid-after-authority-loss'], undefined,
      'authority loss must reject before recording even a malformed tool attempt')
    assert.equal(calls, 2)
    agent.session.header.cwd = root
    const guard = await officialGrantGuard(ctx, hub.client, agent, operation, ['read'], hub.node)
    remove()
    await assert.rejects(guard.check(), /policy changed/)
  } finally { run?.dispose(); await execution?.close(); await hub?.close() }
})
