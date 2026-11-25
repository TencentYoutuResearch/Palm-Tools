import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CodexSession } from '../src/codex-session.js'
const fixture = fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
test('compaction waits for its native turn to finish before a followup is admitted', async () => {
  const session = new CodexSession({ executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_COMPACT_DELAY_MS: '75' } }, tmpdir())
  try {
    await session.open({}, [])
    const compacted = await collect(session.turn([], { command: { name: 'compact' } }))
    assert.equal(compacted.filter(event => event.method === 'turn/completed').length, 1)
    assert.equal(compacted.at(-1).params.turn.id, 'compact-1')
    const followup = await collect(session.turn([{ type: 'text', text: 'after compact' }]))
    assert.equal(followup.at(-1).params.turn.id, 'turn-2')
  } finally { await session.close() }
})
test('a completed compaction item does not hide a failed native turn', async () => {
  const session = new CodexSession({ executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_COMPACT_DELAY_MS: '25', KODE_FIXTURE_COMPACT_FAIL: '1' } }, tmpdir())
  try {
    await session.open({}, [])
    const events = []
    await assert.rejects(async () => { for await (const event of session.turn([], { command: { name: 'compact' } })) events.push(event) }, /compaction finalization failed/)
    assert.ok(!events.some(event => event.method === 'turn/completed' || event.params?.itemId === 'compact-result'))
    assert.equal(session.rpc.closed, true)
  } finally { await session.close() }
})
test('two Codex profiles run concurrently with independent environments, followups, dynamic tools and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-codex-runtime-')), log = join(root, 'rpc.jsonl')
  const previousToken = process.env.KODE_BRIDGE_TOKEN
  process.env.KODE_BRIDGE_TOKEN = 'host-only-fixture-token'
  const profile = label => ({ executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_AGENT_LABEL: label, KODE_FIXTURE_RPC_LOG: log } })
  let calls = 0
  const a = new CodexSession(profile('codex'), root, { tool: async () => { calls++; return { success: true, contentItems: [{ type: 'inputText', text: '[]' }] } } })
  const b = new CodexSession(profile('tcodex'), root)
  let resumed
  try {
    const [one, two] = await Promise.all([a.open({}, [{ name: 'kode_sessions_list', description: 'List sessions', parameters: { type: 'object' } }]), b.open({}, [])])
    assert.equal(one, two, 'same native ID in different processes must remain isolated')
    const [first, second] = await Promise.all([collect(a.turn([{ type: 'text', text: 'TOOL first' }])), collect(b.turn([{ type: 'text', text: 'second' }]))])
    assert.equal(calls, 1)
    assert.equal(first.find(e => e.method === 'item/agentMessage/delta').params.delta, 'codex: TOOL first')
    assert.equal(second.find(e => e.method === 'item/agentMessage/delta').params.delta, 'tcodex: second')
    const followup = await collect(a.turn([{ type: 'text', text: 'followup' }]))
    assert.equal(followup.at(-1).params.turn.id, 'turn-2')
    await a.close()
    resumed = new CodexSession(profile('codex'), root)
    await resumed.open({ threadId: one }, [])
    await collect(resumed.turn([{ type: 'text', text: 'after restart' }]))
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(records.every(r => r.hostCredentialPresent === false), 'Host admin credentials and native parent IDs must not reach CLI children')
    assert.equal(records.filter(r => r.method === 'thread/start').length, 2)
    assert.equal(records.find(r => r.method === 'thread/resume').params.threadId, one)
    assert.equal(records.find(r => r.method === 'thread/resume').params.excludeTurns, true)
    assert.deepEqual(records.filter(r => r.method === 'turn/start' && r.label === 'codex').map(r => r.params.input[0].text), ['TOOL first', 'followup', 'after restart'])
  } finally {
    if (previousToken === undefined) delete process.env.KODE_BRIDGE_TOKEN; else process.env.KODE_BRIDGE_TOKEN = previousToken
    await Promise.all([a.close(), b.close(), resumed?.close()]); await rm(root, { recursive: true, force: true })
  }
})
test('resumed Codex receives updated communication tools when only a parameter changed', async () => {
  const profile = { executable: process.execPath, args: [fixture] }
  const name = 'kode_sessions_send'
  const oldTool = { name, description: 'Send a session message', parameters: { type: 'object', properties: { content: { type: 'string' } } } }
  const newTool = { ...oldTool, parameters: { ...oldTool.parameters, properties: { ...oldTool.parameters.properties, title: { type: 'string' } } } }
  const original = new CodexSession(profile, tmpdir())
  const unchanged = new CodexSession(profile, tmpdir())
  const legacy = new CodexSession(profile, tmpdir())
  const calls = []
  const resumed = new CodexSession(profile, tmpdir(), { tool: async (request, signal) => {
    signal.throwIfAborted()
    calls.push(request)
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ message: request.arguments }) }] }
  } })
  const client = new Client({ name: 'resumed-codex-test', version: '1' })
  try {
    const threadId = await original.open({}, [oldTool])
    const binding = { threadId, nativeToolNames: [name], nativeToolSchema: original.nativeToolSchema }
    await original.close()
    await unchanged.open(binding, [oldTool])
    assert.equal(unchanged.proxy, undefined)
    await legacy.open({ threadId, nativeToolNames: [name] }, [newTool])
    assert.ok(legacy.proxy, 'a legacy binding with names alone must get the current tool')

    assert.equal(await resumed.open(binding, [newTool]), threadId)
    const token = await readFile(resumed.proxy.tokenFile, 'utf8')
    await client.connect(new StreamableHTTPClientTransport(new URL(resumed.proxy.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }))
    const tool = (await client.listTools()).tools.find(row => row.name === name)
    assert.equal(tool.inputSchema.properties.title.type, 'string')
    resumed.active = { turnId: 'fixture-turn', signal: AbortSignal.timeout(5000) }
    const result = await client.callTool({ name, arguments: { title: 'Review result', content: 'Reviewed the fixtures' } })
    assert.equal(result.isError, false)
    assert.equal(JSON.parse(result.content[0].text).message.title, 'Review result')
    assert.deepEqual(calls.map(({ threadId, turnId, tool }) => ({ threadId, turnId, tool })), [{ threadId, turnId: 'fixture-turn', tool: name }])
  } finally {
    resumed.active = undefined
    await client.close()
    await Promise.all([original.close(), unchanged.close(), legacy.close(), resumed.close()])
  }
})
test('cancellation closes the native process before another turn can execute', async () => {
  const session = new CodexSession({ executable: process.execPath, args: [fixture] }, tmpdir())
  const stop = new AbortController()
  try {
    await session.open({}, [])
    const task = collect(session.turn([{ type: 'text', text: 'WAIT' }], { signal: stop.signal }))
    const timer = setTimeout(() => stop.abort(new Error('stop requested')), 50)
    await assert.rejects(task, /stop requested/)
    clearTimeout(timer)
    assert.equal(session.rpc.closed, true)
  } finally { await session.close() }
})
test('Codex receives the session workspace and current sandbox/approval policy on every turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-codex-policy-')), log = join(root, 'wire.jsonl')
  let mode = 'read-only', approval = 'ask'
  const session = new CodexSession({ executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_RPC_LOG: log } }, root, {
    policy: () => ({ mode, workspaceRoot: root }), approvalPolicy: () => approval,
  })
  try {
    await session.open({}, [])
    await collect(session.turn([{ type: 'text', text: 'Read only' }]))
    mode = 'workspace-write'
    await collect(session.turn([{ type: 'text', text: 'Workspace only' }]))
    mode = 'danger-full-access'; approval = 'never'
    await collect(session.turn([{ type: 'text', text: 'Explicit full access' }]))
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    const turns = records.filter(r => r.method === 'turn/start').map(r => r.params)
    assert.ok(turns.every(p => p.cwd === root))
    assert.deepEqual(turns.map(p => p.sandboxPolicy), [{ type: 'readOnly' }, { type: 'workspaceWrite', writableRoots: [root] }, { type: 'dangerFullAccess' }])
    assert.deepEqual(turns.map(p => p.approvalPolicy), ['on-request', 'on-request', 'never'])
    assert.equal(records.find(r => r.method === 'thread/start').params.cwd, root)
  } finally { await session.close(); await rm(root, { recursive: true, force: true }) }
})
test('an unavailable configured executable fails without hanging process cleanup', async () => {
  const session = new CodexSession({ executable: '/fixtures/missing-agent-executable' }, tmpdir())
  try { await assert.rejects(session.open({}, [], AbortSignal.timeout(1000)), /ENOENT/) }
  finally { await session.close() }
})

test('continuing an archived Codex binding restores the same thread and resumes with its original settings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-codex-unarchive-')),log=join(root,'rpc.jsonl'),threadId='01a18080-9adf-7920-906f-6bbbc7f2d971'
 const session=new CodexSession({executable:process.execPath,args:[fixture],env:{KODE_FIXTURE_ARCHIVED_THREAD:'1',KODE_FIXTURE_RPC_LOG:log}},root)
 try{
  assert.equal(await session.open({threadId},[]),threadId)
  await collect(session.turn([{type:'text',text:'continue original conversation'}]))
  const records=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
  const restore=records.filter(row=>['thread/resume','thread/unarchive','thread/start'].includes(row.method))
  assert.deepEqual(restore.map(row=>row.method),['thread/resume','thread/unarchive','thread/resume'])
  assert.ok(restore.every(row=>row.params.threadId===threadId))
  assert.deepEqual(restore[0].params,restore[2].params)
  assert.equal(restore[0].params.excludeTurns,true)
  assert.equal(records.find(row=>row.method==='turn/start').params.threadId,threadId)
 }finally{await session.close();await rm(root,{recursive:true,force:true})}
})

test('Codex Fast applies a per-turn service tier without changing thread or global settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-codex-fast-')), log = join(root, 'wire.jsonl')
  const session = new CodexSession({ executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_RPC_LOG: log } }, root)
  try {
    await session.open({}, [])
    await collect(session.turn([{ type: 'text', text: 'fast on' }], { serviceTier: 'fast' }))
    await collect(session.turn([{ type: 'text', text: 'fast off' }], { serviceTier: 'default' }))
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(records.filter(row => row.method === 'turn/start').map(row => row.params.serviceTierForTurn), ['fast', 'default'])
    assert.ok(records.filter(row => row.method === 'thread/start').every(row => !('serviceTier' in row.params)))
  } finally { await session.close(); await rm(root, { recursive: true, force: true }) }
})
test('unrelated resume errors never restore other threads or create a replacement conversation',async()=>{
 const threadId='01a18080-9adf-7920-906f-6bbbc7f2d971'
 for(const message of ['permission denied','session 00000000-0000-0000-0000-000000000000 is archived']){
  const session=new CodexSession({},tmpdir()),calls=[]
  session.rpc={request:async(method)=>{calls.push(method);throw Object.assign(new Error(message),{rpcRejected:true})}}
  await assert.rejects(session.resumeThread({threadId}),error=>error.message===message)
  assert.deepEqual(calls,['thread/resume'])
 }
})


test('long-thread resume excludes native history larger than the transport frame cap and continues the original thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-long-resume-')), log = join(root, 'rpc.jsonl')
  const threadId = 'fixture-long-thread'
  const profile = { executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_LARGE_RESUME: '1', KODE_FIXTURE_RPC_LOG: log } }
  const session = new CodexSession(profile, root)
  try {
    assert.equal(await session.open({ threadId }, []), threadId)
    const events = await collect(session.turn([{ type: 'text', text: 'Continue without replaying old history' }]))
    assert.equal(events.at(-1).method, 'turn/completed')
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(records.filter(row => row.method === 'thread/start').length, 0)
    assert.equal(records.find(row => row.method === 'thread/resume').params.excludeTurns, true)
    assert.equal(records.find(row => row.method === 'turn/start').params.threadId, threadId)
  } finally { await session.close(); await rm(root, { recursive: true, force: true }) }
})

test('Codex child execution state and output follow known native threads', async () => {
  const children = []
  const session = new CodexSession({ executable: process.execPath, args: [fixture] }, tmpdir(), { subagent: child => children.push(child) })
  try {
    await session.open({}, [])
    const events = await collect(session.turn([{ type: 'text', text: 'NATIVE_SUBAGENTS' }]))
    assert.ok(children.some(child => child.id === 'codex-child' && child.status === 'running'))
    assert.ok(children.some(child => child.id === 'codex-child' && child.delta === 'Child live output'))
    assert.ok(children.some(child => child.id === 'codex-child' && child.status === 'completed'))
    assert.ok(children.every(child => child.id !== 'foreign-child'))
    assert.doesNotMatch(events.filter(event => event.method === 'item/agentMessage/delta').map(event => event.params.delta).join(''), /Child live output|Foreign output/)
  } finally { await session.close() }
})

test('Codex lists desktop and CLI threads across workspaces and pages through its archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-codex-directory-')), log = join(root, 'requests.jsonl')
  const session = new CodexSession({ executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_RPC_LOG: log } }, root)
  try {
    const signal = AbortSignal.timeout(5000)
    const first = await session.listSessions(null, signal)
    const next = await session.listSessions(first.nextCursor, signal)
    const final = await session.listSessions(next.nextCursor, signal)
    assert.deepEqual(first.sessions, [{ sessionId: 'desktop-thread', title: 'Native title', cwd: '/srv/project', updatedAt: 1767225600 }])
    assert.equal(next.sessions[0].sessionId, 'older-thread')
    assert.equal(final.sessions[0].sessionId, 'archived-thread')
    assert.equal(final.nextCursor, null)
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    const listing = records.filter(row => row.method === 'thread/list')
    assert.deepEqual(listing.map(row => [row.params.cursor, row.params.archived]), [[undefined, false], ['next-page', false], [undefined, true]])
    assert.ok(listing.every(row => row.params.sourceKinds.includes('vscode') && row.params.cwd === undefined))
    assert.ok(!records.some(row => ['thread/start', 'thread/resume', 'thread/unarchive'].includes(row.method)))
  } finally { await session.close(); await rm(root, { recursive: true, force: true }) }
})
