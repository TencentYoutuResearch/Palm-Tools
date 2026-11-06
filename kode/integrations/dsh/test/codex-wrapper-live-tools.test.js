/** Explicitly opt-in live inference. Use only an owner-authorized free resource. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexManagedDecision } from '../src/codex-managed-decision.js'

test('live wrapper proposes a Host tool, stops, and consumes its result in a fresh decision', {
  skip: process.env.KODE_TEST_LIVE_FREE_WRAPPER !== '1', timeout: 240000,
}, async t => {
  const required = ['KODE_TEST_MANAGED_CODEX_WRAPPER', 'KODE_TEST_MANAGED_CODEX_EXECUTABLE',
    'KODE_TEST_WRAPPER_HOME', 'KODE_TEST_WRAPPER_PROVIDER', 'KODE_TEST_NATIVE_MODEL']
  for (const key of required) assert.ok(process.env[key], `Explicit ${key} required`)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-live-wrapper-tools-')))
  const decisions = []
  t.after(async () => {
    for (const decision of decisions) await decision.close()
    if (decisions.every(decision => !decision.rpc || decision.stopEvidence?.process_group_empty)) {
      await rm(root, { recursive: true, force: true })
    }
  })
  const tools = [{ name: 'kode_read_acceptance_marker', description: 'Read the acceptance marker from the Host.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } }]
  const messages = [{ role: 'system', content: [{ type: 'text', text:
    'Use only the supplied Host tools. First call kode_read_acceptance_marker with {}. Once its result appears in the conversation, reply with exactly that marker and no tool call.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Read the acceptance marker and return it.' }] }]
  let admissions = 0
  const run = async () => {
    const decision = new CodexManagedDecision({ cwd: root, stateRoot: root,
      profile: { type: 'codex', executable: process.env.KODE_TEST_MANAGED_CODEX_WRAPPER,
        env: { TCODEX_SKIP_UPDATE: '1', TCODEX_DISABLE_TELEMETRY: '1' } },
      bootstrap: { executable: process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,
        pathVariable: 'TCODEX_CODEX_PATH', provider: process.env.KODE_TEST_WRAPPER_PROVIDER,
        home: process.env.KODE_TEST_WRAPPER_HOME },
      model: process.env.KODE_TEST_NATIVE_MODEL, effort: 'high', timeoutMs: 100000,
      admit: async () => { admissions++ } })
    decisions.push(decision)
    await decision.prepare({ messages, tools })
    const result = await decision.execute()
    if (result.failure) t.diagnostic(JSON.stringify({ decision: decisions.length,
      forwarded: decision.gate.forwarded, state: decision.gate.state, terminal: result.terminal,
      failure_code: result.failure.code ?? null,
      failure_details: result.failure_details,
      retry_fenced: result.failure.message === 'Managed CLI attempted another inference request',
      dispatch_failed: result.failure.message === 'Managed CLI inference dispatch failed',
      usage: result.usage, stopped: result.stop.process_group_empty }))
    assert.equal(Boolean(result.failure), false, result.failure?.code ?? 'native decision failed')
    assert.equal(decision.gate.forwarded, 1)
    assert.ok(result.usage?.input_tokens > 0)
    assert.ok(result.stop.leader_exited && result.stop.process_group_empty)
    assert.deepEqual(result.stop.signal_failures, [])
    return result
  }
  const first = await run()
  assert.equal(first.calls.length, 1)
  const call = first.calls[0]
  assert.equal(call.name, tools[0].name)
  assert.deepEqual(JSON.parse(call.arguments), {})
  // Generate the Host result only after execute proves the first process group stopped.
  const marker = randomUUID()
  messages.push({ role: 'assistant', content: [call] },
    { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: marker }] },
    { role: 'user', content: [{ type: 'text', text: 'The Host tool has completed. Return exactly its marker from the tool result above. Do not call any tools again.' }] })
  const second = await run()
  assert.deepEqual(second.calls, [])
  assert.equal(second.texts.join('').trim() === marker, true)
  assert.equal(admissions, 2)
  assert.notEqual(first.configuration.native_thread_id, second.configuration.native_thread_id)
  t.diagnostic(JSON.stringify({ admissions, provider_requests: 2, host_tools: 1,
    native_threads: 2, stopped_process_groups: 2, model: process.env.KODE_TEST_NATIVE_MODEL,
    usage: [first.usage, second.usage], cost_basis: 'owner_authorized_free_resource' }))
})
