import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { RuntimeBridge, projectSessionEvent, permissionSnapshot } from '../src/runtime-bridge.js'
import { BackendClient } from '../src/backend-client.js'
import { tmpdir } from 'node:os'

test('intentional blank creation returns a durable routing identity without publishing a visible empty conversation', async () => {
  const agents = new Map(), rows = [], publications = []
  let creates = 0, allocations = 0
  const profile = { id: 'fixture', name: 'Fixture Claude', type: 'claude', defaultModel: 'fixture-model' }
  const services = {
    agents: { get: id => agents.get(id) },
    workspaceRegistry: { resolveByPath: async () => ({ id: 'fixture-workspace' }) },
    kodeAgents: { hasRuntime: () => true, profiles: { list: () => [profile], bind: async () => {}, binding: () => ({ profile }) }, adapter: { listModels: async () => [{ id: 'fixture-model' }] }, recordBinding() {} },
    sessionController: {
      list: async () => ({ items: rows }),
      create: async ({ sessionId }) => {
        creates++; rows.push({ sessionId, cwd: tmpdir(), blank: true })
        agents.set(sessionId, { id: sessionId, status: 'idle', session: { snapshotEvents: () => [], header: { cwd: tmpdir() } }, selectModel() {}, ctx: { sessions: { flush: async () => {} } } })
        return { sessionId }
      },
      resolveAgent: async id => ({ agent: agents.get(id) }),
    },
  }
  const backend = { call: async (path, body) => {
    if (path.endsWith('/sessions')) return { sessions: [] }
    publications.push(body)
    if (body.sessions.length && allocations++ === 0) return { sessions: [] }
    return { sessions: body.sessions.map(row => ({ session_id: row.session_id, id: 101 })) }
  } }
  const bridge = new RuntimeBridge({ get: key => services[key] }, backend)
  const command = { id: 'handoff:fixture:create', kind: 'create_session', payload: { cwd: tmpdir(), backend_key: 'dsh:fixture' } }
  await assert.rejects(bridge.execute(command), /did not allocate.*identity/)
  const result = await bridge.execute(command)
  assert.equal(result.id, 101)
  assert.equal(result.runtime_session_id, rows[0].sessionId)
  assert.equal(publications.flatMap(row => row.sessions).find(row => row.session_id === result.runtime_session_id).dto.status, 'exited')
  assert.deepEqual(await bridge.execute(command), result)
  assert.equal(creates, 1)
})

test('backend handoff to a blank Claude target creates and delivers exactly once through the real runtime bridge', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const backend = new BackendClient(process.env.KODE_TEST_BACKEND_URL, (await readFile(process.env.KODE_TEST_TOKEN_FILE, 'utf8')).trim())
  await backend.call('/api/v1/messaging/workbench/agents')
  const registry = await backend.call('/api/v1/messaging/workbench/documents/agents')
  const configured = registry.value.profiles.find(row => row.type === 'claude')
  assert.ok(configured, 'fixture backend must advertise a Claude profile')
  const profile = { ...configured, defaultModel: 'fixture-model' }, agents = new Map(), rows = []
  const sourceId = `handoff-source-${randomUUID()}`, sourceEvents = [{ type: 'user/message', seq: 0, data: { id: 'fixture-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the fixture task' }] } }]
  rows.push({ sessionId: sourceId, cwd: tmpdir(), blank: false, title: 'Original fixture' })
  let creates = 0, inputs = 0
  const services = {
    agents: { get: id => agents.get(id) },
    workspaceRegistry: { resolveByPath: async () => ({ id: 'fixture-workspace' }) },
    kodeAgents: { hasRuntime: () => true, profiles: { list: () => [profile], bind: async () => {}, binding: () => ({ profile }) }, adapter: { listModels: async () => [{ id: 'fixture-model' }] }, recordBinding() {} },
    sessionController: {
      list: async () => ({ items: rows }), inspect: async () => ({ events: sourceEvents }),
      create: async ({ sessionId }) => {
        creates++; rows.push({ sessionId, cwd: tmpdir(), blank: true })
        agents.set(sessionId, { id: sessionId, status: 'idle', session: { snapshotEvents: () => [], header: { cwd: tmpdir() } }, selectModel() {}, ctx: { sessions: { flush: async () => {} } } })
        return { sessionId }
      },
      resolveAgent: async id => ({ agent: agents.get(id) }),
      prompt: async ({ sessionId, content }) => {
        inputs++; assert.ok(content[0].text.includes('Continue the fixture task'))
        rows.find(row => row.sessionId === sessionId).blank = false
        return { accepted: true }
      },
    },
  }
  const bridge = new RuntimeBridge({ get: key => services[key], logger: { warn() {} } }, backend, { intervalMs: 20 }).start()
  try {
    await bridge.publish()
    const request = { source_session_id: sourceId, source_runtime: 'dsh', target_runtime: 'dsh', profile_id: profile.id, request_id: `fixture-${randomUUID()}` }
    const result = await backend.call('/api/v1/messaging/workbench/handoff', request)
    assert.ok(Number.isSafeInteger(result.id))
    assert.equal(result.sessionId, rows[1].sessionId)
    assert.deepEqual(await backend.call('/api/v1/messaging/workbench/handoff', request), result)
    assert.equal(creates, 1); assert.equal(inputs, 1)
  } finally { await bridge.close() }
})
import { Session } from '@deepseek-ai/dsh-session'

test('empty ungrouped placeholders retire old publications without being inspected or republished',async()=>{
  const publications=[]
  const controller={list:async()=>({items:[{sessionId:'blank',blank:true}]}),inspect:async()=>{throw new Error('empty placeholder must not be inspected')}}
  const services={sessionController:controller}
  const backend={call:async(path,body)=>{
    if(path.endsWith('/sessions'))return{sessions:[{runtime:'dsh',runtime_session_id:'blank',status:'idle'}]}
    publications.push(body);return{sessions:[]}
  }}
  const bridge=new RuntimeBridge({get:key=>services[key]},backend)
  await bridge.publish()
  assert.equal(publications.flatMap(row=>row.sessions).length,1)
  assert.equal(publications[0].sessions[0].session_id,'blank')
  assert.equal(publications[0].sessions[0].dto.status,'exited')
  await bridge.publish()
  assert.equal(publications.flatMap(row=>row.sessions).length,1)
})

test('archived sessions retire old publications without inspecting or starting an Agent', async () => {
  const publications = []
  const services = {
    workspaceRegistry: { archivedSessionIds: ['archived'] },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'archived', blank: false }] }),
      inspect: async () => { throw new Error('Archived history must not be inspected') },
    },
  }
  const backend = { call: async (path, body) => {
    if (path.endsWith('/sessions')) return { sessions: [{ runtime: 'dsh', runtime_session_id: 'archived', status: 'idle' }] }
    publications.push(body); return { sessions: [] }
  } }
  const bridge = new RuntimeBridge({ get: key => services[key] }, backend)
  await Promise.all([bridge.publish(), bridge.publish()])
  const rows = publications.flatMap(row => row.sessions)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].session_id, 'archived')
  assert.equal(rows[0].dto.status, 'exited')
})

test('canonical messages, native tools and turn boundaries retain identities and content', () => {
  const content = [{ type: 'text', text: 'A reply' }, { type: 'image', attachment: { id: 'image-1' } }]
  const [message] = projectSessionEvent({ seq: 5, type: 'assistant/message', data: { message: { id: 'native-message', content } } }, 'shared-message')
  assert.equal(message.payload.id, 'shared-message'); assert.equal(message.payload.text, 'A reply'); assert.deepEqual(message.payload.content, content)
  assert.equal(projectSessionEvent({ seq: 6, type: 'tool/result', data: { callId: 'call-1', message: { isError: true, content: [{ type: 'text', text: 'Command failed' }] } } })[0].payload.status, 'error')
  assert.equal(projectSessionEvent({ seq: 7, type: 'turn/end', data: {} })[0].payload.status, 'idle')
  assert.deepEqual(projectSessionEvent({ seq: 8, type: 'request/header', data: { private: 'not a chat message' } }), [])
})

test('stream snapshots are bounded and a committed reply wins over buffered deltas', async () => {
  const publications = [], events = [{ seq: 0, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'native', content: [{ type: 'text', text: 'Finished' }] } } }]
  const services = { sessionController: { list: async () => ({ items: [{ sessionId: 'one' }] }), inspect: async () => ({ events }) }, agents: { get: () => undefined }, kodeAgents: { profiles: { binding: () => undefined } } }
  const bridge = new RuntimeBridge({ get: key => services[key] }, { call: async (path, body) => { if (path.endsWith('/sessions')) return { sessions: [] }; publications.push(body); return { sessions: [{ id: 100, session_id: 'one' }] } } })
  for (let index = 0; index < 100; index++) bridge.emit('one', { key: `stream:${index}`, kind: 'message', payload: { id: 'dsh:one:1:1:0', text: `Partial ${index}`, streaming: true } })
  assert.equal(bridge.extra.get('one').length, 1)
  await bridge.publish()
  const projected = publications[0].sessions[0].events
  assert.equal(projected.length, 1); assert.equal(projected[0].payload.id, 'dsh:one:1:1:0')
  assert.equal(projected.at(-1).payload.text, 'Finished'); assert.equal(projected.at(-1).payload.streaming, false)
})

test('real Kode backend routes mobile input into the existing dsh session and preserves replay', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const token = (await readFile(process.env.KODE_TEST_TOKEN_FILE, 'utf8')).trim()
  const backend = new BackendClient(process.env.KODE_TEST_BACKEND_URL, token)
  const sessionId = `runtime-${randomUUID()}`, runtimeId = `runtime-${randomUUID()}`
  const events = [{ seq: 0, type: 'user/message', data: { id: 'old-user', content: [{ type: 'text', text: 'Existing desktop prompt' }] } }]
  let submissions = 0
  const controller = {
    list: async () => ({ items: [{ sessionId, cwd: '/tmp', title: 'Shared session' }] }), inspect: async () => ({ events }),
    prompt: async request => { assert.equal(request.sessionId, sessionId); submissions++; events.push({ seq: events.length, type: 'user/message', data: { id: request.requestId, content: request.content } }); return { accepted: true } },
  }
  const services = { sessionController: controller, agents: { get: () => undefined }, kodeAgents: { profiles: { binding: () => undefined } } }
  const bridge = new RuntimeBridge({ get: key => services[key], logger: { warn() {} } }, backend, { runtime: runtimeId, intervalMs: 20 }).start()
  try {
    const deadline = Date.now() + 5000
    while (!bridge.ids.has(sessionId)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)) }
    const publicId = bridge.ids.get(sessionId), requestId = randomUUID()
    const request = { session_id: publicId, kind: 'input', payload: { text: 'Sent from phone' }, request_id: requestId }
    const result = await backend.call('/api/v1/messaging/runtime/command', request)
    assert.equal(result.accepted, true)
    await backend.call('/api/v1/messaging/runtime/command', request)
    assert.equal(submissions, 1)
    await assert.rejects(backend.call('/api/v1/messaging/runtime/command', { ...request, payload: { text: 'Conflicting retry' } }), /identity conflicts/)
    await bridge.publish()
    const projected = await backend.call(`/api/v1/messaging/runtime/history?id=${publicId}`)
    assert.deepEqual(projected.events.filter(event => event.type === 'message').map(event => event.payload.text), ['Existing desktop prompt', 'Sent from phone'])
  } finally { await bridge.close() }
})


test('permission changes preserve the deployment preset catalog and flush durable state', async () => {
  const session = {}, changes = []
  let current = 'restricted'
  const service = { names: ['restricted', 'reviewed'], current: () => current, catalog: () => ({ options: [{ value: 'restricted', name: 'Restricted', description: 'Read only' }, { value: 'reviewed', name: 'Reviewed', description: 'Review every change' }] }), set: (target, mode) => { assert.equal(target, session); changes.push(mode); current = mode } }
  let flushed = 0
  const agent = { session, ctx: { sessions: { flush: async target => { assert.equal(target, session); flushed++ } } } }
  const services = { permissionPresets: service, sessionController: { resolveAgent: async () => ({ agent }) } }
  const bridge = new RuntimeBridge({ get: key => services[key] }, {})
  assert.deepEqual(permissionSnapshot(service, session).permission_modes.map(mode => mode.id), ['restricted', 'reviewed'])
  await assert.rejects(bridge.execute({ id: 'bad', kind: 'mode', session_id: 'one', payload: { mode: 'bypassPermissions' } }), /Unsupported permission preset/)
  assert.equal(changes.length, 0)
  assert.deepEqual(await bridge.execute({ id: 'ok', kind: 'mode', session_id: 'one', payload: { mode: 'reviewed' } }), { accepted: true, mode: 'reviewed' })
  assert.equal(flushed, 1)
})

test('mobile session creation applies the shared default model, effort and Fast', async () => {
  const profile = { id: 'worker', name: 'Worker', type: 'codex' }, selections = [], rows = [], probes = []
  const initial = Session.create('mobile-defaults'), session = Session.create('mobile-defaults', [], { ...initial.header, cwd: '/tmp' })
  const agent = { id: 'mobile-defaults', session, selectModel: route => selections.push(route), ctx: { sessions: { flush: async () => {} } } }
  const runtime = {
    profiles: { list: () => [profile], defaultModelFor: () => ({ model: 'fast-model', reasoningEffort: 'high', fast: true }), bind: async () => {}, binding: () => ({ profile }) },
    hasRuntime: () => true, recordBinding() {}, adapter: { listModels: async (...args) => { probes.push(args); return [{ id: 'fast-model', ...(args[2] === 'fast-model' ? { reasoningEfforts: [{ id: 'high' }], defaultReasoningEffort: 'high', fastCapability: { transport: 'service-tier', tier: 'priority', defaultEnabled: false } } : {}) }] } },
  }
  const services = {
    kodeAgents: runtime, agents: { get: () => undefined },
    workspaceRegistry: { resolveByPath: async path => ({ id: 'workspace', path, title: 'Workspace' }) },
    sessionController: { create: async request => { agent.id = request.sessionId; rows.push({ sessionId: request.sessionId, cwd: '/tmp', blank: true }); return { sessionId: request.sessionId } }, resolveAgent: async () => ({ agent }), list: async () => ({ items: rows }) },
  }
  const backend = { call: async (path, body) => path.endsWith('/sessions') ? { sessions: [] } : { sessions: body.sessions.map(row => ({ session_id: row.session_id, id: 100 })) } }
  const bridge = new RuntimeBridge({ get: key => services[key] }, backend)
  await bridge.execute({ id: 'create-defaults', kind: 'create_session', payload: { backend_key: 'dsh:worker', cwd: '/tmp' } })
  assert.equal(probes[0][2], 'fast-model', 'mobile ACP discovery receives the configured default model')
  assert.deepEqual(selections, [{ provider: 'kode-agent-worker', model: 'fast-model', reasoningEffort: 'high' }])
  const fast = session.snapshotEvents().find(event => event.type === 'plugin:kode/model-fast')
  assert.equal(fast.data.fast, true); assert.equal(fast.data.serviceTier, 'priority')
})

test('continued timed questions stay answerable through the original dsh service', async () => {
  const question = { callId: 'timed-call', state: 'continued', questions: [{ id: 'target', question: 'Choose a target', options: [{ label: 'Local' }] }] }
  const row = { sessionId: 'continued-session', projections: { values: { userQuestions: { questions: { active: [question] } } } } }
  const agent = { id: row.sessionId }, publications = []
  let replies = 0
  const services = {
    sessionController: { list: async () => ({ items: [row] }), inspect: async () => ({ events: [] }), resolveAgent: async () => ({ agent }) },
    agents: { get: () => undefined }, kodeAgents: { profiles: { binding: () => undefined } },
    userQuestions: { answer: (owner, callId, answer) => { assert.equal(owner, agent); assert.equal(callId, question.callId); assert.deepEqual(answer.answers, [{ id: 'target', selected: ['Local'] }]); replies++; return true } },
  }
  const bridge = new RuntimeBridge({ get: key => services[key] }, { call: async (path, body) => { if (path.endsWith('/sessions')) return { sessions: [] }; publications.push(body); return { sessions: [{ id: 100 }] } } })
  await bridge.publish()
  const card = publications.at(-1).sessions[0].events.find(event => event.kind === 'ask_user_question')
  assert.ok(card)
  await bridge.answer(row.sessionId, { request_id: card.payload.request_id, response: { action: 'accept', content: { target: 'Local' } } }, 'answer')
  assert.equal(replies, 1)
  assert.throws(() => bridge.answer(row.sessionId, { request_id: card.payload.request_id }, 'answer'), /already settled/)
  await bridge.publish()
  assert.ok(!publications.at(-1).sessions[0].events.some(event => event.kind === 'ask_user_question'))
  row.projections.values.userQuestions.questions.active = []
  await bridge.publish()
  assert.equal(bridge.continued.get(row.sessionId).size, 0)
})

test('0.2.2 query-only cold placeholders retire existing shared publications without activation', async () => {
 let disposed=0
 const publications=[],services={
  sessionController:{list:async()=>({items:[{sessionId:'cold-draft',blank:false,running:false}]})},
  sessionQuery:{observeSession:async()=>({inheritedEventCount:0,events:[{type:'permission/preset'},{type:'session/end-seed',data:{}}],[Symbol.dispose](){disposed++}})},
  agents:{get:()=>undefined},
 }
 const backend={call:async(path,body)=>{
  if(path.endsWith('/sessions'))return {sessions:[{runtime:'dsh',runtime_session_id:'cold-draft',status:'idle'}]}
  publications.push(body);return {sessions:[]}
 }}
 const bridge=new RuntimeBridge({get:key=>services[key]},backend)
 await bridge.publish();await bridge.publish()
 assert.equal(disposed,2);assert.equal(publications.length,1)
 assert.equal(publications[0].sessions[0].dto.status,'exited');assert.deepEqual(publications[0].sessions[0].events,[])
})
test('unchanged unloaded conversations are not re-read every pass, changed or unarchived ones are', async () => {
 let reads=0,row={sessionId:'cold',blank:false,running:false,updatedAt:1,title:'Cold',cwd:'/srv/project'}
 const archived=[]
 const services={
  sessionController:{list:async()=>({items:[row]})},
  sessionQuery:{observeSession:async()=>{reads++;return{inheritedEventCount:0,events:[{type:'turn/start',seq:0,time:1,data:{turn:1}},{type:'turn/end',seq:1,time:2,data:{turn:1,reason:{kind:'completed'}}}],[Symbol.dispose](){}}}},
  agents:{get:()=>undefined},
  workspaceRegistry:{get archivedSessionIds(){return archived}},
  kodeAgents:{profiles:{binding:()=>undefined}},
 }
 const publications=[]
 let index={version:1,gui:{tabs:[]}},revision=0
 const backend={call:async(path,body)=>{
  if(path.endsWith('/sessions'))return{sessions:[]}
  if(path.endsWith('/documents/session-index')){if(body){assert.equal(body.expected_revision,revision);index=body.value;revision++}return{revision,value:structuredClone(index)}}
  publications.push(body);return{sessions:(body.sessions??[]).map((s,i)=>({session_id:s.session_id,id:i+1}))}}}
 const bridge=new RuntimeBridge({get:key=>services[key]},backend)
 const last=()=>publications.filter(body=>body.sessions?.[0]?.session_id==='cold').at(-1).sessions[0].dto.status
 await bridge.publish();await bridge.publish();await bridge.publish()
 assert.equal(reads,1)
 row={...row,updatedAt:2};await bridge.publish()
 assert.equal(reads,2)
 archived.push('cold');await bridge.publish()
 assert.equal(last(),'exited')
 archived.pop();await bridge.publish()
 assert.equal(reads,3);assert.notEqual(last(),'exited')
 // Archiving and unarchiving here edit Kode's shared open list; the first pass
 // only took the baseline, so nothing was added for what was open before.
 assert.deepEqual(index.gui.tabs.map(tab=>tab.dsh_session_id),['cold'])
 archived.push('cold');await bridge.publish()
 assert.deepEqual(index.gui.tabs,[])
})

test('tick executes consecutive delete commands concurrently with one batched publish', async () => {
  const archived = [], released = [], settled = [], publishedExits = []
  let activeArchives = 0, peakArchives = 0, publishSnapshots = 0
  const services = {
    sessionController: {
      list: async () => ({
        items: ['s1', 's2', 's3'].filter(id => !archived.includes(id)).map(sessionId => ({ sessionId, cwd: '/srv/project', title: sessionId })),
      }),
      inspect: async () => ({ events: [] }),
    },
    agents: { get: () => undefined },
    kodeAgents: { profiles: { binding: () => undefined } },
    workspaceRegistry: {
      get archivedSessionIds() { return archived },
      archiveSession: async id => {
        activeArchives++
        peakArchives = Math.max(peakArchives, activeArchives)
        await new Promise(resolve => setTimeout(resolve, 25))
        archived.push(id)
        activeArchives--
      },
    },
    kodeNativeFactory: { release: async id => { released.push(id) } },
  }
  const commands = [
    { id: 'cmd-1', kind: 'delete', session_id: 's1', payload: {} },
    { id: 'cmd-2', kind: 'delete', session_id: 's2', payload: {} },
    { id: 'cmd-3', kind: 'delete', session_id: 's3', payload: {} },
  ]
  const claimBodies = []
  const backend = {
    call: async (path, body) => {
      if (path.endsWith('/cloud/status')) return { sync_enabled: false, binding_count: 0 }
      if (path.endsWith('/sessions')) return { sessions: [], runtimes: { gui: true } }
      if (path.endsWith('/documents/session-index')) return { revision: 0, value: { version: 1, gui: { tabs: [] } } }
      if (path.endsWith('/claim')) {
        claimBodies.push(body)
        return { commands: claimBodies.length === 1 ? commands : [] }
      }
      if (path.endsWith('/settle')) { settled.push(body); return { ok: true } }
      if (path.endsWith('/publish')) {
        publishSnapshots++
        const exited = (body.sessions ?? []).filter(row => row.dto?.status === 'exited')
        if (exited.length) publishedExits.push(exited.map(row => row.session_id))
        return { sessions: (body.sessions ?? []).map((row, i) => ({ session_id: row.session_id, id: 100 + i })) }
      }
      return {}
    },
  }
  const bridge = new RuntimeBridge({ get: key => services[key] }, backend, { intervalMs: 500 })
  await bridge.publish()
  publishSnapshots = 0
  const outcome = await bridge.tick()
  assert.equal(outcome.hadCommands, true)
  assert.equal(claimBodies[0].wait_ms, 500)
  assert.ok(peakArchives >= 2, `expected parallel archive execution, peak=${peakArchives}`)
  assert.deepEqual(released.sort(), ['s1', 's2', 's3'])
  // All three archived sessions are published as exited in a single batched publish call.
  assert.equal(publishedExits.length, 1)
  assert.deepEqual(publishedExits[0].sort(), ['s1', 's2', 's3'])
  assert.equal(settled.length, 3)
  assert.ok(settled.every(entry => entry.result.value?.accepted === true))
  // Single publish pass (1 exited-batch publish + 1 empty heartbeat for 0 remaining items), not 3 per-command publishes.
  assert.equal(publishSnapshots, 2)
})

test('claimCommands falls back cleanly when an older backend rejects wait_ms', async () => {
  const calls = []
  const backend = {
    call: async (path, body) => {
      calls.push(body)
      if ('wait_ms' in body) throw new Error('kode backend (422): unknown field `wait_ms`')
      return { commands: [] }
    },
  }
  const bridge = new RuntimeBridge({ get: () => undefined }, backend, { intervalMs: 500 })
  assert.deepEqual(await bridge.claimCommands(), [])
  assert.equal(bridge.longPoll, false)
  assert.deepEqual(await bridge.claimCommands(), [])
  assert.equal(calls.length, 3)
  assert.equal(calls[0].wait_ms, 500)
  assert.equal('wait_ms' in calls[1], false)
  assert.equal('wait_ms' in calls[2], false)
})

test('tick preserves ordering across different command kinds and isolates batch failures', async () => {
  const log = [], settled = []
  const services = {
    sessionController: {
      list: async () => ({ items: [] }),
      cancel: async ({ sessionId }) => { log.push(`interrupt:${sessionId}`); return { ok: true } },
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      archiveSession: async id => {
        if (id === 'bad') throw new Error('archive failed')
        log.push(`delete:${id}`)
      },
    },
    kodeNativeFactory: { release: async () => {} },
  }
  const commands = [
    { id: 'c1', kind: 'delete', session_id: 's1', payload: {} },
    { id: 'c2', kind: 'delete', session_id: 'bad', payload: {} },
    { id: 'c3', kind: 'interrupt', session_id: 's2', payload: {} },
    { id: 'c4', kind: 'delete', session_id: 's3', payload: {} },
  ]
  const backend = {
    call: async (path, body) => {
      if (path.endsWith('/cloud/status')) return { sync_enabled: false, binding_count: 0 }
      if (path.endsWith('/sessions')) return { sessions: [], runtimes: { gui: true } }
      if (path.endsWith('/claim')) return { commands }
      if (path.endsWith('/settle')) { settled.push(body); return { ok: true } }
      if (path.endsWith('/publish')) return { sessions: [] }
      return {}
    },
  }
  const bridge = new RuntimeBridge({ get: key => services[key] }, backend, { intervalMs: 500 })
  await bridge.publish()
  await bridge.tick()
  assert.deepEqual(log, ['delete:s1', 'interrupt:s2', 'delete:s3'])
  const byId = new Map(settled.map(row => [row.id, row.result]))
  assert.equal(byId.get('c1').value.accepted, true)
  assert.equal(byId.get('c2').error, 'archive failed')
  assert.equal(byId.get('c3').value.ok, true)
  assert.equal(byId.get('c4').value.accepted, true)
})

test('tick executes consecutive import_session commands concurrently and publishes once before settling IDs', async () => {
  const settled = [], persisted = new Set()
  let activeImports = 0, peakImports = 0, publishCalls = 0, nextId = 500
  const agent = { selectModel() {}, session: { header: { cwd: '/srv/project' }, snapshotEvents: () => [], requestHeader: () => ({ config: { model: 'm' } }) }, ctx: { sessions: { flush: async () => {} } } }
  const bindings = {}
  const services = {
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [{ id: 'ws', path: '/srv/project', attachSession: async () => {} }],
      resolveByPath: async () => ({ id: 'ws', path: '/srv/project', attachSession: async () => {} }),
    },
    kodeAgents: {
      profiles: {
        list: () => [{ id: 'kode-codex', name: 'codex', type: 'codex', defaultModel: 'm' }],
        bindings,
        binding: id => bindings[id],
        bindNative: async (id, profileId, threadId) => { bindings[id] = { profile: { id: profileId, name: 'codex', type: 'codex' }, threadId } },
      },
      recordBinding() {},
    },
    kodeNativeFactory: {
      importHistory: async () => {
        activeImports++
        peakImports = Math.max(peakImports, activeImports)
        await new Promise(resolve => setTimeout(resolve, 25))
        activeImports--
      },
    },
    sessionController: {
      list: async () => ({ items: [...persisted].map(sessionId => ({ sessionId, cwd: '/srv/project', title: sessionId })) }),
      create: async req => { persisted.add(req.sessionId); return { sessionId: req.sessionId } },
      resolveAgent: async () => ({ agent }),
      rename: async () => {},
      inspect: async () => ({ events: [] }),
    },
    agents: { get: () => undefined },
  }
  const commands = [
    { id: 'imp-1', kind: 'import_session', payload: { backend_key: 'codex', session_id: 'thread-1', cwd: '/srv/project', title: 'One' } },
    { id: 'imp-2', kind: 'import_session', payload: { backend_key: 'codex', session_id: 'thread-2', cwd: '/srv/project', title: 'Two' } },
    { id: 'imp-3', kind: 'import_session', payload: { backend_key: 'codex', session_id: 'thread-3', cwd: '/srv/project', title: 'Three' } },
  ]
  let revision = 0, indexDoc = { version: 1, imports: {} }
  const backend = {
    call: async (path, body) => {
      if (path.endsWith('/cloud/status')) return { sync_enabled: false, binding_count: 0 }
      if (path.endsWith('/sessions')) return { sessions: [], runtimes: { gui: true } }
      if (path.endsWith('/transcript')) return { available: true, messages: [] }
      if (path.endsWith('/documents/session-index')) {
        if (body) { indexDoc = structuredClone(body.value); revision++ }
        return { revision, value: structuredClone(indexDoc) }
      }
      if (path.endsWith('/claim')) return { commands }
      if (path.endsWith('/settle')) { settled.push(body); return { ok: true } }
      if (path.endsWith('/publish')) {
        publishCalls++
        return { sessions: (body.sessions ?? []).map(row => ({ session_id: row.session_id, id: nextId++ })) }
      }
      return {}
    },
  }
  const bridge = new RuntimeBridge({ get: key => services[key] }, backend, { intervalMs: 500 })
  await bridge.publish()
  publishCalls = 0
  await bridge.tick()
  assert.ok(peakImports >= 2, `expected parallel import_session execution, peak=${peakImports}`)
  assert.equal(settled.length, 3)
  for (const row of settled) {
    assert.ok(Number.isSafeInteger(row.result.value?.id), `expected public id in settlement: ${JSON.stringify(row)}`)
    assert.ok(row.result.value?.runtime_session_id)
  }
  // 3 newly imported sessions published once each in the single batch publishSnapshot pass (not 3 full passes).
  assert.equal(publishCalls, 3)
})

test('bot_report command prompts the bot main session even when it is currently unloaded', async () => {
  const prompted = []
  const services = {
    sessionController: {
      prompt: async req => { prompted.push(req); return { accepted: true } },
    },
  }
  const bridge = new RuntimeBridge({ get: key => services[key] }, {})
  const result = await bridge.execute({
    id: 'report-1',
    kind: 'bot_report',
    payload: { session_id: 'bot-main-1', text: '关注「企微群」完成，请汇报给用户。' },
  })
  assert.deepEqual(result, { accepted: true })
  assert.equal(prompted.length, 1)
  assert.equal(prompted[0].sessionId, 'bot-main-1')
  assert.equal(prompted[0].content[0].text, '关注「企微群」完成，请汇报给用户。')
})
