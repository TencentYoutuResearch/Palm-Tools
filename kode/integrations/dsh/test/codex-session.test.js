import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexSession } from '../src/codex-session.js'
const fixture = fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
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
    assert.deepEqual(records.filter(r => r.method === 'turn/start' && r.label === 'codex').map(r => r.params.input[0].text), ['TOOL first', 'followup', 'after restart'])
  } finally {
    if (previousToken === undefined) delete process.env.KODE_BRIDGE_TOKEN; else process.env.KODE_BRIDGE_TOKEN = previousToken
    await Promise.all([a.close(), b.close(), resumed?.close()]); await rm(root, { recursive: true, force: true })
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
