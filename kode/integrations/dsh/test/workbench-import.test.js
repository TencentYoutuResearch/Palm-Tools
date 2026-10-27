import test from 'node:test'
import assert from 'node:assert/strict'
import { saveNativeTab, syncNativeTabs } from '../src/workbench-import.js'

function fixture() {
  let value = { version: 1, gui: { tabs: [{ session_id: 'opened-tab' }] } }, revision = 0
  const client = { call: async (path, update) => {
    if (path.endsWith('/catalog')) return { backends: { codex: { command: 'codex' }, tcodex: { command: 'tcodex' } } }
    if (update) { assert.equal(update.expected_revision, revision); value = structuredClone(update.value); revision++ }
    return { revision, value: structuredClone(value) }
  } }
  const profiles = { binding: () => ({ threadId: 'native-thread', profile: { id: 'team', type: 'codex', name: 'Team worker', executable: 'tcodex' } }) }
  return { client, profiles, state: () => value, closeTabs: () => { value.gui.tabs = []; revision++ } }
}
test('native registrations keep executable identity and survive opened-tab replacement', async () => {
  const h = fixture(), agent = { id: 'inline-session', session: { header: { cwd: '/srv/project' }, requestHeader: () => ({ config: { model: 'model-a' } }) } }
  await saveNativeTab(h.client, h.profiles, agent, 'Helper')
  assert.equal(h.state().gui.tabs.length, 1)
  assert.equal(h.state().native_sessions[0].backend_key, 'tcodex')
  h.closeTabs()
  await saveNativeTab(h.client, h.profiles, agent, 'Renamed helper')
  assert.equal(h.state().gui.tabs.length, 0)
  assert.equal(h.state().native_sessions.length, 1)
  assert.equal(h.state().native_sessions[0].title, 'Renamed helper')
  assert.equal(h.state().native_sessions[0].dsh_session_id, 'inline-session')
  assert.equal(h.state().native_sessions[0].transport_kind, 'pty')
})
test('cold-session reconciliation reads summaries without activating any Agent', async () => {
  const h = fixture()
  const controller = { list: async () => ({ items: [{ sessionId: 'inline-session', cwd: '/srv/project', projections: { values: { title: 'Cold helper', modelSelection: { lastUsed: { model: 'model-a' } } } } }] }) }
  await syncNativeTabs(controller, h.client, h.profiles)
  assert.equal(h.state().native_sessions[0].title, 'Cold helper')
  assert.equal(h.state().native_sessions[0].model, 'model-a')
})
