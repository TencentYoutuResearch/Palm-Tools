import test from 'node:test'
import assert from 'node:assert/strict'
import { selectModelPlan } from '../src/model-selection.js'
import { AcpSession } from '../src/acp-session.js'
const models = [{ id: 'small', name: 'Small', isDefault: true, reasoningEfforts: [{ id: 'low' }, { id: 'high' }], defaultReasoningEffort: 'low' }, { id: 'large' }]
const profile = { id: 'worker' }
test('selection honors explicit model and effort, compatible inheritance and configured allowlist', () => {
  assert.deepEqual(selectModelPlan(profile, models, { model: 'Small', reasoningEffort: 'high' }), { provider: 'kode-agent-worker', model: 'small', reasoningEffort: 'high' })
  assert.equal(selectModelPlan(profile, models, {}, { provider: 'kode-agent-worker', model: 'large' }).model, 'large')
  assert.equal(selectModelPlan({ ...profile, allowedModels: ['large'] }, models).model, 'large')
  assert.equal(selectModelPlan(profile, models, {}, { provider: 'kode-agent-other', model: 'large' }).model, 'small')
  assert.throws(() => selectModelPlan({ ...profile, allowedModels: ['small'] }, models, { model: 'large' }), /allowedModels/)
  assert.throws(() => selectModelPlan(profile, models, { model: 'large', reasoningEffort: 'high' }), /reasoning effort/)
  assert.throws(() => selectModelPlan(profile, models, {}, { provider: 'kode-agent-worker', model: 'small', reasoningEffort: 'unknown' }), /reasoning effort/)
})
test('ACP model acknowledgement that reports a different value fails before prompt', async () => {
  const session = Object.create(AcpSession.prototype)
  session.threadId = 'fixture'
  session.state = { configOptions: [{ id: 'model', category: 'model', currentValue: 'small', options: [{ value: 'small' }, { value: 'large' }] }] }
  session.request = async () => ({ configOptions: session.state.configOptions })
  await assert.rejects(session.selectModel('large'), /different model/)
})


test('ACP rejects effort mismatch and propagates selection RPC failures', async () => {
  const session = Object.create(AcpSession.prototype)
  session.threadId = 'fixture'
  session.profile = { policyManagedByHost: true }
  session.handlers = {}
  session.state = { configOptions: [{ id: 'thought_level', type: 'select', category: 'thought_level', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] }] }
  session.request = async () => ({ configOptions: session.state.configOptions })
  await assert.rejects(session.configure('default', undefined, 'high'), /different reasoning effort/)
  session.state = { models: { availableModels: [{ modelId: 'small' }] } }
  session.request = async () => { throw new Error('selection denied by executor') }
  await assert.rejects(session.selectModel('small'), /selection denied/)
})

test('ACP selection evidence distinguishes reported configuration from acknowledgement', async () => {
  const session = Object.create(AcpSession.prototype)
  session.threadId = 'fixture'; session.profile = { policyManagedByHost: true }; session.handlers = {}
  session.state = { configOptions: [
    { id: 'model', category: 'model', currentValue: 'small', options: [{ value: 'small' }] },
    { id: 'effort', type: 'select', currentValue: 'low', options: [{ value: 'low' }] },
  ] }
  session.request = async () => ({ configOptions: session.state.configOptions })
  const reported = await session.configure('small', undefined, 'low')
  assert.equal(reported.model.status, 'reported')
  assert.equal(reported.model.observed, 'small')
  assert.equal(reported.effort.status, 'reported')
  session.request = async () => ({})
  const acknowledged = await session.configure('small', undefined, 'low')
  assert.equal(acknowledged.model.status, 'acknowledged')
  assert.equal(acknowledged.model.observed, undefined)
  assert.equal(acknowledged.effort.status, 'acknowledged')
  const absent = await session.configure(undefined)
  assert.equal(absent.model.status, 'unverifiable')
  assert.equal(absent.effort.status, 'unverifiable')
})
