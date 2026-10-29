import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSessionLaunchModel } from '../src/lib/session_launch_model.ts'

const catalogue = async () => ({ models: [
  { id: 'claude-kimi-k3[1m]' },
  { id: 'claude-opus-5-5[1m]' },
  { id: 'claude-glm-5.3[1m]' },
] })

test('duplicate and resume model aliases resolve to advertised tclaude launch IDs', async () => {
  for (const model of ['kimi-k3', 'kimi-k3-ioa', 'claude-kimi-k3[1m]']) {
    assert.equal(await resolveSessionLaunchModel('tclaude', model, catalogue), 'claude-kimi-k3[1m]')
  }
  assert.equal(await resolveSessionLaunchModel('tclaude', 'claude-opus-5.5-1m', catalogue), 'claude-opus-5-5[1m]')
  assert.equal(await resolveSessionLaunchModel('tclaude', 'glm-5.3-ioa', catalogue), 'claude-glm-5.3[1m]')
})

test('exact IDs win over ambiguous normalized names', async () => {
  const discover = async () => ({ models: [{ id: 'claude-kimi-k3' }, { id: 'claude-kimi-k3[1m]' }] })
  assert.equal(await resolveSessionLaunchModel('tclaude', 'claude-kimi-k3', discover), 'claude-kimi-k3')
  await assert.rejects(resolveSessionLaunchModel('tclaude', 'kimi-k3', discover), /multiple/)
})

test('unknown models and discovery failures do not fall back to another model', async () => {
  await assert.rejects(resolveSessionLaunchModel('tclaude', 'missing', catalogue), /unavailable/)
  await assert.rejects(resolveSessionLaunchModel('tclaude', 'kimi-k3', async () => {
    throw new Error('remote bridge unavailable')
  }), /remote bridge unavailable/)
})

test('default launches and other backends do not query the catalogue', async () => {
  const discover = async () => { throw new Error('unexpected discovery') }
  for (const model of [null, undefined, 'auto', '']) {
    assert.equal(await resolveSessionLaunchModel('tclaude', model, discover), null)
  }
  assert.equal(await resolveSessionLaunchModel('tcodex', 'custom-model', discover), 'custom-model')
  assert.equal(await resolveSessionLaunchModel('claude', 'opus', discover), 'opus')
})
