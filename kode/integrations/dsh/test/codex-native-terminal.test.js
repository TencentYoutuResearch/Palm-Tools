/** Installed engine with an owned Responses peer. No model-service inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexManagedDecision } from '../src/codex-managed-decision.js'
import { nativeDecisionProvider } from './support/native-decision-provider.js'

const cases = [true, false].flatMap(allowUserInput => ['text', 'tool'].map(kind => ({ allowUserInput, kind })))
cases.push({ allowUserInput: true, kind: 'tool', stalled: true })
for (const { allowUserInput, kind, stalled } of cases) test(`installed engine ${stalled ? 'rejects missing EOF for' : 'completes'} ${kind} with native questions ${allowUserInput}`,  {
  skip: !process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE, timeout: 30000,
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-native-terminal-')))
  const call = { id: 'terminal-call', name: 'kode_read_source', arguments: '{"path":"fixture.txt"}' }
  const provider = await nativeDecisionProvider(({ tools }) => {
    assert.equal(tools.some(tool => tool.name === 'request_user_input'), allowUserInput)
    return { ...(stalled ? { holdResponseOpen: true } : { endResponseAfterMs: 100 }), ...(kind === 'tool' ? { call } : { text: 'Checked fixture' }) }
  })
  let admissions = 0
  const decision = new CodexManagedDecision({ cwd: root, stateRoot: root, endpoint: provider.endpoint,
    profile: { type: 'codex', executable: process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE },
    model: 'fixture', effort: 'high', timeoutMs: 20000, allowUserInput, admit: async () => { admissions++ } })
  t.after(async () => {
    await decision.close()
    await provider.close()
    if (!decision.rpc || decision.stopEvidence?.process_group_empty) await rm(root, { recursive: true, force: true })
  })
  await decision.prepare({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect fixture.txt' }] }],
    tools: [{ name: 'kode_read_source', description: 'Read granted fixture source', parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] })
  const result = await decision.execute()
  if (stalled) {
    assert.equal(result.failure?.code, 'managed_cli_upstream_drain_timeout')
    assert.deepEqual(result.calls, [])
    assert.deepEqual(result.texts, [])
    assert.equal(result.stop.process_group_empty, true)
    assert.equal(admissions, 1)
    assert.equal(provider.calls, 1)
    return
  }
  assert.equal(result.failure, undefined)
  assert.equal(result.transport_completion, 'upstream_eof_with_peer_close')
  assert.equal(result.terminal, kind === 'tool' ? 'interrupted' : 'completed')
  assert.equal(result.usage.input_tokens, 1)
  assert.equal(result.usage.output_tokens, 1)
  assert.equal(result.stop.leader_exited, true)
  assert.equal(result.stop.process_group_empty, true)
  assert.deepEqual(result.stop.signal_failures, [])
  assert.equal(admissions, 1)
  assert.equal(provider.calls, 1)
  assert.deepEqual(provider.errors, [])
  if (kind === 'tool') assert.deepEqual(result.calls, [{ type: 'tool-call', ...call }])
  else assert.deepEqual(result.texts, ['Checked fixture'])
})
