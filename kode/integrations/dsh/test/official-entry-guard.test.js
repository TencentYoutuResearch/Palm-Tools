import test from 'node:test'
import assert from 'node:assert/strict'
import { OfficialEntryGuard } from '../src/official-entry-guard.js'
function fixture() {
  const listeners = new Map(), agent = { id: 'managed' }
  const profiles = { binding: id => id === 'managed' ? { profile: { type: 'dsh' }, managedOperation: { id: 'op' } } : undefined }
  const ctx = { on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) } }
  const guard = new OfficialEntryGuard(ctx, profiles)
  return { guard, listeners, agent, request: { agent, name: 'read', callId: 'call', arguments: { path: 'allowed' } } }
}
const drain = async iterable => { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks }

test('native managed roles retain dispatch fences even when their role binding is invalid', async () => {
  for (const role of ['managedAssignment', 'managedBuilder', 'managedCoordinator', 'invalid']) {
    const listeners = new Map()
    const binding = { profile: { type: 'codex', managedInference: { roles: ['builder', 'coordinator'] } },
      managedOperation: { id: 'operation' }, ...(role === 'invalid' ? {} : { [role]: {} }) }
    const guard = new OfficialEntryGuard({ on: (name, listener) => { listeners.set(name, listener); return () => {} } },
      { binding: id => id === 'managed' ? binding : undefined })
    let calls = 0
    const next = async function* () { calls++; yield 'result' }
    const options = { sessionId: 'managed' }
    try {
      await assert.rejects(drain(listeners.get('llm/stream')(options, next)), /controlled execution/)
      await assert.rejects(listeners.get('tools/execute')({ agent: { id: 'managed' } }, async () => { calls++ }), /controlled execution/)
      assert.equal(calls, 0)
      assert.deepEqual(await drain(listeners.get('llm/stream')({ sessionId: 'ordinary' }, next)), ['result'])
    } finally { guard.close() }
  }
})

test('managed streams require one exact permit; ordinary streams retain their pipeline', async () => {
  const { guard, listeners } = fixture(); let calls = 0, checks = 0
  const model = async function* () { calls++; yield 'output' }
  const stream = options => listeners.get('llm/stream')(options, model)
  const options = { sessionId: 'managed', provider: 'fixture', model: 'm' }
  try {
    await assert.rejects(drain(stream(options)), /controlled execution/); assert.equal(calls, 0)
    assert.deepEqual(await drain(guard.stream(options, () => stream(options), async () => { checks++ })), ['output'])
    assert.equal(checks, 1); assert.equal(calls, 1)
    await assert.rejects(drain(stream(options)), /controlled execution/)
    await assert.rejects(drain(guard.stream(options, () => stream({ ...options }), async () => {})), /controlled execution/)
    assert.deepEqual(await drain(stream({ ...options, sessionId: 'ordinary' })), ['output'])
    await assert.rejects(drain(guard.stream(options, () => stream(options), async () => { throw new Error('lease revoked') })), /lease revoked/)
    assert.equal(calls, 2)
  } finally { guard.close() }
})

test('tool dispatch refuses changed arguments, nested permit reuse and lost lease before side effects', async () => {
  const { guard, listeners, agent, request } = fixture(); let effects = 0
  const dispatch = (input, next = async () => { effects++; return 'result' }) => listeners.get('tools/execute')(input, next)
  try {
    await assert.rejects(dispatch(request), /controlled execution/)
    assert.equal(await guard.execute(request, () => dispatch({ ...request, arguments: structuredClone(request.arguments) }), async () => {}), 'result')
    await assert.rejects(guard.execute(request, () => dispatch({ ...request, arguments: { path: 'outside' } }), async () => {}), /exact controlled/)
    await assert.rejects(guard.execute(request, () => dispatch({ ...request, agent: { ...agent } }), async () => {}), /exact controlled/)
    await assert.rejects(guard.execute(request, () => dispatch(request, () => dispatch(request)), async () => {}), /exact controlled/)
    await assert.rejects(guard.execute(request, () => dispatch(request), async () => { throw new Error('revoked') }), /revoked/)
    assert.equal(effects, 1)
    await dispatch({ ...request, agent: { id: 'ordinary' } }); assert.equal(effects, 2)
    guard.close()
    await assert.rejects(dispatch(request), /controlled execution/)
    assert.throws(() => guard.execute(request, () => {}, async () => {}), /unavailable/)
  } finally { guard.close() }
})

test('actual dsh LLM waterfall cannot dispatch managed calls outside the controlled permit', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Llm, LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  const ctx = new Context(); let calls = 0
  class FixtureAdapter extends LlmAdapter {
    async listModels() { return [{ id: 'fixture', name: 'Fixture', inputModalities: ['text'] }] }
    async *stream() { calls++; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  let guard
  try {
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['fixture'], new FixtureAdapter())
    guard = new OfficialEntryGuard(ctx, { binding: id => id === 'managed' ? { profile: { type: 'dsh' }, managedOperation: { id: 'op' } } : null })
    const options = { sessionId: 'managed', provider: 'fixture', model: 'fixture', messages: [] }
    await assert.rejects(drain(ctx.llm.stream(options)), /controlled execution/)
    assert.equal(calls, 0)
    const result = await drain(guard.stream(options, () => ctx.llm.stream(options), async () => {}))
    assert.equal(result.at(-1).reason.kind, 'stop'); assert.equal(calls, 1)
    guard.close()
    await assert.rejects(drain(ctx.llm.stream(options)), /controlled execution/)
    await drain(ctx.llm.stream({ ...options, sessionId: 'ordinary' }))
    assert.equal(calls, 2)
  } finally { guard?.close(); await ctx.fiber.dispose() }
})

test('actual dsh ToolRuntime enforces controlled authority before its tool body', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Tools } = await import('@deepseek-ai/dsh-tools')
  const ctx = new Context(); let effects = 0, nested = false, nestedResult, alter = false
  let guard
  const agent = { id: 'managed', ctx, session: { id: 'managed' } }
  try {
    ctx.provide('systemPrompt', { tools: () => () => {} })
    await ctx.plugin(Tools)
    guard = new OfficialEntryGuard(ctx, { binding: id => id === 'managed' ? { profile: { type: 'dsh' }, managedOperation: { id: 'operation' } } : null })
    ctx.tools.register({ name: 'controlled_read', description: 'Fixture', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { effects++; if (nested) nestedResult = await ctx.tools.execute(request); return 'result' },
    })
    ctx.on('tools/pre-execute', async (execution, next) => { if (alter) execution.arguments = { path: 'outside' }; return next() })
    const request = { agent, signal: new AbortController().signal, name: 'controlled_read', callId: 'read-1', arguments: { path: 'allowed' } }
    const denied = await ctx.tools.execute(request)
    assert.equal(denied.isError, true); assert.equal(effects, 0)
    const allowed = await guard.execute(request, () => ctx.tools.execute(request), async () => {})
    assert.equal(allowed.isError, false); assert.equal(effects, 1)
    alter = true
    const changed = await guard.execute(request, () => ctx.tools.execute(request), async () => {})
    assert.equal(changed.isError, true); assert.equal(effects, 1)
    alter = false; nested = true
    await guard.execute(request, () => ctx.tools.execute(request), async () => {})
    assert.equal(nestedResult.isError, true); assert.equal(effects, 2)
    guard.close()
    assert.equal((await ctx.tools.execute(request)).isError, true); assert.equal(effects, 2)
  } finally { guard?.close(); await ctx.fiber.dispose() }
})


test('internal Assignment tools require completed admission and lose authority when their tool call returns', async () => {
  const { guard, listeners, agent, request } = fixture()
  let releaseLate, late
  const released = new Promise(resolve => { releaseLate = resolve })
  try {
    assert.throws(() => guard.assertToolBody(agent, request.name, request.arguments), /exact controlled tool body/)
    await guard.execute(request, () => listeners.get('tools/execute')(request, async () => {
      guard.assertToolBody(agent, request.name, request.arguments)
      assert.throws(() => guard.assertToolBody(agent, 'foreign', request.arguments), /exact controlled tool body/)
      assert.throws(() => guard.assertToolBody(agent, request.name, { path: 'changed' }), /exact controlled tool body/)
      late = released.then(() => assert.throws(() => guard.assertToolBody(agent, request.name, request.arguments), /exact controlled tool body/))
    }), async () => {
      assert.throws(() => guard.assertToolBody(agent, request.name, request.arguments), /exact controlled tool body/)
    })
    releaseLate(); await late
  } finally { guard.close() }
})
