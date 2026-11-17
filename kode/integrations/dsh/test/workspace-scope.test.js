import test from 'node:test'
import assert from 'node:assert/strict'
import { validWorkspaceScope, workspaceScopeKey, sameWorkspace, teamInWorkspace, teamProjectPointer, registeredWorkspaceScopes } from '../packages/collab/workspace-scope.js'
import { createCollabViewState } from '../packages/collab/view-state.js'
import { createNavigationStorage } from '../packages/collab/navigation-storage.js'
const scope = (patch = {}) => ({ home_hub: 'home', host_id: 'local-node', workspace_id: 'workspace', root_ref: '/repo one', ...patch })
const scopedTeam = (value, patch = {}) => ({ id: 'team', superagent_id: 'super', conversation_id: 'conversation', home_hub: value.home_hub, spec: { name: 'Same name', workspace_refs: [{ host_id: value.host_id, workspace_id: value.workspace_id, root_ref: value.root_ref }] }, ...patch })

test('workspace identity is exact Home/Host/id/root, never a title or path prefix', () => {
 const a = scope()
 assert.ok(validWorkspaceScope(a)); assert.equal(sameWorkspace(a, { ...a, title: 'Renamed', rowId: 'arbitrary-ui-row' }), true)
 assert.equal(workspaceScopeKey(a), JSON.stringify(['home', 'local-node', 'workspace', '/repo one']))
 for (const changed of [scope({ home_hub: 'other' }), scope({ host_id: 'ssh-node' }), scope({ workspace_id: 'other' }), scope({ root_ref: '/repo one/child' }), scope({ root_ref: '/repo one/' })]) {
  assert.equal(sameWorkspace(a, changed), false)
  assert.equal(teamInWorkspace(scopedTeam(a), changed), false)
 }
 assert.equal(teamInWorkspace(scopedTeam(a), a), true)
 assert.equal(teamInWorkspace({ ...scopedTeam(a), home_hub: 'foreign' }, a), false)
})

test('SuperAgent project pointer requires known exact membership and canonical project label', () => {
 const picked = scope({title:'Stale title'}), registered = scope({title:'Current name'})
 const team = scopedTeam(picked)
 assert.equal(teamProjectPointer(team,picked,{ready:true,scopes:[registered]}),registered)
 assert.equal(teamProjectPointer(team,picked,{ready:false,scopes:[registered]}),null)
 assert.equal(teamProjectPointer(team,picked,{ready:true,scopes:[scope({host_id:'ssh-node'})]}),null)
 assert.equal(teamProjectPointer(team,picked,{ready:true,scopes:[registered,{...registered}]}),null)
 assert.equal(teamProjectPointer(team,null,{ready:true,scopes:[registered]}),null)
 assert.equal(teamProjectPointer({...team,spec:{workspace_refs:[]}},picked,{ready:true,scopes:[registered]}),null)
})

test('workspace validation rejects incomplete, NUL, oversized UTF-8 and blank root identities', () => {
 for (const value of [null, {}, scope({ host_id: '' }), scope({ workspace_id: 'path/escape' }), scope({ root_ref: '' }), scope({ root_ref: '   \t' }), scope({ root_ref: '/repo\0suffix' }), scope({ root_ref: '掌'.repeat(342) })]) {
  assert.equal(validWorkspaceScope(value), false, JSON.stringify(value))
  assert.equal(workspaceScopeKey(value), null)
 }
 assert.equal(validWorkspaceScope(scope({ root_ref: '/' + '掌'.repeat(341) })), true)
})

test('registered same-name workspaces remain distinct across hosts and native placeholders do not become remote scopes', () => {
 const values = registeredWorkspaceScopes({ items: [{ workspaceId: 'native', path: '/native', title: 'Same name' }, { workspaceId: 'kode-host:ghost/workspace', path: '/invented' }] }, {
  current: 'local', hosts: [{ id: 'local', nodeId: 'local-node', workspaces: [{ id: 'workspace', path: '/local', title: 'Same name' }] }, { id: 'ssh one', nodeId: 'ssh-node', workspaces: [{ id: 'workspace', path: '/remote', title: 'Same name' }] }],
 }, 'home')
 assert.equal(values.length, 3)
 assert.deepEqual(values.map(row => [row.rowId, row.host_id, row.workspace_id, row.root_ref]), [
  ['workspace', 'local-node', 'workspace', '/local'], ['kode-host:ssh%20one/workspace', 'ssh-node', 'workspace', '/remote'], ['native', 'home', 'native', '/native'],
 ])
 assert.equal(new Set(values.map(workspaceScopeKey)).size, 3)
 assert.equal(values.some(row => row.root_ref === '/invented'), false)
})

test('switching any canonical workspace field clears the selected team but never copies or clears conversation drafts', () => {
 const view = createCollabViewState(), a = scope(), b = scope({ host_id: 'ssh-node', root_ref: '/remote' })
 view.selectWorkspace({ ...a, title: 'A' }); view.selectSuperagent('super', { teamId: 'team', homeHub: 'home' }); view.setMode('im')
 view.saveConversation('conversation', { draft: '已有草稿', scrollTop: 128, priorRunId: 'run' })
 const saved = view.conversation('conversation')
 assert.equal(view.selectWorkspace({ ...a, title: 'Renamed' }), false)
 assert.equal(view.getSnapshot().lastSuperagentId, 'super')
 assert.equal(view.selectWorkspace(b), true)
 assert.equal(view.getSnapshot().lastSuperagentId, null); assert.equal(view.getSnapshot().lastTeamId, null); assert.equal(view.getSnapshot().mode, 'session')
 assert.deepEqual(view.conversation('conversation'), saved)
 assert.deepEqual(view.conversation('other-conversation'), { draft: '', scrollTop: 0 })
 assert.deepEqual(view.getSnapshot().workspace, b)
 b.root_ref = '/mutated-input'; assert.equal(view.getSnapshot().workspace.root_ref, '/remote')
 view.selectWorkspace(null); assert.equal(view.getSnapshot().workspace, null); assert.deepEqual(view.conversation('conversation'), saved)
})

const navigationKey = home => JSON.stringify(['navigation-v1', home, 'local_owner'])
function memory(initial = null) {
 const values = new Map(initial ? [[navigationKey('home'), initial]] : [])
 return { values, read: async key => structuredClone(values.get(key) ?? null), update: async (key, change) => { const next = change(structuredClone(values.get(key) ?? null)); values.set(key, structuredClone(next)); return next } }
}
const record = (patch = {}) => ({ format: 'kode.navigation.v3', home_hub: 'home', principal_id: 'local_owner', workspace: scope(), mode: 'im', lastTeamId: 'team', lastSuperagentId: 'super', lastHomeHub: 'home', lastSessionId: 'native-session', ...patch })
function navigator(storage) {
 const modes = [], teams = [], view = createCollabViewState()
 const navigation = createNavigationStorage({ storage, view, home: () => 'home', selectMode: mode => modes.push(mode), restoreTeam: (...ids) => teams.push(ids) })
 return { view, navigation, modes, teams }
}

test('v3 workspace navigation round-trips exact scope without persisting display metadata or conversation contents', async () => {
 const storage = memory(), current = navigator(storage)
 current.view.selectWorkspace({ ...scope(), title: 'UI only', rowId: 'UI only' }); current.view.selectSuperagent('super', { teamId: 'team', homeHub: 'home' }); current.view.rememberSession('native-session'); current.view.setMode('im')
 current.view.saveConversation('conversation', { draft: '不写入导航记录', scrollTop: 5 })
 await current.navigation.save(current.view.getSnapshot())
 const saved = storage.values.get(navigationKey('home'))
 assert.deepEqual(saved, record())
 assert.equal(JSON.stringify(saved).includes('不写入导航记录'), false)
 const restored = navigator(storage); await restored.navigation.restore()
 assert.deepEqual(restored.view.getSnapshot().workspace, scope()); assert.deepEqual(restored.modes, ['im']); assert.deepEqual(restored.teams, [['team', 'super']])
 assert.deepEqual(restored.view.conversation('conversation'), { draft: '', scrollTop: 0 })
 current.navigation.close(); restored.navigation.close()
})
for (const format of ['kode.navigation.v1', 'kode.navigation.v2']) test(`${format} without workspace migrates to v3 without stealing native navigation or duplicating drafts`, async () => {
 const saved = record({ format }); delete saved.workspace
 const storage = memory(saved), current = navigator(storage)
 await current.navigation.restore()
 assert.equal(current.view.getSnapshot().workspace, null); assert.deepEqual(current.modes, ['session']); assert.deepEqual(current.teams, [['team', 'super']])
 assert.equal(current.view.getSnapshot().lastSessionId, 'native-session')
 const migrated = storage.values.get(navigationKey('home')); assert.equal(migrated.format, 'kode.navigation.v3'); assert.equal(migrated.workspace, null); assert.equal(migrated.mode, 'session')
 current.navigation.close()
})

test('foreign or malformed persisted workspace scope is rejected before restoring a contact', async () => {
 for (const workspace of [scope({ home_hub: 'foreign' }), scope({ workspace_id: '' }), scope({ root_ref: '/bad\0root' })]) {
  const current = navigator(memory(record({ workspace })))
  await assert.rejects(current.navigation.restore(), /Home/)
  assert.deepEqual(current.modes, []); assert.deepEqual(current.teams, []); assert.equal(current.view.getSnapshot().workspace, null)
  current.navigation.close()
 }
})

test('an outstanding restore cannot override a newly selected workspace and its draft remains local to its conversation', async () => {
 let release, navigation
 const storage = memory(record()); storage.read = () => new Promise(resolve => { release = resolve })
 const view = createCollabViewState({ onNavigationChange: value => { void navigation?.save(value) } })
 const modes = [], teams = []
 navigation = createNavigationStorage({ storage, view, home: () => 'home', selectMode: mode => modes.push(mode), restoreTeam: (...ids) => teams.push(ids) })
 const restoring = navigation.restore(), next = scope({ workspace_id: 'new', root_ref: '/new' })
 view.selectWorkspace(next); view.saveConversation('new-conversation', { draft: '新草稿' }); release(record())
 await restoring; await navigation.save(view.getSnapshot())
 assert.deepEqual(view.getSnapshot().workspace, next); assert.equal(view.getSnapshot().lastTeamId, null); assert.deepEqual(teams, []); assert.deepEqual(modes, [])
 assert.equal(view.conversation('new-conversation').draft, '新草稿'); assert.equal(view.conversation('conversation').draft, '')
 navigation.close()
})

test('a nonlocal selected Host never reclassifies native project placeholders as Home-owned workspaces', () => {
 const native = { items: [{ workspaceId: 'remote-project', path: '/ssh/project', title: 'Shared title' }, { workspaceId: 'local-looking', path: '/local-looking' }] }
 const remote = { current: 'ssh-selected', hosts: [{ id: 'ssh-selected', nodeId: 'ssh-node', workspaces: [{ id: 'remote-project', path: '/ssh/project', title: 'Shared title' }] }] }
 assert.deepEqual(registeredWorkspaceScopes(native, remote, 'home'), [{ home_hub: 'home', host_id: 'ssh-node', workspace_id: 'remote-project', root_ref: '/ssh/project', rowId: 'remote-project', title: 'Shared title' }])
 assert.deepEqual(registeredWorkspaceScopes(native, { ...remote, hosts: [] }, 'home'), [], 'without remote registration evidence the native placeholders remain unclassified')
})
