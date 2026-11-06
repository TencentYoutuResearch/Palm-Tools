import test from 'node:test'
import assert from 'node:assert/strict'
import { createNavigationStorage } from '../packages/collab/navigation-storage.js'
import { createCollabViewState } from '../packages/collab/view-state.js'
import { createCollabData } from '../packages/collab/data.js'

function memory() {
  const values = new Map()
  return { values, read: async key => values.get(key) ?? null,
    update: async (key, change) => { const next = change(values.get(key) ?? null); values.set(key, structuredClone(next)); return next } }
}
function navigator(storage, hub = 'home') {
  let navigation
  const modes = [], contacts = []
  const view = createCollabViewState({ onNavigationChange: value => { void navigation?.save(value) } })
  navigation = createNavigationStorage({ storage, view, home: () => hub, selectMode: value => modes.push(value), restoreTeam: (...value) => contacts.push(value) })
  return { view, navigation, modes, contacts }
}

test('durable scoped navigation restores mode and selected contact without LocalStorage', async () => {
  const storage = memory(), first = navigator(storage)
  first.view.selectSuperagent('super', { teamId: 'team', homeHub: 'home' })
  first.view.setMode('im')
  await first.navigation.save(first.view.getSnapshot())
  const restored = navigator(storage)
  await restored.navigation.restore()
  assert.equal(restored.view.getSnapshot().mode, 'im')
  assert.equal(restored.view.getSnapshot().lastSuperagentId, 'super')
  assert.deepEqual(restored.contacts, [['team', 'super']])
  assert.deepEqual(restored.modes, ['im'])
  const foreign = navigator(storage, 'other-home')
  await foreign.navigation.restore()
  assert.equal(foreign.view.getSnapshot().lastSuperagentId, null)
  assert.deepEqual(foreign.contacts, [])
})

test('an old asynchronous navigation read cannot override a new user choice', async () => {
  const storage = memory(), initial = navigator(storage)
  initial.view.selectSuperagent('old-super', { teamId: 'old-team', homeHub: 'home' })
  initial.view.setMode('im')
  await initial.navigation.save(initial.view.getSnapshot())
  const old = [...storage.values.values()][0]
  let release
  storage.read = () => new Promise(resolve => { release = () => resolve(old) })
  const current = navigator(storage)
  const pending = current.navigation.restore()
  current.view.selectSuperagent('new-super', { teamId: 'new-team', homeHub: 'home' })
  current.view.setMode('session')
  release()
  await pending
  assert.equal(current.view.getSnapshot().lastSuperagentId, 'new-super')
  assert.equal(current.view.getSnapshot().mode, 'session')
  assert.deepEqual(current.contacts, [])
})

test('selected contact outside the first page restores through scoped read-only metadata', async () => {
  const selected = { id: 'last-team', superagent_id: 'saved-super', conversation_id: 'saved-conversation', home_hub: 'home', spec: { name: 'Saved' } }
  const preference = { revision: 2, pinned: false, archived: true, archived_through_sequence: 0, updated_at: 1 }
  const calls = []
  const data = createCollabData({ request: async path => {
    calls.push(path)
    if (path.includes('view=contact-preference')) return { home_hub: 'home', team_id: selected.id, principal_id: 'local_owner', preference }
    if (path.includes('team_id=')) return { team: selected, projection: 'configuration_revision' }
    return { home_hub: 'home', items: [], next_cursor: null, projection: 'configuration_revision' }
  } })
  await data.loadTeams()
  await data.restoreSelectedTeam(selected.id, selected.superagent_id)
  const restored = data.getSnapshot().knownTeams['saved-super']
  assert.equal(restored.conversation_id, selected.conversation_id)
  assert.deepEqual(restored.contact.preference, preference)
  assert.equal(restored.contact.attention, undefined)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(path => path.startsWith('/api/kode/collab/teams?')))
  data.dispose()
})
