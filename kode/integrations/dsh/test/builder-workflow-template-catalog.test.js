import test from 'node:test'
import assert from 'node:assert/strict'
import { mountOfficialBuilderTools } from '../src/official-builder-tools.js'

test('scoped Builder catalog exposes unregistered methods without registering or activating them', async () => {
  const agent = { id: 'builder' }, operation = { id: 'operation', attempt: 1, epoch: 1 }
  const workspace = { host_id: 'home', workspace_id: 'project', root_ref: '/owned-project' }
  const binding = { managedOperation: operation }, calls = [], entries = new Map(), policies = new Map()
  const draft = { revision: 2, home_hub: 'home', status: 'draft', interview: { workspace_refs: [workspace] } }
  const tools = {
    register: entry => { entries.set(entry.name, entry); return () => entries.delete(entry.name) },
    get: name => entries.get(name),
  }
  const ctx = { get: name => ({
    tools: { forScope: () => tools },
    systemPrompt: { section: () => () => {} },
    kodeOfficialToolPolicies: { register: (name, policy) => { policies.set(name, policy); return () => policies.delete(name) } },
  })[name] }
  const runtime = { host: 'home', profiles: { binding: () => binding }, entry: { assertToolBody: actual => assert.equal(actual, agent) },
    client: { call: async (path, body) => {
      calls.push({ path, body }); assert.equal(body, undefined, 'catalog must perform only reads')
      if (path.endsWith('/builder-scope')) return { scope: { operation_id: operation.id, home_hub: 'home',
        request: { ...operation, draft_id: 'draft' }, worker: { node_id: 'home', session_id: agent.id }, workspaces: [workspace] } }
      if (path.includes('/operations/')) return { ...operation, worker: { node_id: 'home', session_id: agent.id }, budget_required: true, grant_required: true }
      assert.equal(path, '/api/v1/messaging/superagents/drafts/draft'); return structuredClone(draft)
    } } }
  const dispose = await mountOfficialBuilderTools(ctx, agent, runtime, { draft_id: 'draft', team_id: 'team' })
  try {
    const catalog = entries.get('kode_builder_catalog')
    assert.ok(catalog.parameters.properties.kind.enum.includes('workflow_template'))
    const args = { expected_revision: 2, kind: 'workflow_template', after_id: '', after_version: '', limit: 1 }
    const first = await catalog.execute(args), second = await catalog.execute({ ...args, ...first.next_cursor })
    assert.equal(first.has_more, true); assert.equal(second.has_more, false)
    assert.notEqual(first.items[0].id, second.items[0].id)
    for (const page of [first, second]) {
      assert.equal(page.execution_authorized, false); assert.equal(page.registered, false)
      assert.equal(page.items[0].registered, false); assert.equal(Object.hasOwn(page.items[0], 'hash'), false)
    }
    assert.deepEqual(policies.get('kode_builder_catalog').capabilities, ['read'])
    await assert.rejects(catalog.execute({ ...args, expected_revision: 1 }), /revision conflict/)
    await assert.rejects(catalog.execute({ ...args, limit: 0 }), /Invalid Builder/)
    await assert.rejects(catalog.execute({ ...args, command_revision: 'injected' }), /Invalid Builder/)
    draft.interview.workspace_refs = [{ ...workspace, root_ref: '/other-project' }]
    await assert.rejects(catalog.execute(args), /workspace scope changed/)
    assert.ok(calls.every(row => row.body === undefined))
  } finally { dispose() }
  assert.equal(entries.size, 0); assert.equal(policies.size, 0)
})
