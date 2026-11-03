import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpSession } from '../src/acp-session.js'
const fixture = fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
for (const type of ['claude', 'cursor', 'codebuddy']) for (const extension of [true, false]) test(`${type} steering via ${extension ? 'extension' : 'cancel and continue'} retains the native session`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-acp-steer-')), log = join(root, 'wire.jsonl')
  // Launch the real ACP transport fixture; Claude's production launcher is tested separately.
  const session = new AcpSession({ type: 'custom', executable: process.execPath, args: [fixture], env: { KODE_ACP_FIXTURE_LOG: log, KODE_ACP_STEERING: extension ? '1' : '0', KODE_ACP_PROMPT_LOG_DELAY: '30' } }, root)
  try {
    await session.open({}, [])
    session.profile.type = type
    const task = collect(session.turn([{ type: 'text', text: 'WAIT' }]))
    for (let i = 0; i < 100 && !session.canSteer(); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(session.canSteer())
    const result = await session.steer([{ type: 'text', text: 'Use the new requirement' }])
    assert.ok(result.turnId)
    const events = await task
    assert.ok(events.some(event => event.method === 'item/agentMessage/delta' && event.params.delta.includes('new requirement')))
    assert.equal(session.rpc.closed, false)
    const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.method === 'session/new').length, 1)
    assert.equal(rows.filter(row => row.method === 'session/prompt').length, extension ? 1 : 2)
    assert.equal(rows.filter(row => row.method === 'session/cancel').length, extension ? 0 : 1)
    if (extension) assert.equal(rows.find(row => row.method === '_session/steering').params._meta.steering.idleBehavior, 'promptRequired')
    await collect(session.turn([{ type: 'text', text: 'Followup' }]))
  } finally { await session.close(); await rm(root, { recursive: true, force: true }) }
})
test('ACP native steering idle race rejects without consuming input or starting a detached turn', async () => {
  const session = new AcpSession({ type: 'claude' }, '/tmp')
  session.info = { _meta: { steering: { supported: true } }, agentCapabilities: {} }
  session.active = { ready: true, turnId: 'turn', done: false }
  session.request = async () => ({ outcome: 'promptRequired', reason: 'noRunningTurn' })
  await assert.rejects(session.steer([{ type: 'text', text: 'Keep queued' }]), error => error.rpcRejected === true)
  assert.equal(session.active.done, false)
})
for (const code of [-32601, -32602]) test(`ACP steering protocol rejection ${code} preserves retry eligibility`, async () => {
  const session = new AcpSession({ type: 'claude' }, '/tmp')
  session.info = { _meta: { steering: { supported: true } }, agentCapabilities: {} }
  session.active = { ready: true, turnId: 'turn', done: false }
  session.request = async () => { throw Object.assign(new Error('Rejected'), { code }) }
  await assert.rejects(session.steer([{ type: 'text', text: 'Keep queued' }]), error => error.rpcRejected === true)
  assert.equal(session.canSteer(), true)
})
test('unsupported steering images reject before cancelling the running ACP prompt', async () => {
  const session = new AcpSession({ type: 'cursor' }, '/tmp')
  session.info = { agentCapabilities: {} }
  session.active = { ready: true, turnId: 'turn', done: false }
  session.connection = { agent: { notify() { assert.fail('Image validation must precede cancellation') } } }
  await assert.rejects(session.steer([{ type: 'image', mimeType: 'image/png', data: 'test' }]), error => error.rpcRejected === true)
})
test('cancellation during ACP restart ends the stream without sending the replacement prompt', async () => {
  const session = new AcpSession({ type: 'codebuddy' }, '/tmp'), controller = new AbortController()
  let ended
  session.info = { agentCapabilities: {} }
  session.active = { ready: true, turnId: 'turn', done: false, signal: controller.signal, promptAbort: new AbortController(), promptTask: Promise.resolve({ stopReason: 'cancelled' }), end: error => { ended = error } }
  session.connection = { agent: { async notify() { controller.abort(new Error('User cancelled')) } } }
  session.request = async () => assert.fail('Cancelled replacement must not be sent')
  await assert.rejects(session.steer([{ type: 'text', text: 'New task' }]), /User cancelled/)
  assert.match(ended.message, /User cancelled/)
  assert.equal(session.active.restarting, false)
})
