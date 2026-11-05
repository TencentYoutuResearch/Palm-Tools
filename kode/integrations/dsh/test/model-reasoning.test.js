import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'
const provider = 'kode-agent-builtin-codex'
const model = 'gpt-6.1-sol'
const advertised = { provider, id: model, name: model, reasoningEfforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultReasoningEffort: 'medium' }
async function fixture(rows = [advertised]) {
  const ctx = new Context()
  const fiber = await ctx.plugin(LlmRuntime)
  const adapter = new AgentRuntimeAdapter(ctx, { list: () => [{ id: 'builtin-codex', type: 'codex', name: 'Codex' }], bindings: {} })
  adapter.capabilities = async () => ({ models: structuredClone(rows) })
  const registration = ctx.llm.registerAdapter([provider], adapter)
  return { ctx, adapter, close: async () => { registration(); await adapter.close(); await fiber.dispose() } }
}
test('advertised medium effort passes the real dsh runtime validation and retains its default', async () => {
  const h = await fixture()
  try {
    const config = await h.ctx.llm.resolveCallConfig({ provider, model, reasoningEffort: 'medium' })
    const models = await h.adapter.listModels(provider)
    assert.deepEqual(models[0].reasoning, { efforts: advertised.reasoningEfforts, defaultEffort: 'medium' })
    assert.equal(config.reasoningEffort, 'medium')
    assert.equal((await h.ctx.llm.resolveCallConfig({ provider, model })).reasoningEffort, 'medium')
  } finally { await h.close() }
})
test('unsupported effort remains rejected instead of bypassing provider validation', async () => {
  const h = await fixture()
  try { await assert.rejects(h.ctx.llm.resolveCallConfig({ provider, model, reasoningEffort: 'xhigh' }), /does not support reasoning effort/) }
  finally { await h.close() }
})
test('models without declared reasoning support never inherit another model efforts', async () => {
  const h = await fixture([advertised, { provider, id: 'plain-model', name: 'Plain' }])
  try { await assert.rejects(h.ctx.llm.resolveCallConfig({ provider, model: 'plain-model', reasoningEffort: 'medium' }), /does not support reasoning effort/) }
  finally { await h.close() }
})
test('canonical model reasoning metadata is retained', async () => {
  const reasoning = { efforts: [{ id: 'custom', name: 'Custom' }], defaultEffort: 'custom' }
  const h = await fixture([{ provider, id: model, name: model, reasoning }])
  try { assert.equal((await h.ctx.llm.resolveCallConfig({ provider, model })).reasoningEffort, 'custom') }
  finally { await h.close() }
})

// ACP reports thought-level choices for its selected model, not every model in
// the generic catalog. Exercise the released validator with a non-default route.
for (const type of ['claude', 'cursor', 'codebuddy', 'custom']) {
  test(`${type} exact resolution probes the requested model, independently of the default catalog`, async () => {
    const ctx = new Context(), fiber = await ctx.plugin(LlmRuntime)
    const profile = { id: 'fixture-acp', type, name: type }
    const route = 'kode-agent-fixture-acp', hints = []
    const adapter = new AgentRuntimeAdapter(ctx, { list: () => [profile], bindings: {} })
    adapter.capabilities = async (_provider, _profile, _cwd, hint) => {
      hints.push(hint)
      return { models: [
        { provider: route, id: 'default-model', name: 'Default' },
        { provider: route, id: 'selected-model', name: 'Selected', ...(hint === 'selected-model' ? { reasoningEfforts: [{ id: 'high', name: 'High' }], defaultReasoningEffort: 'high' } : {}) },
      ] }
    }
    const unregister = ctx.llm.registerAdapter([route], adapter)
    try {
      await adapter.listModels(route)
      const config = await ctx.llm.resolveCallConfig({ provider: route, model: 'selected-model', reasoningEffort: 'high' })
      assert.equal(config.reasoningEffort, 'high')
      assert.equal(hints.at(-1), 'selected-model')
      assert.equal((await ctx.llm.resolveCallConfig({ provider: route, model: 'selected-model' })).reasoningEffort, 'high')
      await assert.rejects(ctx.llm.resolveCallConfig({ provider: route, model: 'default-model', reasoningEffort: 'high' }), /does not support reasoning effort/)
    } finally { unregister(); await adapter.close(); await fiber.dispose() }
  })
}

test('real ACP discovery and exact runtime validation agree for non-default models across cold adapters', async () => {
  const { fileURLToPath } = await import('node:url')
  const profile = { id: 'kode-codebuddy', type: 'custom', name: 'CodeBuddy fixture', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))] }
  const provider = 'kode-agent-kode-codebuddy'
  for (const cold of [false, true]) {
    const ctx = new Context(), fiber = await ctx.plugin(LlmRuntime)
    const adapter = new AgentRuntimeAdapter(ctx, { list: () => [profile], bindings: {} })
    const unregister = ctx.llm.registerAdapter([provider], adapter)
    try {
      if (!cold) {
        const generic = await adapter.listModels(provider)
        assert.equal(generic.find(row => row.id === 'fixture-large').reasoning, undefined)
      }
      const config = { provider, model: 'fixture-large', reasoningEffort: 'high' }
      assert.equal((await ctx.llm.resolveCallConfig(config)).reasoningEffort, 'high')
      const resolved = await adapter.resolveModel(provider, config.model)
      assert.ok(resolved.reasoning.efforts.some(row => row.id === 'high'))
      adapter.invalidateModels(provider)
      assert.equal((await ctx.llm.resolveCallConfig(config)).reasoningEffort, 'high')
      assert.equal((await ctx.llm.resolveCallConfig({ provider, model: 'fixture-fast', reasoningEffort: 'medium' })).reasoningEffort, 'medium')
      await assert.rejects(ctx.llm.resolveCallConfig({ ...config, reasoningEffort: 'max' }), /does not support reasoning effort/)
    } finally { unregister(); await adapter.close(); await fiber.dispose() }
  }
})
