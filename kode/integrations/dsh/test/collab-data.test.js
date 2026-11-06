import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollabData, requestCollabRead, requestConversationReadState } from '../packages/collab/data.js'
const team = id => ({ id, superagent_id: `super-${id}`, conversation_id: `dm-${id}`, home_hub: 'home', spec: { name: id } })
const directory = (items, next_cursor = null) => ({ items, next_cursor, home_hub: 'home', projection: 'configuration_revision' })
const message = (id, sequence) => ({ id: `msg-${id}-${sequence}`, conversation_id: `dm-${id}`, team_id: id, home_hub: 'home', sequence, content: 'hello' })
const history = (id, items, more = false) => ({ conversation_id: `dm-${id}`, team_id: id, home_hub: 'home', items, has_more: more, next_cursor: more ? items.at(-1).sequence : null })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('read-state transport restricts its endpoint and carries cancellation and owner cookies', async () => {
  const controller = new AbortController(), calls = []
  const fetcher = async (path, init) => { calls.push({ path, init }); return { ok: true, json: async () => ({ through_sequence: 3 }) } }
  await requestConversationReadState('/api/kode/conversation/read-state?conversation_id=dm-a', { fetcher })
  const body = { conversation_id: 'dm-a', through_sequence: 3 }
  await requestConversationReadState('/api/kode/conversation/read-state', { fetcher, body, signal: controller.signal })
  assert.equal(calls[0].init.method, 'GET'); assert.equal('body' in calls[0].init, false)
  assert.equal(calls[1].init.method, 'POST'); assert.deepEqual(JSON.parse(calls[1].init.body), body)
  assert.equal(calls[1].init.credentials, 'same-origin'); assert.equal(calls[1].init.redirect, 'error')
  controller.abort(); assert.equal(calls[1].init.signal.aborted, true)
  await assert.rejects(requestConversationReadState('/api/kode/coordinator/start', { body, fetcher }))
  await assert.rejects(requestConversationReadState('/api/kode/conversation/read-state?conversation_id=dm-a', { body, fetcher }))
  await assert.rejects(requestConversationReadState('/api/kode/conversation/read-state', { body, fetcher: async () => ({ ok: false }) }))
  assert.equal(calls.length, 2)
})

test('directory and histories paginate explicitly; failed reads retain prior content', async () => {
  const calls = [], replies = [directory([team('a')], 'a'), directory([team('b')]), history('a', [message('a', 2)], true), history('a', [message('a', 5)]), Error('private')]
  const store = createCollabData({ request: async path => { calls.push(path); const next = replies.shift(); if (next instanceof Error) throw next; return next } })
  await store.loadTeams(); await store.loadTeams({ more: true })
  assert.deepEqual(store.getSnapshot().teams.map(t => t.id), ['a', 'b'])
  await store.loadMessages('dm-a'); await store.loadMessages('dm-a')
  assert.match(calls[3], /after=2/); assert.deepEqual(store.getSnapshot().conversations['dm-a'].items.map(m => m.sequence), [2, 5])
  await store.loadMessages('dm-a')
  assert.equal(store.getSnapshot().conversations['dm-a'].items.length, 2)
  assert.ok(store.getSnapshot().conversations['dm-a'].error); assert.equal(store.getSnapshot().conversations['dm-a'].error.includes('private'), false)
  assert.equal(calls.length, 5)
})

test('concurrent conversation reads coalesce per identity and never overwrite the other conversation', async () => {
  const a = deferred(), b = deferred(); let calls = 0
  const store = createCollabData({ request: path => {
    calls++; if (path.includes('/collab/teams')) return directory([team('a'), team('b')])
    return path.includes('dm-a') ? a.promise : b.promise
  } })
  await store.loadTeams()
  const first = store.loadMessages('dm-a'), duplicate = store.loadMessages('dm-a'), second = store.loadMessages('dm-b')
  assert.equal(first, duplicate)
  b.resolve(history('b', [message('b', 10)])); await second
  a.resolve(history('a', [message('a', 4)])); await first
  assert.equal(calls, 3); assert.equal(store.getSnapshot().conversations['dm-b'].items[0].team_id, 'b')
  assert.equal(store.getSnapshot().conversations['dm-a'].items[0].team_id, 'a')
})

test('refresh fences an older directory continuation and disposal aborts outstanding reads', async () => {
  const more = deferred(), refresh = deferred(); let count = 0, lastSignal
  const store = createCollabData({ request: (_, { signal }) => { lastSignal = signal; return ++count === 1 ? directory([team('a')], 'a') : count === 2 ? more.promise : refresh.promise } })
  await store.loadTeams(); const older = store.loadTeams({ more: true }); await Promise.resolve()
  const newer = store.loadTeams(); await Promise.resolve()
  refresh.resolve(directory([team('c')])); await newer
  more.resolve(directory([team('b')])); await older
  assert.deepEqual(store.getSnapshot().teams.map(t => t.id), ['c'])
  const hanging = deferred()
  const other = createCollabData({ request: (_, { signal }) => { lastSignal = signal; return hanging.promise } })
  const pending = other.loadTeams(); await Promise.resolve(); other.dispose()
  assert.equal(lastSignal.aborted, true)
  hanging.resolve(directory([team('d')])); await pending; assert.deepEqual(other.getSnapshot().teams, [])
})

test('foreign home or conversation responses are not published and read helper cannot mutate', async () => {
  let result = directory([team('a')])
  const store = createCollabData({ request: async () => result }); await store.loadTeams()
  result = history('b', [message('b', 1)]); await store.loadMessages('dm-a')
  assert.deepEqual(store.getSnapshot().conversations['dm-a'].items, [])
  result = { ...directory([team('b')]), home_hub: 'other' }; await store.loadTeams()
  assert.equal(store.getSnapshot().teams[0].id, 'a')
  await assert.rejects(store.loadMessages('dm-unknown'))
  let options
  await requestCollabRead('/api/kode/collab/teams?limit=25', { fetcher: async (_, init) => { options = init; return { ok: true, json: async () => ({}) } } })
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal('body' in options, false)
  await requestCollabRead('/api/kode/builder/default-selection?draft_id=draft&revision=1', { fetcher: async (path, init) => { assert.equal(init.method, 'GET'); assert.equal('body' in init, false); return { ok: true, json: async () => ({ eligible_for_execution: false }) } } })
  await assert.rejects(requestCollabRead('/api/kode/builder/default-selection/execute'))
  await requestCollabRead('/api/kode/work-run/execution?run_id=run&team_id=team', { fetcher: async (_, init) => { assert.equal(init.method, 'GET'); assert.equal('body' in init, false); return { ok: true, json: async () => ({ authority: 'host_observation' }) } } })
  await assert.rejects(requestCollabRead('/api/kode/work-run/execution/retry'))
  await requestCollabRead('/api/kode/work-run/trace?run_id=run&team_id=team&view=manifest', { fetcher: async (_, init) => { assert.equal(init.method, 'GET'); assert.equal('body' in init, false); return { ok: true, json: async () => ({ read_only: true }) } } })
  await assert.rejects(requestCollabRead('/api/kode/work-run/trace/execute'))
  await assert.rejects(requestCollabRead('/api/kode/coordinator/start'))
})

test('malformed pagination cannot advance or duplicate the cached history', async () => {
  let result = directory([team('a')])
  const store = createCollabData({ request: async () => result }); await store.loadTeams()
  result = history('a', [message('a', 3)]); await store.loadMessages('dm-a')
  for (const page of [history('a', [message('a', 3)]), { ...history('a', [message('a', 4)], true), next_cursor: 99 }, history('a', [message('a', 5), message('a', 4)])]) {
    result = page; await store.loadMessages('dm-a')
    assert.equal(store.getSnapshot().conversations['dm-a'].cursor, 3)
    assert.equal(store.getSnapshot().conversations['dm-a'].items.length, 1)
  }
  result = directory([team('b')], 'not-the-last-id'); await store.loadTeams()
  assert.equal(store.getSnapshot().teams[0].id, 'a')
})

test('search fences stale pages while retaining selected conversation identity and history', async () => {
  const old = deferred(), newer = deferred(), paths = []
  const store = createCollabData({ request: path => {
    paths.push(path)
    if (path.includes('/messages')) return history('a', [message('a', 1)])
    if (path.includes('q=old')) return old.promise
    if (path.includes('q=new')) return newer.promise
    return directory([team('a')])
  } })
  await store.loadTeams(); await store.loadMessages('dm-a')
  const stale = store.loadTeams({ search: 'old' }); await Promise.resolve()
  const latest = store.loadTeams({ search: 'new' }); await Promise.resolve()
  newer.resolve(directory([team('b')], 'b')); await latest
  old.resolve(directory([team('c')])); await stale
  assert.deepEqual(store.getSnapshot().teams.map(t => t.id), ['b'])
  assert.equal(store.getSnapshot().knownTeams['super-a'].conversation_id, 'dm-a')
  assert.equal(store.getSnapshot().conversations['dm-a'].items.length, 1)
  assert.equal(store.getSnapshot().directoryQuery, 'new')
  await assert.rejects(store.loadTeams({ more: true, search: 'old' }), /cursor/)
  await assert.rejects(store.loadTeams({ search: '中'.repeat(54) }), /Invalid/)
  await store.loadTeams({ search: '' })
  assert.deepEqual(store.getSnapshot().teams.map(t => t.id), ['a'])
  assert.ok(paths.some(path => path.includes('q=new')))
  store.dispose()
})

test('read positions require loaded messages, coalesce retries and fence reordered replies', async () => {
  const older = deferred(), newer = deferred(), reads = []
  const state = (through, latest = 5) => ({ home_hub: 'home', team_id: 'a', conversation_id: 'dm-a', principal_id: 'local_owner', through_sequence: through, latest_sequence: latest, unread_count: latest - through })
  let response = state(0)
  const store = createCollabData({
    request: async path => path.includes('/teams') ? directory([team('a')]) : history('a', [message('a', 2), message('a', 5)]),
    readRequest: (path, options) => { reads.push({ path, ...options }); if (options.body?.through_sequence === 2) return older.promise; if (options.body?.through_sequence === 5) return newer.promise; return response },
  })
  await store.loadTeams()
  await store.loadReadState('dm-a')
  assert.equal(store.getSnapshot().conversations['dm-a'].readState.unread_count, 5)
  await assert.rejects(store.markRead('dm-a', 5), /loaded/)
  await assert.rejects(store.markRead('dm-a'), /required/)
  await store.loadMessages('dm-a')
  assert.equal(reads.length, 1, 'fetching history must not mark it read')
  const first = store.markRead('dm-a', 2), duplicate = store.markRead('dm-a', 2), last = store.markRead('dm-a', 5)
  assert.equal(first, duplicate)
  newer.resolve(state(5)); await last
  older.resolve(state(2)); await first
  assert.equal(store.getSnapshot().conversations['dm-a'].readState.through_sequence, 5)
  assert.equal(store.getSnapshot().conversations['dm-a'].readState.unread_count, 0)
  response = { ...state(5), principal_id: 'another-owner' }
  await store.loadReadState('dm-a')
  assert.ok(store.getSnapshot().conversations['dm-a'].readError)
  assert.equal(store.getSnapshot().conversations['dm-a'].readState.principal_id, 'local_owner')
  response = state(5, 8); await store.loadReadState('dm-a')
  assert.equal(store.getSnapshot().conversations['dm-a'].readState.unread_count, 3)
  assert.equal(store.getSnapshot().conversations['dm-a'].readError, '')
  response = state(5, 5); await store.loadReadState('dm-a')
  assert.equal(store.getSnapshot().conversations['dm-a'].readState.latest_sequence, 8)
  store.dispose()
})

test('unconfirmed read acknowledgment preserves confirmed state and disposal aborts it', async () => {
  const hanging = deferred(); let signal, fail = true
  const store = createCollabData({
    request: async path => path.includes('/teams') ? directory([team('a')]) : history('a', [message('a', 2)]),
    readRequest: async (_, options) => { signal = options.signal; if (fail) throw Error('private transport'); return hanging.promise },
  })
  await store.loadTeams(); await store.loadMessages('dm-a')
  await store.markRead('dm-a', 2)
  assert.equal(store.getSnapshot().conversations['dm-a'].readState, null)
  assert.ok(!store.getSnapshot().conversations['dm-a'].readError.includes('private'))
  fail = false
  const retry = store.markRead('dm-a', 2); await Promise.resolve()
  store.dispose(); assert.equal(signal.aborted, true)
  hanging.resolve({ home_hub: 'home', team_id: 'a', conversation_id: 'dm-a', principal_id: 'local_owner', through_sequence: 2, latest_sequence: 2, unread_count: 0 })
  await retry
  assert.equal(store.getSnapshot().conversations['dm-a'].readState, null)
})
