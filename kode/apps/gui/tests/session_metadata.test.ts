import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applySessionMetadata,
  MAX_PENDING_SESSION_METADATA,
  SessionMetadataBuffer,
  sessionTabToPersisted,
  upsertSessionTab,
} from '../src/lib/session_metadata.ts'
import type { TabInfo } from '../src/lib/sessions.ts'

const uuid = '11111111-1111-4111-8111-111111111111'
const nextUuid = '22222222-2222-4222-8222-222222222222'
const tab = (patch: Partial<TabInfo> = {}): TabInfo => ({
  id: 1,
  backendKey: 'tcodex',
  title: 'Spawn title',
  model: 'auto',
  sessionId: null,
  endpointId: { kind: 'local' },
  ...patch,
})
const usage = { tokens: 100, inputTokens: 60, outputTokens: 40, cachedTokens: 20, costUsd: 0.5 }
const assertNoUsage = (value: TabInfo) => {
  for (const field of Object.keys(usage)) assert.equal(field in value, false, field)
}

test('UUID before model and partial usage survives insertion and persistence', () => {
  const pending = new SessionMetadataBuffer()
  let tabs: TabInfo[] = []
  tabs = pending.receive(tabs, { id: 1, session_id: uuid })
  tabs = pending.receive(tabs, { id: 1, model: 'actual-model', input_tokens: 60 })
  tabs = pending.receive(tabs, { id: 1, tokens: 100, output_tokens: 40 })
  tabs = pending.receive(tabs, { id: 1, cached_tokens: 0, cost_usd: 0 })
  tabs = pending.receive(tabs, { id: 1, model: '', session_id: null, title: '' })
  assert.equal(tabs.length, 0)
  assert.equal(pending.size, 1)
  tabs = upsertSessionTab(tabs, tab(), pending, true)
  assert.equal(pending.size, 0)
  assert.equal(tabs[0].sessionId, uuid)
  assert.equal(tabs[0].model, 'actual-model')
  assert.equal(tabs[0].tokens, 100)
  assert.equal(tabs[0].inputTokens, 60)
  assert.equal(tabs[0].outputTokens, 40)
  assert.equal(tabs[0].cachedTokens, 0)
  assert.equal(tabs[0].costUsd, 0)
  const persisted = tabs.map(sessionTabToPersisted)
  assert.equal(persisted[0].session_id, uuid)
  assert.equal(persisted[0].model, 'actual-model')
  assert.equal('tokens' in persisted[0], false)
})

test('created/meta/stale spawn DTO preserves authoritative metadata and user state', () => {
  const pending = new SessionMetadataBuffer()
  let tabs = upsertSessionTab([], tab(), pending)
  tabs = pending.receive(tabs, { id: 1, session_id: uuid, title: 'Live title', model: 'live-model', tokens: 10 })
  tabs[0] = { ...tabs[0], titlePinned: true, avatarId: 'custom', status: 'busy' }
  tabs = upsertSessionTab(tabs, tab({
    cwd: '/original/project', permissionMode: 'bypass', transportKind: 'pty',
  }), pending, true)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].sessionId, uuid)
  assert.equal(tabs[0].model, 'live-model')
  assert.equal(tabs[0].title, 'Live title')
  assert.equal(tabs[0].titlePinned, true)
  assert.equal(tabs[0].tokens, 10)
  assert.equal(tabs[0].status, 'busy')
  assert.equal(tabs[0].avatarId, 'custom')
  assert.equal(tabs[0].cwd, '/original/project')
  assert.equal(tabs[0].permissionMode, 'bypass')
  assert.equal(tabs[0].transportKind, 'pty')
  assert.equal(sessionTabToPersisted(tabs[0]).session_id, uuid)
})

test('meta/created/meta/spawn and focus upserts consume once without DTO regressions', () => {
  const pending = new SessionMetadataBuffer()
  pending.receive([], { id: 1, session_id: uuid, model: 'live-model' })
  let tabs = upsertSessionTab([], tab(), pending)
  tabs = pending.receive(tabs, { id: 1, title: 'Transcript title', tokens: 8 })
  tabs = upsertSessionTab(tabs, tab({ sessionId: nextUuid, model: 'stale-model' }), pending)
  tabs = upsertSessionTab(tabs, tab(), pending, true)
  assert.equal(tabs[0].sessionId, uuid)
  assert.equal(tabs[0].model, 'live-model')
  assert.equal(tabs[0].title, 'Transcript title')
  assert.equal(tabs[0].tokens, 8)
  assert.equal(pending.size, 0)
  assert.equal(pending.consume(tab()).sessionId, null)
})

test('new UUID clears all old usage and unpinned title without mutating the original', () => {
  const original = tab({ ...usage, sessionId: uuid, title: 'Old title' })
  const next = applySessionMetadata(original, { id: 1, session_id: nextUuid, output_tokens: 0 })
  assert.equal(next.sessionId, nextUuid)
  assert.equal(next.title, 'tab · tcodex')
  assert.equal(next.outputTokens, 0)
  const { outputTokens, ...withoutNewUsage } = next
  assertNoUsage(withoutNewUsage)
  assert.equal(original.tokens, 100)
  assert.equal(original.title, 'Old title')
})

test('pinned titles survive UUID changes and token resets; nonempty fields and zero totals apply', () => {
  const original = tab({ ...usage, sessionId: uuid, title: 'Pinned title', titlePinned: true })
  const switched = applySessionMetadata(original, {
    id: 1, session_id: nextUuid, title: 'AI title', model: 'new-model',
  })
  assertNoUsage(switched)
  assert.equal(switched.title, 'Pinned title')
  assert.equal(original.tokens, 100)
  const reset = applySessionMetadata(original, { id: 1, tokens_reset: true, tokens: 0 })
  assert.equal(reset.tokens, 0)
  assert.equal(reset.inputTokens, undefined)
  assert.equal(reset.title, 'Pinned title')
  assert.equal(reset.sessionId, uuid)
  assert.deepEqual(applySessionMetadata(original, {
    id: 1, session_id: null, model: '', title: '',
  }), original)
})

test('buffered switch clears old usage/title even when DTO already has the new UUID', () => {
  const pending = new SessionMetadataBuffer()
  pending.receive([], {
    id: 1, session_id: uuid, title: 'Old title', tokens: 100,
    input_tokens: 60, output_tokens: 40, cached_tokens: 20, cost_usd: 0.5,
  })
  pending.receive([], { id: 1, session_id: nextUuid })
  pending.receive([], { id: 1, model: 'new-model' })
  const next = pending.consume(tab({ ...usage, sessionId: nextUuid, title: 'Stale DTO title' }))
  assertNoUsage(next)
  assert.equal(next.title, 'tab · tcodex')
  assert.equal(next.sessionId, nextUuid)
  assert.equal(next.model, 'new-model')
})

test('buffered reset drops old title/totals and retains UUID, model and later updates', () => {
  for (const titlePinned of [false, true]) {
    const pending = new SessionMetadataBuffer()
    pending.receive([], { id: 1, session_id: uuid, model: 'live-model', title: 'Old title', tokens: 100 })
    pending.receive([], { id: 1, tokens_reset: true })
    pending.receive([], { id: 1, tokens_reset: false, input_tokens: 0 })
    const next = pending.consume(tab({ ...usage, title: 'Pinned or stale', titlePinned, sessionId: uuid }))
    assert.equal(next.title, titlePinned ? 'Pinned or stale' : 'tab · tcodex')
    assert.equal(next.sessionId, uuid)
    assert.equal(next.model, 'live-model')
    assert.equal(next.tokens, undefined)
    assert.equal(next.inputTokens, 0)
    assert.equal(next.outputTokens, undefined)
    assert.equal(next.cachedTokens, undefined)
    assert.equal(next.costUsd, undefined)
  }
  const pending = new SessionMetadataBuffer()
  pending.receive([], { id: 1, session_id: uuid, title: 'Old' })
  pending.receive([], { id: 1, session_id: nextUuid, title: 'New', tokens: 0 })
  assert.equal(pending.consume(tab()).title, 'New')
})

test('close/exit deletion and subscription stop clearing discard pending metadata', () => {
  const pending = new SessionMetadataBuffer()
  for (const id of [1, 2, 3]) pending.receive([], { id, session_id: uuid })
  pending.delete(1)
  pending.delete(2)
  assert.equal(pending.size, 1)
  assert.equal(pending.consume(tab({ id: 1 })).sessionId, null)
  assert.equal(pending.consume(tab({ id: 2 })).sessionId, null)
  pending.clear()
  assert.equal(pending.size, 0)
  assert.equal(pending.consume(tab({ id: 3 })).sessionId, null)
})

test('pending cache is bounded by ID and evicts the oldest without losing partial updates', () => {
  const pending = new SessionMetadataBuffer()
  for (let id = 1; id <= MAX_PENDING_SESSION_METADATA; id++) {
    pending.receive([], { id, session_id: uuid })
  }
  pending.receive([], { id: 1, model: 'updated-model' })
  assert.equal(pending.size, MAX_PENDING_SESSION_METADATA)
  pending.receive([], { id: MAX_PENDING_SESSION_METADATA + 1, session_id: nextUuid })
  assert.equal(pending.size, MAX_PENDING_SESSION_METADATA)
  assert.equal(pending.consume(tab({ id: 1 })).sessionId, null)
  const retained = pending.consume(tab({ id: 2 }))
  assert.equal(retained.sessionId, uuid)
  const latest = pending.consume(tab({ id: MAX_PENDING_SESSION_METADATA + 1 }))
  assert.equal(latest.sessionId, nextUuid)
  assert.equal(pending.size, MAX_PENDING_SESSION_METADATA - 2)
})

test('spawn fills absent identity and configuration on an early incomplete created DTO', () => {
  const pending = new SessionMetadataBuffer()
  const tabs = upsertSessionTab([tab({ model: '', backendKey: '' })], tab({
    sessionId: uuid, model: 'spawn-model', endpointId: { kind: 'remote', id: 'original-connection' },
  }), pending, true)
  assert.equal(tabs[0].sessionId, uuid)
  assert.equal(tabs[0].model, 'spawn-model')
  assert.equal(tabs[0].backendKey, 'tcodex')
  assert.deepEqual(sessionTabToPersisted(tabs[0]).endpoint_id, { kind: 'remote', id: 'original-connection' })
})
