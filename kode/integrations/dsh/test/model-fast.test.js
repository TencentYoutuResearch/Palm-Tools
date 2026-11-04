import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { appendFastPreference, cursorFastVariant, effectiveFast, fastPreference, fastProjection, fastServiceTier, withModelVariantFast } from '../src/model-fast.js'

test('Fast preferences are session-local, model-local and preserve explicit false', () => {
  let state = fastProjection.init()
  const session = Session.create('fixture-fast-preferences')
  const route = { provider: 'kode-agent-codex', model: 'gpt-fixture' }
  for (const fast of [true, false]) {
    const seq = appendFastPreference(session, route, fast, 'priority')
    const event = session.snapshotEvents(seq)[0]
    assert.equal(event.ignorable, true)
    state = fastProjection.apply(state, event)
  }
  assert.equal(fastPreference(state, route), false)
  assert.equal(fastServiceTier(state, route), 'priority')
  assert.equal(state.preferences.length, 1)
  assert.equal(effectiveFast(state, route, { fastCapability: { defaultEnabled: true } }), false)
  assert.equal(effectiveFast(state, { ...route, model: 'other' }, { fastCapability: { defaultEnabled: true } }), true)
  assert.equal(effectiveFast(state, route, {}), undefined)
})

test('Fast projection ignores malformed records and survives wire round trips', () => {
  const initial = fastProjection.init(), route = { provider: 'kode-agent-acp', model: 'sonnet' }
  const state = fastProjection.apply(initial, { type: 'plugin:kode/model-fast', data: { ...route, fast: true } })
  assert.equal(fastProjection.apply(state, { type: 'plugin:kode/model-fast', data: { ...route, fast: 'yes' } }), state)
  assert.deepEqual(fastProjection.wire.viewSchema.parse(fastProjection.wire.view(state)), state)
})

test('Cursor Fast toggles only between advertised model variants', () => {
  const rows = withModelVariantFast([{ id: 'grok-high' }, { id: 'grok-high-fast' }, { id: 'solo-fast' }])
  assert.deepEqual(rows[0].fastCapability, { transport: 'model-variant', defaultEnabled: false, fastModelId: 'grok-high-fast', standardModelId: 'grok-high' })
  assert.equal(rows[1].fastCapability.defaultEnabled, true)
  assert.equal(rows[2].fastCapability, undefined)
  assert.equal(withModelVariantFast([{ id: 'custom', fastCapability: { transport: 'config-option' } }])[0].fastCapability.transport, 'config-option')
  const bracket = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
  const standard = 'grok-4.7[context=256k,reasoning_effort=high,fast=false]'
  assert.equal(cursorFastVariant(bracket, false), standard)
  assert.equal(withModelVariantFast([{ id: bracket }])[0].fastCapability, undefined)
  assert.deepEqual(withModelVariantFast([{ id: bracket }, { id: standard }])[0].fastCapability, { transport: 'model-variant', defaultEnabled: true, fastModelId: bracket, standardModelId: standard })
})

test('Fast preference records can be restored by the released session reader', () => {
  const session = Session.create('fixture-fast-reader')
  appendFastPreference(session, { provider: 'fixture', model: 'fixture' }, true)
  const events = session.snapshotEvents()
  assert.equal(events[0].ignorable, true)
  assert.doesNotThrow(() => Session.create(session.id, events, session.header, 0))
})
