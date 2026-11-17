import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceContacts } from '../packages/collab/workspace-contacts.js'
import { workspaceScopeKey } from '../packages/collab/workspace-scope.js'
const scope = (patch = {}) => ({ home_hub: 'home', host_id: 'host', workspace_id: 'workspace', root_ref: '/repo one', ...patch })
const team = (id, value = scope()) => ({ id, home_hub: value.home_hub, superagent_id: 'super-' + id, conversation_id: 'conversation-' + id, contact: { preference: { revision: 0, archived_through_sequence: 0, pinned: false, archived: false }, archived: false, needs_attention: false, latest_sequence: 0, unread_count: 0, last_activity_at: 0, attention: { decisions: 0, resources: 0, stopping: 0, active_runs: 0 } }, spec: { name: 'Same display name', workspace_refs: [{ host_id: value.host_id, workspace_id: value.workspace_id, root_ref: value.root_ref }] } })
const page = (items = [], next_cursor = null, extra = {}) => ({ home_hub: 'home', projection: 'contact_directory', archived: false, order: 'pinned_attention_unread_recent', items, next_cursor, ...extra })
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => queueMicrotask(resolve))

test('workspace contacts send the exact registered scope and duplicate loads share a single read', async () => {
 const gate = deferred(), calls = [], accepted = [], value = scope()
 const contacts = createWorkspaceContacts({ request: (path, options) => { calls.push({ path, ...options }); return gate.promise }, onTeams: (...args) => accepted.push(args) })
 const first = contacts.load(value), second = contacts.load({ ...value })
 assert.equal(first, second); await tick(); assert.equal(calls.length, 1)
 const query = new URL(calls[0].path, 'http://fixture').searchParams
 assert.deepEqual(Object.fromEntries(query), { view: 'contacts', after: '', limit: '25', workspace_host: 'host', workspace_id: 'workspace', workspace_root: '/repo one', q: '' })
 gate.resolve(page([team('a')], 'cursor_1')); await first
 const result = contacts.getSnapshot()[workspaceScopeKey(value)]
 assert.equal(result.loading, false); assert.equal(result.loaded, true); assert.equal(result.cursor, 'cursor_1'); assert.equal(accepted.length, 1)
 await contacts.load(value); assert.equal(calls.length, 1, 'a loaded first page is cached without an explicit reload')
 contacts.close()
})

test('same-name channels on different hosts use separate caches and conversation identities are not copied', async () => {
 const a = scope(), b = scope({ host_id: 'remote-node', root_ref: '/remote' }), requests = [], accepted = []
 const originalA = team('a', a), originalB = team('b', b)
 const contacts = createWorkspaceContacts({ request: async path => { requests.push(path); return page([new URL(path, 'http://fixture').searchParams.get('workspace_host') === 'host' ? originalA : originalB]) }, onTeams: rows => accepted.push(...rows) })
 await Promise.all([contacts.load(a), contacts.load(b)])
 assert.equal(requests.length, 2)
 assert.deepEqual(contacts.getSnapshot()[workspaceScopeKey(a)].teams[0], originalA)
 assert.deepEqual(contacts.getSnapshot()[workspaceScopeKey(b)].teams[0], originalB)
 assert.deepEqual(accepted.map(row => row.conversation_id).sort(), ['conversation-a', 'conversation-b'])
 assert.notEqual(workspaceScopeKey(a), workspaceScopeKey(b)); contacts.close()
})

test('each continuation uses its own cursor, merges by identity and a reload replaces only that scope', async () => {
 const calls = [], accepted = [], value = scope(), a = team('a'), updatedA = { ...a, spec: { ...a.spec, name: 'Updated' } }, b = team('b'), c = team('c')
 const replies = [page([a], 'cursor_1'), page([updatedA, b], 'cursor_2'), page([c])]
 const contacts = createWorkspaceContacts({ request: async path => { calls.push(path); return replies.shift() }, onTeams: rows => accepted.push(rows) })
 await contacts.load(value); await contacts.load(value, { more: true })
 assert.equal(new URL(calls[1], 'http://fixture').searchParams.get('after'), 'cursor_1')
 assert.deepEqual(contacts.getSnapshot()[workspaceScopeKey(value)].teams, [updatedA, b])
 await contacts.load(value, { reload: true })
 assert.equal(new URL(calls[2], 'http://fixture').searchParams.get('after'), '')
 assert.deepEqual(contacts.getSnapshot()[workspaceScopeKey(value)].teams, [c])
 await contacts.load(value, { more: true }); assert.equal(calls.length, 3)
 assert.equal(accepted.length, 3); contacts.close()
})

const invalidPages = [
 ['foreign Home', () => page([], null, { home_hub: 'foreign' })],
 ['wrong projection', () => page([], null, { projection: 'configuration_revision' })],
 ['archived rows', () => page([], null, { archived: true })],
 ['wrong ordering', () => page([], null, { order: 'title' })],
 ['foreign host', () => page([team('a', scope({ host_id: 'other' }))])],
 ['foreign workspace id', () => page([team('a', scope({ workspace_id: 'other' }))])],
 ['prefix-only root', () => page([team('a', scope({ root_ref: '/repo one/subdirectory' }))])],
 ['foreign Team Home', () => page([{ ...team('a'), home_hub: 'foreign' }])],
 ['duplicate Team identity', () => page([team('a'), team('a')])],
 ['too many rows', () => page(Array.from({ length: 26 }, (_, index) => team('a' + index)))],
 ['invalid cursor alphabet', () => page([], 'cursor/+')],
 ['empty nonterminal cursor', () => page([], '')],
 ['oversized cursor', () => page([], 'a'.repeat(16385))],
 ['numeric cursor', () => page([], 123)],
 ['missing cursor', () => { const result = page(); delete result.next_cursor; return result }],
]
for (const [name, reply] of invalidPages) test(`invalid workspace receipt is rejected before publishing: ${name}`, async () => {
 let published = 0
 const contacts = createWorkspaceContacts({ request: async () => reply(), onTeams: () => { published++ } })
 await contacts.load(scope())
 assert.equal(published, 0, 'invalid receipt cannot reach shared Team/conversation state')
 const result = contacts.getSnapshot()[workspaceScopeKey(scope())]
 assert.equal(result.loaded, undefined); assert.equal(result.loading, false); assert.ok(result.error)
 contacts.close()
})

test('a repeated continuation cursor cannot overwrite the cached page and can be retried after failure', async () => {
 const a = team('a'), b = team('b'); let call = 0
 const contacts = createWorkspaceContacts({ request: async () => ++call === 1 ? page([a], 'cursor_1') : call === 2 ? page([b], 'cursor_1') : page([b]), onTeams() {} })
 await contacts.load(scope()); await contacts.load(scope(), { more: true })
 const failed = contacts.getSnapshot()[workspaceScopeKey(scope())]
 assert.deepEqual(failed.teams, [a]); assert.equal(failed.cursor, 'cursor_1'); assert.ok(failed.error)
 await contacts.load(scope(), { more: true })
 assert.deepEqual(contacts.getSnapshot()[workspaceScopeKey(scope())].teams, [a, b]); assert.equal(contacts.getSnapshot()[workspaceScopeKey(scope())].error, '')
 contacts.close()
})

test('closing aborts outstanding requests and fences a late successful response from shared state', async () => {
 const gate = deferred(), calls = [], accepted = []
 const contacts = createWorkspaceContacts({ request: (path, options) => { calls.push({ path, ...options }); return gate.promise }, onTeams: rows => accepted.push(rows) })
 const task = contacts.load(scope()); await tick()
 const snapshot = contacts.getSnapshot(); contacts.close(); assert.equal(calls[0].signal.aborted, true)
 gate.resolve(page([team('late')])); await task
 assert.equal(contacts.getSnapshot(), snapshot); assert.deepEqual(accepted, [])
})

test('closing before a scheduled read prevents any network call', async () => {
 let calls = 0
 const contacts = createWorkspaceContacts({ request: async () => { calls++; return page() }, onTeams() {} })
 const task = contacts.load(scope()); contacts.close(); await task
 assert.equal(calls, 0)
})

test('a closed directory refuses new work without starting a request', async () => {
 let calls = 0
 const contacts = createWorkspaceContacts({ request: async () => { calls++; return page() }, onTeams() {} })
 contacts.close()
 const snapshot = contacts.getSnapshot()
 await contacts.load(scope()).catch(() => {})
 assert.equal(calls, 0); assert.equal(contacts.getSnapshot(), snapshot)
})

test('the load captures scope before deferring I/O so a caller edit cannot publish a different scope under the old key', async () => {
 const mutable = scope(), original = { ...mutable }, calls = []
 const contacts = createWorkspaceContacts({ request: async path => { calls.push(path); return page([team('a', original)]) }, onTeams() {} })
 const task = contacts.load(mutable); mutable.root_ref = '/other'; await task
 assert.equal(new URL(calls[0], 'http://fixture').searchParams.get('workspace_root'), original.root_ref)
 assert.equal(contacts.getSnapshot()[workspaceScopeKey(original)].loaded, true)
 contacts.close()
})


test('invalid workspace cannot start I/O and a failed reload retains the last confirmed page', async () => {
 let calls = 0, published = 0
 const first = team('a'), next = team('b')
 const contacts = createWorkspaceContacts({ request: async () => { calls++; if (calls === 2) throw Error('fixture unavailable'); return page([calls === 1 ? first : next], calls === 1 ? 'cursor_1' : null) }, onTeams() { published++ } })
 await assert.rejects(contacts.load(scope({ home_hub: '' })), /scope/)
 assert.equal(calls, 0); assert.deepEqual(contacts.getSnapshot(), {})
 await contacts.load(scope()); await contacts.load(scope(), { reload: true })
 const failed = contacts.getSnapshot()[workspaceScopeKey(scope())]
 assert.deepEqual(failed.teams, [first]); assert.equal(failed.cursor, 'cursor_1'); assert.ok(failed.error); assert.equal(published, 1)
 await contacts.load(scope(), { reload: true })
 assert.deepEqual(contacts.getSnapshot()[workspaceScopeKey(scope())].teams, [next]); assert.equal(published, 2)
 contacts.close()
})

test('slow search A is aborted and cannot overwrite fast search B or publish stale Teams', async () => {
 const a = deferred(), b = deferred(), calls = [], accepted = []
 const contacts = createWorkspaceContacts({ request: (path, options) => { calls.push({ path, ...options }); return calls.length === 1 ? a.promise : b.promise }, onTeams: rows => accepted.push(rows.map(row => row.id)) })
 const first = contacts.load(scope(), { search: 'alpha' }); await tick()
 const second = contacts.load(scope(), { search: 'beta' }); await tick()
 assert.equal(calls.length, 2); assert.equal(calls[0].signal.aborted, true)
 assert.deepEqual(calls.map(row => new URL(row.path, 'http://fixture').searchParams.get('q')), ['alpha', 'beta'])
 b.resolve(page([team('beta')])); await second
 a.resolve(page([team('alpha')], 'stale_cursor')); await first
 const current = contacts.getSnapshot()[workspaceScopeKey(scope())]
 assert.equal(current.query, 'beta'); assert.deepEqual(current.teams.map(row => row.id), ['beta']); assert.equal(current.cursor, null)
 assert.deepEqual(accepted, [['beta']]); contacts.close()
})

test('settling aborted search A leaves pending search B coalesced until B finishes', async () => {
 const a = deferred(), b = deferred(), calls = []
 const contacts = createWorkspaceContacts({ request: (path, options) => { calls.push({ path, ...options }); return calls.length === 1 ? a.promise : b.promise }, onTeams() {} })
 const first = contacts.load(scope(), { search: 'alpha' }); await tick()
 const second = contacts.load(scope(), { search: 'beta' }); await tick()
 a.resolve(page([team('alpha')])); await first
 assert.equal(contacts.getSnapshot()[workspaceScopeKey(scope())].loading, true)
 assert.equal(contacts.load(scope(), { search: 'beta' }), second)
 assert.equal(calls.length, 2)
 b.resolve(page([team('beta')])); await second
 assert.equal(contacts.getSnapshot()[workspaceScopeKey(scope())].loading, false)
 contacts.close()
})

test('polling reload preserves each workspace current query and a changed search drops the old cursor', async () => {
 const calls = [], a = scope(), b = scope({ host_id: 'remote', root_ref: '/remote' })
 const contacts = createWorkspaceContacts({ request: async path => { const q = new URL(path, 'http://fixture').searchParams; calls.push(Object.fromEntries(q)); return page([team(q.get('q') || 'empty', q.get('workspace_host') === 'host' ? a : b)], 'cursor_' + calls.length) }, onTeams() {} })
 await contacts.load(a, { search: 'alpha' }); await contacts.load(b, { search: 'beta' })
 await contacts.load(a, { reload: true }); await contacts.load(b, { reload: true })
 assert.deepEqual(calls.map(row => row.q), ['alpha', 'beta', 'alpha', 'beta'])
 assert.ok(calls.every(row => row.after === ''))
 await contacts.load(a, { more: true }); assert.equal(calls.at(-1).q, 'alpha'); assert.equal(calls.at(-1).after, 'cursor_3')
 await contacts.load(a, { search: 'gamma' }); assert.equal(calls.at(-1).q, 'gamma'); assert.equal(calls.at(-1).after, '')
 assert.equal(contacts.getSnapshot()[workspaceScopeKey(a)].query, 'gamma'); assert.equal(contacts.getSnapshot()[workspaceScopeKey(b)].query, 'beta')
 assert.deepEqual(contacts.getSnapshot()[workspaceScopeKey(a)].teams.map(row => row.id), ['gamma'])
 contacts.close()
})

test('invalid search bytes are refused before I/O and close aborts the newest search generation', async () => {
 const gate = deferred(), calls = []
 const contacts = createWorkspaceContacts({ request: (path, options) => { calls.push({ path, ...options }); return gate.promise }, onTeams() {} })
 for (const search of [123, 'bad\0search', '掌'.repeat(54)]) await assert.rejects(contacts.load(scope(), { search }), /search/)
 assert.equal(calls.length, 0)
 const job = contacts.load(scope(), { search: 'allowed' }); await tick(); contacts.close()
 assert.equal(calls[0].signal.aborted, true)
 gate.resolve(page([team('late')])); await job
 assert.equal(contacts.getSnapshot()[workspaceScopeKey(scope())].loaded, false)
})
