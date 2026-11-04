import test from 'node:test'
import assert from 'node:assert/strict'
import { savedSessionProfile } from '../src/saved-session-profile.js'

test('explicit saved profile identities never fall back to a different Agent', () => {
  const profiles = { list: () => [{ id: 'builtin-dsh', name: 'DeepSeek Harness' }] }
  assert.equal(savedSessionProfile(profiles, { agent_id: 'removed-agent', backend_key: 'builtin-dsh' }), undefined)
})

test('removed profiles can restore their exact immutable conversation binding', () => {
  const profile = { id: 'removed-agent', name: 'Original Agent' }
  const profiles = { list: () => [], bindings: { prior: { threadId: 'thread-original', profile } } }
  assert.equal(savedSessionProfile(profiles, { agent_id: profile.id, session_id: 'thread-original' }), profile)
  assert.equal(savedSessionProfile(profiles, { agent_id: profile.id, session_id: 'other-thread' }), undefined)
})

test('ambiguous backend aliases and duplicate display names cannot select an arbitrary Agent', () => {
  const first = { id: 'one', name: 'Worker' }, second = { id: 'two', name: 'worker' }
  const profiles = { list: () => [first, second], sharedState: { desktop_ids: { one: 'shared', two: 'shared' } } }
  assert.equal(savedSessionProfile(profiles, { backend_key: 'shared' }), undefined)
  assert.equal(savedSessionProfile(profiles, { backend_key: 'WORKER' }), undefined)
})
