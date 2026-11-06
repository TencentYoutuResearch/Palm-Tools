import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexManagedDecision } from '../src/codex-managed-decision.js'

const messages = [{ role: 'system', content: [{ type: 'text', text: 'Inspect the granted fixture source.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Inspect fixture.txt' }] }]
const tools = [{ name: 'kode_read_source', description: 'Read granted fixture source',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
async function fixture(t, mode, allowUserInput = true, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kode-managed-decision-')))
  let forwarded = 0, admitted = 0, notifyForwarded
  const reached = new Promise(resolve => { notifyForwarded = resolve })
  const upstream = createServer((_request, response) => {
    forwarded++
    notifyForwarded()
    if (options.providerFrames) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(options.providerFrames.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''))
      if (options.delayedEof) {
        const timer = setTimeout(() => response.end(options.providerTrailer ?? ''), 80)
        response.once('close', () => clearTimeout(timer))
      } else if (!options.stalledEof) response.end(options.providerTrailer ?? '')
      return
    }
    if (mode === 'hang' || mode === 'early-tool-hang') { response.writeHead(200); response.write('pending'); return }
    if (mode === 'early-tool' || mode === 'early-text') {
      response.writeHead(200); response.write('pending')
      setTimeout(() => response.end('drained'), 100)
      return
    }
    response.end('fixture')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const decision = new CodexManagedDecision({ cwd: directory, stateRoot: directory,
    endpoint: `http://127.0.0.1:${upstream.address().port}/responses`, model: 'fixture', effort: 'high', allowUserInput,
    profile: { type: 'codex', executable: process.execPath,
      args: [fileURLToPath(new URL('./fixture-managed-codex-decision.js', import.meta.url))],
      env: { KODE_MANAGED_FIXTURE_MODE: mode, ...(options.noNativeUsage ? { KODE_MANAGED_FIXTURE_NO_USAGE: '1' } : {}),
        ...(options.closeAfterTerminal ? { KODE_MANAGED_FIXTURE_CLOSE_AFTER_TERMINAL: '1' } : {}),
        ...(options.foreignClose ? { KODE_MANAGED_FIXTURE_FOREIGN_CLOSE: '1' } : {}) } }, admit: async () => { admitted++ } })
  t.after(async () => {
    await decision.close()
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
    await rm(directory, { recursive: true, force: true })
  })
  return { decision, directory, reached, counts: () => ({ forwarded, admitted }) }
}

test('an early native tool waits for the admitted response to drain before interrupt', async t => {
  const f = await fixture(t, 'early-tool')
  await f.decision.prepare({ messages, tools })
  const result = await f.decision.execute()
  assert.equal(result.failure, undefined)
  assert.equal(result.calls.length, 1)
  assert.equal(result.terminal, 'interrupted')
  assert.equal(f.decision.gate.state, 'completed')
  assert.equal(result.usage.input_tokens, 10)
  assert.equal(result.stop.process_group_empty, true)
})

test('cancellation interrupts response drainage without releasing an early Host tool', async t => {
  const f = await fixture(t, 'early-tool-hang')
  await f.decision.prepare({ messages, tools })
  const requested = new Promise(resolve => f.decision.rpc.once('request', resolve))
  const executing = f.decision.execute()
  await requested
  f.decision.stop.abort(new Error('fixture cancellation'))
  const result = await executing
  assert.ok(result.failure)
  assert.deepEqual(result.calls, [])
  assert.equal(result.stop.process_group_empty, true)
  assert.deepEqual(f.counts(), { admitted: 1, forwarded: 1 })
})

test('a completed text turn drains its admitted response before closing the native process', async t => {
  const f = await fixture(t, 'early-text')
  await f.decision.prepare({ messages, tools })
  const result = await f.decision.execute()
  assert.equal(result.failure, undefined)
  assert.equal(result.failure_details, null)
  assert.deepEqual(result.texts, ['Checked fixture'])
  assert.equal(result.terminal, 'completed')
  assert.equal(f.decision.gate.state, 'completed')
  assert.equal(result.stop.process_group_empty, true)
})

test('managed CLI returns a tool request only after its native process group is stopped', async t => {
  const f = await fixture(t, 'tool')
  const configuration = await f.decision.prepare({ messages, tools })
  assert.equal(configuration.model, 'fixture')
  assert.equal(configuration.reasoningEffort, 'high')
  assert.deepEqual(f.counts(), { forwarded: 0, admitted: 0 })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure, undefined)
  assert.deepEqual(outcome.calls, [{ type: 'tool-call', id: 'decision-call', name: 'kode_read_source',
    arguments: '{"path":"fixture.txt"}' }])
  assert.equal(outcome.stop.leader_exited, true)
  assert.equal(outcome.stop.process_group_empty, true)
  assert.equal(outcome.usage.input_tokens, 10)
  assert.deepEqual(f.counts(), { forwarded: 1, admitted: 1 })
  await assert.rejects(f.decision.execute(), /unavailable/)
})

test('managed CLI preserves bounded text and native counters without tool effects', async t => {
  const f = await fixture(t, 'text')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure, undefined)
  assert.deepEqual(outcome.texts, ['Checked fixture'])
  assert.deepEqual(outcome.calls, [])
  assert.equal(outcome.usage.output_tokens, 2)
})

test('managed CLI collects current-turn usage emitted during graceful close', async t => {
  const f = await fixture(t, 'late-usage')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure, undefined)
  assert.equal(outcome.terminal, 'completed')
  assert.deepEqual(outcome.texts, ['Checked fixture'])
  assert.equal(outcome.usage.input_tokens, 10)
  assert.deepEqual(f.counts(), { forwarded: 1, admitted: 1 })
  assert.equal(outcome.stop.process_group_empty, true)
})

test('managed CLI ignores foreign-thread usage emitted during graceful close', async t => {
  const f = await fixture(t, 'foreign-late-usage')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure, undefined)
  assert.equal(outcome.terminal, 'completed')
  assert.equal(outcome.usage, undefined)
  assert.deepEqual(f.counts(), { forwarded: 1, admitted: 1 })
  assert.equal(outcome.stop.process_group_empty, true)
})

test('managed CLI rejects invalid counters emitted during graceful close', async t => {
  const f = await fixture(t, 'invalid-late-usage')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure.code, 'managed_cli_native_usage_invalid')
  assert.equal(outcome.terminal, 'completed')
  assert.equal(outcome.usage, null)
  assert.deepEqual(f.counts(), { forwarded: 1, admitted: 1 })
})

test('managed CLI ignores usage for a foreign turn emitted during graceful close', async t => {
  const f = await fixture(t, 'foreign-turn-late-usage')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure, undefined)
  assert.equal(outcome.terminal, 'completed')
  assert.equal(outcome.usage, undefined)
  assert.deepEqual(f.counts(), { forwarded: 1, admitted: 1 })
})

test('managed CLI keeps usage fenced when the native peer omits counters', async t => {
  const f = await fixture(t, 'no-usage')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure, undefined)
  assert.equal(outcome.terminal, 'completed')
  assert.equal(outcome.usage, undefined)
  assert.deepEqual(f.counts(), { forwarded: 1, admitted: 1 })
})

for (const mode of ['early-tool-late-usage', 'question-late-usage']) test(`managed CLI suppresses ${mode} effects when native stdout does not drain`, async t => {
  const f = await fixture(t, mode)
  await f.decision.prepare({ messages, tools })
  const stdout = f.decision.rpc.child.stdout
  const resume = stdout.resume.bind(stdout)
  let released = false
  const holdResume = () => released ? resume() : stdout
  const holdAfterTerminal = event => {
    if (event.method !== 'turn/completed') return
    stdout.pause()
    stdout.resume = holdResume
  }
  f.decision.rpc.on('notification', holdAfterTerminal)
  let outcome
  try { outcome = await f.decision.execute() }
  finally {
    released = true
    stdout.resume = resume
    f.decision.rpc.off('notification', holdAfterTerminal)
    resume()
  }
  assert.equal(outcome.failure.code, 'managed_cli_output_drain_unconfirmed')
  assert.equal(outcome.usage, null)
  assert.deepEqual(outcome.calls, [])
  assert.deepEqual(outcome.texts, [])
  assert.equal(outcome.owner_question, null)
  assert.equal(outcome.stop.leader_exited, true)
  assert.equal(outcome.stop.process_group_empty, true)
  assert.deepEqual(f.counts(), { forwarded: 1, admitted: 1 })
})

test('effective configuration mismatch stops before inference admission', async t => {
  const f = await fixture(t, 'mismatch')
  await assert.rejects(f.decision.prepare({ messages, tools }), /configuration mismatch/)
  assert.deepEqual(f.counts(), { forwarded: 0, admitted: 0 })
  assert.equal(f.decision.rpc.process.stopEvidence.leader_exited, true)
})

test('native questions return to the caller after interruption without answering the user', async t => {
  const f = await fixture(t, 'question')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.match(outcome.failure.message, /owner information/)
  assert.deepEqual(outcome.calls, [])
  assert.equal(outcome.owner_question[0].id, 'scope')
  assert.equal(outcome.stop.process_group_empty, true)
})

test('roles without native questions reject an unsolicited native question after stopping', async t => {
  const f = await fixture(t, 'question', false)
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.match(outcome.failure.message, /unsupported operation/)
  assert.equal(outcome.owner_question, null)
  assert.deepEqual(outcome.calls, [])
  assert.equal(outcome.stop.leader_exited, true)
  assert.equal(outcome.stop.process_group_empty, true)
})

test('wrapper-added native tools fail before admission and preserve the exact failure category', async t => {
  const f = await fixture(t, 'extra-native-tool')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure.code, 'managed_cli_tool_contract_changed')
  assert.match(outcome.failure.message, /tool contract changed/)
  assert.deepEqual(outcome.calls, [])
  assert.deepEqual(outcome.texts, [])
  assert.deepEqual(f.counts(), { forwarded: 0, admitted: 0 })
  assert.equal(outcome.stop.leader_exited, true)
  assert.equal(outcome.stop.process_group_empty, true)
})

test('automatic second inference is fenced while the first usage remains available', async t => {
  const f = await fixture(t, 'retry')
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.match(outcome.failure.message, /another inference/)
  assert.equal(outcome.usage.input_tokens, 10)
  assert.deepEqual(outcome.calls, [])
  assert.deepEqual(f.counts(), { forwarded: 1, admitted: 1 })
})

test('unconfirmed process drainage suppresses every proposed Host effect', async t => {
  const f = await fixture(t, 'tool')
  await f.decision.prepare({ messages, tools })
  const process = f.decision.rpc.process, close = process.close
  process.close = async () => ({ ...await close(), process_group_empty: false })
  const outcome = await f.decision.execute()
  assert.match(outcome.failure.message, /stop is unconfirmed/)
  assert.deepEqual(outcome.calls, [])
  assert.equal(outcome.usage.input_tokens, 10)
})

test('cancelling actual upstream inference joins CLI shutdown without publishing tools', async t => {
  const f = await fixture(t, 'hang')
  await f.decision.prepare({ messages, tools })
  const executing = f.decision.execute()
  await f.reached
  await f.decision.close()
  const outcome = await executing
  assert.ok(outcome.failure)
  assert.deepEqual(outcome.calls, [])
  assert.equal(outcome.stop.leader_exited, true)
  assert.equal(outcome.stop.process_group_empty, true)
})

test('managed CLI inherits only explicit profile environment and isolated config directories', async t => {
  const previous = process.env.KODE_MANAGED_PARENT_MARKER
  process.env.KODE_MANAGED_PARENT_MARKER = 'fixture-parent-only'
  t.after(() => {
    if (previous === undefined) delete process.env.KODE_MANAGED_PARENT_MARKER
    else process.env.KODE_MANAGED_PARENT_MARKER = previous
  })
  const f = await fixture(t, 'environment')
  await f.decision.prepare({ messages, tools })
  assert.equal(f.decision.configuration.model, 'fixture')
  assert.deepEqual(f.counts(), { forwarded: 0, admitted: 0 })
})

test('close joins in-flight preparation and leaves no later native process or config directory', async t => {
  const f = await fixture(t, 'tool')
  const preparing = f.decision.prepare({ messages, tools })
  const rejected = assert.rejects(preparing)
  await f.decision.close()
  await rejected
  assert.deepEqual(await readdir(f.directory), [])
  assert.equal(f.decision.rpc?.child.exitCode === null && f.decision.rpc?.child.signalCode === null, false)
  assert.deepEqual(f.counts(), { forwarded: 0, admitted: 0 })
})

const providerFrames = (usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, id = 'owned-response') => [
  { type: 'response.created', response: { id } },
  { type: 'response.completed', response: { id, status: 'completed', model: 'fixture', usage } },
]
for (const mode of ['text', 'tool', 'question']) test(`trusted provider usage covers a missing native ${mode} notification only after shutdown`, async t => {
  const f = await fixture(t, mode, true, { providerFrames: providerFrames(), noNativeUsage: true })
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure?.code, mode === 'question' ? 'worker_clarification_required' : undefined)
  assert.deepEqual(outcome.usage, { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2 })
  assert.equal(outcome.usage_evidence.source, 'codex_admitted_provider_response')
  assert.equal(outcome.usage_evidence.inference_id, f.decision.gate.inferenceId)
  assert.equal(outcome.usage_evidence.native_thread_id, f.decision.threadId)
  assert.equal(outcome.usage_evidence.native_turn_id, f.decision.turnId)
  assert.equal(outcome.usage_evidence.response_id, 'owned-response')
  assert.equal(outcome.stop.process_group_empty, true)
  assert.deepEqual(f.counts(), { admitted: 1, forwarded: 1 })
  if (mode === 'tool') assert.equal(outcome.calls.length, 1)
  if (mode === 'question') assert.equal(outcome.owner_question[0].id, 'scope')
})
test('late matching native usage is retained once; invalid or contradictory evidence never falls back', async t => {
  for (const [mode, frames, code] of [
    ['late-usage', providerFrames(), undefined],
    ['invalid-late-usage', providerFrames(), 'managed_cli_native_usage_invalid'],
    ['tool', providerFrames({ input_tokens: 11, output_tokens: 2, total_tokens: 13 }), 'managed_cli_usage_evidence_conflict'],
  ]) {
    const f = await fixture(t, mode, true, { providerFrames: frames })
    await f.decision.prepare({ messages, tools })
    const outcome = await f.decision.execute()
    assert.equal(outcome.failure?.code, code)
    if (code) {
      assert.equal(outcome.usage, null)
      assert.equal(outcome.usage_evidence, null)
      assert.deepEqual(outcome.calls, [])
      assert.deepEqual(outcome.texts, [])
      assert.equal(outcome.owner_question, null)
    } else assert.equal(outcome.usage_evidence.source, 'codex_thread_token_usage')
  }
})
test('provider bytes with foreign identity or incomplete counters cannot replace absent native usage', async t => {
  for (const frames of [
    providerFrames({ input_tokens: 10, output_tokens: 2 }),
    providerFrames({ input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: {} }),
    [{ type: 'response.created', response: { id: 'foreign' } }, providerFrames()[1]],
  ]) {
    const f = await fixture(t, 'text', true, { providerFrames: frames, noNativeUsage: true })
    await f.decision.prepare({ messages, tools })
    const outcome = await f.decision.execute()
    assert.equal(outcome.usage, undefined)
    assert.equal(outcome.usage_evidence, null)
  }
})
test('a valid provider receipt cannot waive an unconfirmed process stop', async t => {
  const f = await fixture(t, 'tool', true, { providerFrames: providerFrames(), noNativeUsage: true })
  await f.decision.prepare({ messages, tools })
  const process = f.decision.rpc.process, close = process.close
  process.close = async () => ({ ...await close(), process_group_empty: false })
  const outcome = await f.decision.execute()
  assert.match(outcome.failure.message, /stop is unconfirmed/)
  assert.equal(outcome.usage, undefined)
  assert.deepEqual(outcome.calls, [])
})
test('a provider receipt cannot waive unread native stdout or expose a question', async t => {
  const f = await fixture(t, 'question-late-usage', true, { providerFrames: providerFrames(), noNativeUsage: true, foreignClose: true })
  await f.decision.prepare({ messages, tools })
  const stdout = f.decision.rpc.child.stdout, resume = stdout.resume.bind(stdout)
  let released = false
  const pause = event => {
    if (event.method === 'turn/completed') { stdout.pause(); stdout.resume = () => released ? resume() : stdout }
  }
  f.decision.rpc.on('notification', pause)
  let outcome
  try { outcome = await f.decision.execute() }
  finally { released = true; stdout.resume = resume; f.decision.rpc.off('notification', pause); resume() }
  assert.equal(outcome.failure.code, 'managed_cli_output_drain_unconfirmed')
  assert.equal(outcome.usage, null)
  assert.equal(outcome.usage_evidence, null)
  assert.equal(outcome.owner_question, null)
  assert.deepEqual(outcome.calls, [])
})
test('foreign native counters are not borrowed; an independently bound provider receipt remains usable', async t => {
  for (const mode of ['foreign-late-usage', 'foreign-turn-late-usage']) {
    const f = await fixture(t, mode, true, { providerFrames: providerFrames() })
    await f.decision.prepare({ messages, tools })
    const outcome = await f.decision.execute()
    assert.equal(outcome.failure, undefined)
    assert.equal(outcome.usage.input_tokens, 10)
    assert.equal(outcome.usage_evidence.source, 'codex_admitted_provider_response')
  }
})
test('a completed frame followed by truncated data cannot replace missing native usage', async t => {
  const f = await fixture(t, 'text', true, { providerFrames: providerFrames(), providerTrailer: 'data: unfinished', noNativeUsage: true })
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.usage, undefined)
  assert.equal(outcome.usage_evidence, null)
})
test('a different provider label does not discard request-bound usage or verify a model', async t => {
  const frames = providerFrames().map(frame => ({ ...frame, response: { ...frame.response, model: 'provider-label' } }))
  const f = await fixture(t, 'tool', true, { providerFrames: frames, noNativeUsage: true })
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure, undefined)
  assert.equal(outcome.calls.length, 1)
  assert.equal(outcome.usage.input_tokens, 10)
  assert.equal(outcome.usage_evidence.requested_model, 'fixture')
  assert.equal(outcome.usage_evidence.reported_model, 'provider-label')
  assert.equal(outcome.usage_evidence.model_basis, 'requested_model_unverified')
  assert.equal(outcome.configuration.inference_verified, false)
})

for (const mode of ['text', 'tool', 'question']) test(`native ${mode} peer-close still requires true delayed provider EOF`, async t => {
  const f = await fixture(t, mode, true, { providerFrames: providerFrames(), noNativeUsage: true,
    closeAfterTerminal: true, delayedEof: true })
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure?.code, mode === 'question' ? 'worker_clarification_required' : undefined)
  assert.equal(outcome.transport_completion, 'upstream_eof_with_peer_close')
  assert.equal(outcome.usage_evidence.source, 'codex_admitted_provider_response')
  assert.equal(outcome.usage.input_tokens, 10)
  assert.equal(outcome.stop.process_group_empty, true)
  assert.deepEqual(f.counts(), { admitted: 1, forwarded: 1 })
})
for (const stalled of [false, true]) test(`native peer-close ${stalled ? 'stalled EOF' : 'conflicting tail'} cannot publish tool effects`, async t => {
  const f = await fixture(t, 'tool', true, { providerFrames: providerFrames(), noNativeUsage: true,
    closeAfterTerminal: true, delayedEof: !stalled, stalledEof: stalled,
    providerTrailer: `data: ${JSON.stringify(providerFrames()[1])}\n\n` })
  await f.decision.prepare({ messages, tools })
  const outcome = await f.decision.execute()
  assert.equal(outcome.failure?.code, stalled ? 'managed_cli_upstream_drain_timeout' : 'managed_cli_upstream_tail_invalid')
  assert.equal(outcome.usage == null, true)
  assert.equal(outcome.usage_evidence, null)
  assert.deepEqual(outcome.calls, [])
  assert.deepEqual(outcome.texts, [])
  assert.equal(outcome.stop.process_group_empty, true)
  assert.deepEqual(f.counts(), { admitted: 1, forwarded: 1 })
})
