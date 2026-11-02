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
