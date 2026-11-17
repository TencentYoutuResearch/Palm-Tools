import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ClaudeModelGate, claudeUsage, parseClaudeResponse, readBoundedResponse } from '../src/claude-model-gate.js'
import { parseClaudeDecision, ClaudeManagedDecision, serializeClaudeInput } from '../src/claude-managed-decision.js'
import { normalizeProfile, profileRevision } from '../src/agent-profiles.js'
import { controlledBinding, managedNativeEnabled, managedCodexEnabled } from '../src/managed-codex-profile.js'
const profile = { id: 'claude-worker', name: 'Claude', type: 'claude', args: [], managedInference: {
  bootstrap: { executable: '/fixture/claude', pathVariable: 'TCLAUDE_CLAUDE_PATH', provider: 'fixture', home: '/fixture/home' } } }
const usage = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }
const response = () => ({ id: 'msg_test', model: 'fixture-model', stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage })
test('Claude managed profiles require pinned bootstrap and default to worker-only scope', () => {
  const p = normalizeProfile(profile)
  assert.equal(managedNativeEnabled(p), true); assert.equal(managedCodexEnabled(p), false)
  assert.equal(controlledBinding({ profile: p, managedAssignment: {} }), true)
  for (const b of [{ managedBuilder: {} }, { managedCoordinator: {} }, { managedAssignment: {}, managedBuilder: {} }]) assert.equal(controlledBinding({ profile: p, ...b }), false)
  for (const modified of [{ args: ['--dangerously-skip-permissions'] }, { managedInference: { endpoint: 'https://example.com/v1/messages' } }, { managedInference: { ...profile.managedInference, roles: ['invalid-role'] } }]) assert.throws(() => normalizeProfile({ ...profile, ...modified }))
})
test('Host action protocol rejects unknown tools and never evaluates model text', () => {
  const tools = [{ name: 'read', parameters: { type: 'object' } }]
  assert.equal(parseClaudeDecision('{"texts":[],"calls":[{"name":"read","arguments":{"path":"x"}}]}', tools).calls[0].name, 'read')
  for (const text of ['{"texts":[],"calls":[{"name":"Bash","arguments":{}}]}', '{"texts":[],"calls":[],"execute":"bad"}', '```json\n{}\n```']) assert.throws(() => parseClaudeDecision(text, tools))
})
test('provider usage is complete, exact and cache-inclusive', () => {
  assert.deepEqual(claudeUsage(usage), { input_tokens: 15, cached_input_tokens: 5, cache_write_input_tokens: 7, output_tokens: 2 })
  for (const bad of [{}, { ...usage, output_tokens: -1 }, { ...usage, input_tokens: '3' }]) assert.throws(() => claudeUsage(bad))
  assert.equal(parseClaudeResponse(Buffer.from(JSON.stringify(response())), 'application/json', 'fixture-model').usage.input_tokens, 15)
  for (const body of [{ ...response(), model: 'other' }, { ...response(), stop_reason: 'max_tokens' }, { ...response(), content: [{ type: 'tool_use' }] }]) assert.throws(() => parseClaudeResponse(Buffer.from(JSON.stringify(body)), 'application/json', 'fixture-model'))
})
test('SSE requires identity, exact model and complete usage terminal', () => {
  const events = [{ type: 'message_start', message: { id: 'm', model: 'fixture-model', usage: { ...usage, output_tokens: 0 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
  const encode = events => Buffer.from(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''))
  assert.equal(parseClaudeResponse(encode(events), 'text/event-stream', 'fixture-model').usage.output_tokens, 2)
  assert.throws(() => parseClaudeResponse(encode(events.slice(0, -1)), 'text/event-stream', 'fixture-model'))
  assert.throws(() => parseClaudeResponse(encode([...events, events[0]]), 'text/event-stream', 'fixture-model'))
})
test('bounded response reader rejects oversized data', async () => {
  await assert.rejects(readBoundedResponse(new Response('12345'), 4), /limit/)
})
async function setup(t, admit = async () => {}) {
  let calls = 0
  const upstream = createServer((req, res) => { calls++; req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response())) }) })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const controller = new AbortController(), gate = new ClaudeModelGate({ model: 'fixture-model', admit, signal: controller.signal })
  gate.endpoint = `http://127.0.0.1:${upstream.address().port}`
  const base = await gate.open()
  t.after(async () => { await gate.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) })
  return { gate, controller, calls: () => calls, send: (body = { model: 'fixture-model', tools: [] }) => fetch(base + '/v1/messages', { method: 'POST', body: JSON.stringify(body) }) }
}
test('gate admits exactly one request and rejects retry without a second paid call', async t => {
  let admissions = 0; const x = await setup(t, async () => { admissions++ })
  assert.equal((await x.send()).status, 200); assert.equal(x.gate.receipt.usage.input_tokens, 15)
  assert.equal((await x.send()).status, 502); assert.equal(x.calls(), 1); assert.equal(admissions, 1)
})
test('model drift and native tools fail before admission', async t => {
  for (const body of [{ model: 'other' }, { model: 'fixture-model', tools: [{ name: 'Bash' }] }, { model: 'fixture-model', tools: {} }]) {
    const x = await setup(t, () => { throw Error('must not admit') })
    assert.equal((await x.send(body)).status, 502); assert.equal(x.calls(), 0)
  }
})
test('cancel during admission never forwards a late admitted call', async t => {
  let release; const x = await setup(t, () => new Promise(resolve => { release = resolve }))
  const sent = x.send().catch(() => null)
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  x.controller.abort(); release(); await sent
  assert.equal(x.calls(), 0); assert.equal(x.gate.receipt, undefined)
})
test('close fences asynchronous prepare before process spawn', async () => {
  const actor = new ClaudeManagedDecision({ profile: normalizeProfile(profile), cwd: '/fixture', stateRoot: '/fixture', model: 'fixture-model', bootstrap: profile.managedInference.bootstrap, admit: async () => {} })
  let resume; actor.prepareOwned = async function () { await new Promise(resolve => { resume = resolve }); this.signal.throwIfAborted(); assert.fail('must not spawn') }
  const preparing = actor.prepare({}).catch(error => error)
  const closing = actor.close(); resume(); await closing
  assert.match((await preparing).message, /closed/); assert.equal(actor.process, undefined)
})

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
async function nativeFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kode-claude-fixture-'))
  const fixture = fileURLToPath(new URL('./fixture-claude-managed.js', import.meta.url))
  const quote = v => "'" + v.replaceAll("'", "'\\''") + "'"
  for (const mode of ['wrapper', 'engine']) await writeFile(join(root, mode), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${mode} "$@"\n`, { mode: 0o700 })
  let requests = 0, complete
  const observed = new Promise(resolve => { complete = resolve })
  const upstream = createServer((req, res) => {
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return }
    requests++; req.resume(); req.on('end', () => {
      complete()
      if (options.hold) return
      res.setHeader('content-type', 'application/json')
      const body = { ...response(), ...(options.reportedModel ? { model: options.reportedModel } : {}), content: [{ type: 'text', text: options.text ?? '{"texts":[],"calls":[{"name":"read","arguments":{"path":"fixture.txt"}}]}' }] }
      if (options.missingUsage) delete body.usage
      res.end(JSON.stringify(body))
    })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const bootstrap = { executable: join(root, 'engine'), pathVariable: 'TCLAUDE_CLAUDE_PATH', provider: 'fixture', home: root }
  const p = normalizeProfile({ ...profile, executable: join(root, 'wrapper'), env: { FIXTURE_GATEWAY: `http://127.0.0.1:${upstream.address().port}` }, allowedModels: ['fixture-model'], managedInference: { bootstrap, ...(options.responseModels ? { responseModels: options.responseModels } : {}) } })
  const actor = new ClaudeManagedDecision({ profile: p, cwd: root, stateRoot: root, bootstrap, responseModels: options.responseModels, model: 'fixture-model', admit: async () => {}, timeoutMs: 10000 })
  t.after(async () => { await actor.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }) })
  await actor.prepare({ messages: [{ role: 'user', content: [{ type: 'text', text: options.prompt ?? 'Explicit frozen skill instructions: fixture-skill. Read fixture.txt.' }] }], tools: [{ name: 'read', parameters: { type: 'object' } }] })
  return { actor, profile: p, root, observed, requests: () => requests }
}
test('native wrapper decision returns Host action only after process drainage', async t => {
  const x = await nativeFixture(t); assert.equal(x.requests(), 0)
  const result = await x.actor.execute()
  assert.equal(result.failure, undefined); assert.equal(result.calls[0].name, 'read')
  assert.equal(result.stop.process_group_empty, true); assert.equal(result.usage.input_tokens, 15)
  assert.match(x.actor.input, /fixture-skill/); assert.equal(x.requests(), 1)
})
test('invalid Host action retains known usage but executes nothing', async t => {
  const x = await nativeFixture(t, { text: '{"texts":[],"calls":[{"name":"Bash","arguments":{}}]}' })
  const r = await x.actor.execute(); assert.match(r.failure.message, /Unauthorized/); assert.deepEqual(r.calls, []); assert.equal(r.usage.input_tokens, 15)
})
test('conflicting native usage fences output and accounting evidence', async t => {
  const x = await nativeFixture(t, { prompt: 'CONFLICT_USAGE' }); const r = await x.actor.execute()
  assert.match(r.failure.message, /usage conflict/); assert.equal(r.usage, null); assert.equal(r.usage_evidence, null); assert.deepEqual(r.calls, [])
})
test('missing provider usage fails closed with no fabricated zero accounting', async t => {
  const x = await nativeFixture(t, { missingUsage: true }); const r = await x.actor.execute()
  assert.match(r.failure.message, /usage evidence/); assert.equal(r.usage, null); assert.deepEqual(r.calls, [])
})
test('cancel in-flight inference drains process and leaves unknown usage unresolved', async t => {
  const x = await nativeFixture(t, { hold: true }); const running = x.actor.execute(); await x.observed
  await x.actor.close(); const r = await running
  assert.ok(r.failure); assert.equal(r.usage, null); assert.deepEqual(r.calls, []); assert.equal(r.stop.process_group_empty, true)
})
test('missing native usage contradicts a successful native result and fences accounting', async t => {
  const x = await nativeFixture(t, { prompt: 'MISSING_NATIVE_USAGE' }); const r = await x.actor.execute()
  assert.ok(r.failure); assert.equal(r.usage, null); assert.equal(r.usage_evidence, null)
})
import { Session } from '@deepseek-ai/dsh-session'
import { AgentProfiles } from '../src/agent-profiles.js'
import { ManagedCodexAdapter } from '../src/managed-codex-adapter.js'
test('public adapter preserves official admission, one usage, Host tools and durable evidence', async t => {
  const x = await nativeFixture(t); await x.actor.close()
  const profiles = await new AgentProfiles(join(x.root, 'profiles.json')).open([x.profile])
  await profiles.bind('worker', x.profile.id)
  await profiles.patchBinding('worker', { managedAssignment: { id: 'assignment' }, managedOperation: { id: 'operation', attempt: 1, epoch: 1 } })
  const seed = Session.create('worker'), session = Session.create('worker', undefined, { ...seed.header, cwd: x.root })
  const agent = { id: 'worker', session, ctx: { parallel: async () => {} } }
  let admissions = 0
  const execution = { assertModelRequest: async () => { admissions++; return { operation_id: 'operation', call_id: 'call', attempt: 1, epoch: 1 } } }
  const ctx = { agents: { get: id => id === 'worker' ? agent : null }, get: () => ({ officialExecution: execution }) }
  const adapter = new ManagedCodexAdapter(ctx, profiles); t.after(() => adapter.close())
  const chunks = []
  for await (const chunk of adapter.streamBound(profiles.get(x.profile.id), { sessionId: 'worker', provider: `kode-workflow-${x.profile.id}`, model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Read fixture' }] }], tools: [{ name: 'read', parameters: { type: 'object' } }] })) chunks.push(chunk)
  assert.equal(x.requests(), 1); assert.equal(admissions, 3)
  assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 7, outputTokens: 2 })
  assert.equal(chunks.find(c => c.type === 'block-end').block.name, 'read')
  const record = session.snapshotEvents().find(e => e.type === 'plugin:kode/managed-cli-decision').data
  assert.equal(record.usage_evidence.source, 'claude_admitted_provider_response'); assert.equal(record.stop.process_group_empty, true)
  assert.equal(adapter.active.size, 0)
})
test('response identities are explicit, allowed-model scoped, and revision-frozen', () => {
  const original = normalizeProfile({ ...profile, allowedModels: ['fixture-model'] })
  const mapped = normalizeProfile({ ...profile, allowedModels: ['fixture-model'], managedInference: { ...profile.managedInference, responseModels: { 'fixture-model': 'provider-model' } } })
  assert.notEqual(profileRevision(original), profileRevision(mapped))
  for (const responseModels of [{ 'other-model': 'provider-model' }, { 'fixture-model': '' }, { 'fixture-model': 'bad\nmodel' }, ['provider-model']]) assert.throws(() => normalizeProfile({ ...profile, allowedModels: ['fixture-model'], managedInference: { ...profile.managedInference, responseModels } }))
  assert.throws(() => normalizeProfile({ ...profile, type: 'codex', allowedModels: ['fixture-model'], managedInference: { ...profile.managedInference, responseModels: { 'fixture-model': 'provider-model' } } }))
})
test('explicit provider identity mapping preserves requested wire model and evidence', async t => {
  const x = await nativeFixture(t, { reportedModel: 'provider-model', responseModels: { 'fixture-model': 'provider-model' } })
  const r = await x.actor.execute(); assert.equal(r.failure, undefined)
  assert.equal(r.configuration.model, 'fixture-model'); assert.equal(r.configuration.wire_model, 'fixture-model')
  assert.equal(r.configuration.expected_reported_model, 'provider-model'); assert.equal(r.usage_evidence.reported_model, 'provider-model')
})
test('unmapped or incorrect reported identities remain rejected without usage fabrication', async t => {
  for (const responseModels of [undefined, { 'fixture-model': 'another-model' }]) {
    const x = await nativeFixture(t, { reportedModel: 'provider-model', responseModels }); const r = await x.actor.execute()
    assert.equal(r.failure.code, 'managed_cli_model_contract_changed'); assert.equal(r.usage, null); assert.deepEqual(r.calls, [])
  }
})
test('real gate open rejects immediate abort instead of stranding preparation', async () => {
  const controller = new AbortController(), gate = new ClaudeModelGate({ model: 'fixture', admit: async () => {}, signal: controller.signal })
  const opening = gate.open(); controller.abort(Error('cancel listener setup'))
  await assert.rejects(Promise.race([opening, new Promise((_, reject) => setTimeout(() => reject(Error('hung')), 500))]), /cancel listener/)
  await gate.close()
})
test('Claude serialization uses the shared messages/tools budget exactly', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '' }] }], tools = []
  const overhead = Buffer.byteLength(JSON.stringify({ messages, tools }))
  messages[0].content[0].text = 'x'.repeat(2 * 1024 * 1024 - overhead)
  assert.equal(Buffer.byteLength(serializeClaudeInput(messages, tools)), 2 * 1024 * 1024)
  messages[0].content[0].text += 'x'
  assert.throws(() => serializeClaudeInput(messages, tools), /limit/)
})
for (const timing of ['sync', 'nextTick']) test(`real actor prepare/close settles during gate startup (${timing})`, async () => {
  const actor = new ClaudeManagedDecision({ profile: normalizeProfile(profile), cwd: '/fixture', stateRoot: '/fixture', model: 'fixture-model', bootstrap: profile.managedInference.bootstrap, admit: async () => {} })
  const preparing = actor.prepare({ messages: [], tools: [] }).catch(error => error)
  let closing
  if (timing === 'sync') closing = actor.close()
  else closing = new Promise((resolve, reject) => process.nextTick(() => actor.close().then(resolve, reject)))
  await Promise.race([closing, new Promise((_, reject) => setTimeout(() => reject(Error('prepare/close hung')), 1000))])
  assert.ok(await preparing instanceof Error); assert.equal(actor.process, undefined)
})
test('explicit Claude Builder/Coordinator roles route through the same controlled adapter only', async () => {
  const p = normalizeProfile({ ...profile, managedInference: { ...profile.managedInference, roles: ['builder', 'coordinator', 'worker'] } })
  for (const role of ['managedBuilder', 'managedCoordinator', 'managedAssignment']) {
    assert.equal(controlledBinding({ profile: p, [role]: {} }), true)
    const adapter = new ManagedCodexAdapter({}, { path: '/fixture/profiles.json' })
    const actor = adapter.decision({ profile: p, [role]: {} }, { model: 'fixture-model' }, { session: { header: { cwd: '/fixture' } } }, undefined, async () => {})
    assert.ok(actor instanceof ClaudeManagedDecision); await actor.close()
  }
  assert.equal(controlledBinding({ profile: p }), false)
  assert.equal(controlledBinding({ profile: p, managedBuilder: {}, managedCoordinator: {} }), false)
  const worker = normalizeProfile(profile)
  assert.notEqual(profileRevision(p), profileRevision(worker))
  assert.equal(controlledBinding({ profile: worker, managedBuilder: {} }), false)
})
