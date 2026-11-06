/** Real owned protocol child and HTTP peer through the public adapter; no supplier calls. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '@deepseek-ai/dsh-session'
import { AgentProfiles } from '../src/agent-profiles.js'
import { ManagedCodexAdapter } from '../src/managed-codex-adapter.js'
import { managedCodexRoute } from '../src/managed-codex-profile.js'

for (const [mode, native, complete] of [['text', false, true], ['tool', false, true], ['late-usage', true, true], ['text', false, false]]) {
  test(`managed adapter publishes one usage and retains evidence (mode=${mode}, native=${native}, complete=${complete})`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-provider-adapter-')))
    let requests = 0
    const peer = createServer((_request, response) => {
      requests++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'adapter-response', status: 'completed',
        usage: { input_tokens: 10, output_tokens: 2, ...(complete ? { total_tokens: 12 } : {}) } } })}\n\n`)
    })
    await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve))
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex',
      executable: process.execPath, args: [fileURLToPath(new URL('./fixture-managed-codex-decision.js', import.meta.url))],
      env: { KODE_MANAGED_FIXTURE_MODE: mode, ...(native ? {} : { KODE_MANAGED_FIXTURE_NO_USAGE: '1' }) },
      managedInference: { endpoint: `http://127.0.0.1:${peer.address().port}/responses`, reasoningEfforts: ['high'] } }])
    await profiles.bind('worker', 'fixture')
    await profiles.patchBinding('worker', { managedAssignment: { id: 'assignment' }, managedOperation: { id: 'operation', attempt: 1, epoch: 1 } })
    const seed = Session.create('worker')
    const session = Session.create('worker', undefined, { ...seed.header, cwd: root })
    const agent = { id: 'worker', session, ctx: { parallel: async () => {} } }
    const execution = { assertModelRequest: async () => ({ operation_id: 'operation', call_id: 'call', attempt: 1, epoch: 1 }) }
    const ctx = { agents: { get: id => id === agent.id ? agent : null }, get: key => key === 'kodeAgents' ? { officialExecution: execution } : null }
    const adapter = new ManagedCodexAdapter(ctx, profiles)
    t.after(async () => { await adapter.close(); peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve)); await rm(root, { recursive: true, force: true }) })
    const chunks = []
    for await (const chunk of adapter.streamBound(profiles.get('fixture'), {
      sessionId: 'worker', provider: managedCodexRoute('fixture'), model: 'fixture', reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect fixture' }] }],
      tools: [{ name: 'kode_read_source', parameters: { type: 'object', properties: {} } }],
    })) chunks.push(chunk)
    assert.equal(requests, 1)
    const usages = chunks.filter(row => row.type === 'usage')
    assert.equal(usages.length, complete ? 1 : 0)
    if (complete) assert.deepEqual(usages[0].usage, { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 })
    const records = session.snapshotEvents()
    const decisions = records.filter(row => row.type === 'plugin:kode/managed-cli-decision')
    assert.equal(decisions.length, 1)
    const decision = decisions[0].data
    assert.equal(decision.stop.process_group_empty, true)
    assert.equal(decision.usage_evidence?.source ?? null, complete ? native ? 'codex_thread_token_usage' : 'codex_admitted_provider_response' : null)
    if (complete && !native) {
      assert.equal(decision.usage_evidence.response_id, 'adapter-response')
      assert.equal(decision.usage_evidence.codec_basis, 'codex_responses_rust_v0.154.0')
    }
    const restored = Session.create('worker', JSON.parse(JSON.stringify(records)), session.header, 0)
    assert.deepEqual(restored.snapshotEvents().find(row => row.type === decisions[0].type).data, decision)
    assert.equal(adapter.active.size, 0)
  })
}
