import test from 'node:test'
import assert from 'node:assert/strict'
import { changeContactPreference } from '../packages/collab/contact-preference.js'

const preference = revision => ({ revision, pinned: false, archived: false, archived_through_sequence: 0, updated_at: 1 })
const team = { id: 'team', home_hub: 'home', contact: { preference: preference(0) } }
const scope = { home_hub: 'home', team_id: 'team', principal_id: 'local_owner' }
const response = value => ({ ok: true, json: async () => value })
function storage() {
  let saved
  return {
    reserve: async (_, value) => saved && saved.state !== 'accepted' ? saved : (saved = structuredClone(value)),
    save: async (_, value) => { assert.equal(saved.request_id, value.request_id); saved = structuredClone(value) },
    current: () => saved,
  }
}

test('lost contact response recovers exact receipt without another POST', async () => {
  const saved = storage()
  let writes = 0, command
  const result = { ...scope, preference: { ...preference(1), pinned: true } }
  const fetcher = async (_, init) => {
    if (init.method === 'POST') { writes++; command = JSON.parse(init.body); throw Error('lost committed reply') }
    return response({ ...scope, request_id: 'request', preference: writes ? result.preference : preference(0),
      receipt: writes ? { request: { action: command.action, expected_revision: command.expected_revision, request_id: command.request_id }, result } : null })
  }
  assert.deepEqual(await changeContactPreference({ storage: saved, team, action: 'pin', requestId: 'request', fetcher }), result)
  assert.equal(writes, 1)
  assert.equal(saved.current().state, 'accepted')
})

test('a proven stale contact intent closes without submitting a replacement action', async () => {
  const saved = storage()
  const fetcher = async (_, init) => {
    assert.equal(init.method, 'GET')
    return response({ ...scope, request_id: 'old', receipt: null, preference: preference(2) })
  }
  const result = await changeContactPreference({ storage: saved, team, action: 'archive', requestId: 'old', fetcher })
  assert.equal(result.superseded, true)
  assert.equal(saved.current().command.expected_revision, 0)
  assert.equal(saved.current().state, 'accepted')
})

test('contact storage failure and foreign receipt scope prevent mutation', async () => {
  let calls = 0
  await assert.rejects(changeContactPreference({ storage: { reserve: async () => { throw Error('storage unavailable') } }, team, action: 'pin', requestId: 'request', fetcher: async () => { calls++ } }), /storage/)
  assert.equal(calls, 0)
  await assert.rejects(changeContactPreference({ storage: storage(), team, action: 'pin', requestId: 'request', fetcher: async (_, init) => {
    assert.equal(init.method, 'GET'); calls++
    return response({ ...scope, home_hub: 'foreign', request_id: 'request', receipt: null, preference: preference(0) })
  } }), /Foreign/)
  assert.equal(calls, 1)
})

test('altered contact receipt cannot confirm the original intent', async () => {
  const saved = storage()
  await assert.rejects(changeContactPreference({ storage: saved, team, action: 'pin', requestId: 'request', fetcher: async () => response({
    ...scope, request_id: 'request', preference: preference(1), receipt: {
      request: { request_id: 'request', expected_revision: 0, action: 'archive' },
      result: { ...scope, preference: { ...preference(1), archived: true } },
    },
  }) }), /command mismatch/)
  assert.equal(saved.current().state, 'prepared')
})
