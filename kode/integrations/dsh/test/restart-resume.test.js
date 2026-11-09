import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interruptedByRestart, RestartResume } from '../src/restart-resume.js'
const start = { seq: 1, type: 'turn/start' }
const end = reason => ({ seq: 3, type: 'turn/end', data: { reason } })
test('only unfinished and disposal-aborted turns qualify; stop, completion and errors do not', () => {
  assert.equal(interruptedByRestart([]), false)
  assert.equal(interruptedByRestart([start]), true)
  assert.equal(interruptedByRestart([start, end({ kind: 'aborted', reason: { kind: 'disposed' } })]), true)
  for (const reason of [{ kind: 'completed' }, { kind: 'error' }, { kind: 'interrupted' }, { kind: 'aborted', reason: { kind: 'user' } }]) assert.equal(interruptedByRestart([start, end(reason)]), false)
  assert.equal(interruptedByRestart([start, { seq: 2, type: 'plugin:kode/manual-stop' }]), false)
})
test('durable restart intent resumes eligible sessions once, preserving already queued work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-restart-'))
  try {
    const calls = [], queued = [], disposed = [], warnings = []
    const events = { running: [start], stopped: [start, end({ kind: 'aborted', reason: { kind: 'user' } })], complete: [start, end({ kind: 'completed' })], archived: [start], pending: [start], live: [start] }
    const ctx = { agents: { get: id => id === 'live' ? { status: 'running' } : undefined }, sessionController: { async resolveAgent(id) {
      calls.push(id)
      return { agent: { status: 'idle', inbox: { nextTurn: id === 'pending' ? [{}] : [], nextStep: [] }, followup: input => queued.push({ id, input }), session: {}, ctx: { parallel: async () => {} } } }
    } }, sessionQuery: { async observeSession(id) { return { events: events[id], [Symbol.dispose]: () => disposed.push(id) } } }, workspaceRegistry: { archivedSessionIds: ['archived'] }, logger: { warn: (...args) => warnings.push(args) } }
    const backend = { call: async () => ({ auto_resume_interrupted: true }) }, file = join(root, 'restart.json')
    const initial = new RestartResume(ctx, backend, file); await initial.load()
    for (const id of Object.keys(events)) await initial.status({ id, status: 'running' })
    const restored = new RestartResume(ctx, backend, file); await restored.load(); await restored.recover(new AbortController().signal)
    assert.deepEqual(calls, ['running', 'pending']); assert.deepEqual(queued.map(row => row.id), ['running']); assert.match(queued[0].input.content[0].text, /重启/)
    assert.ok(disposed.includes('stopped')); assert.equal(warnings.length, 0)
    const disabled = new RestartResume(ctx, { call: async () => ({ auto_resume_interrupted: false }) }, file)
    await disabled.load(); await disabled.recover(new AbortController().signal)
    assert.equal(calls.length, 2); assert.deepEqual(disabled.records, {})
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('idle completion clears intent, teardown preserves intent', async () => {
  const service = new RestartResume({}, {}, ''); service.persist = async () => {}
  await service.status({ id: 'a', status: 'running' }); assert.equal(service.records.a, true)
  await service.status({ id: 'a', status: 'idle', session: { snapshotEvents: () => [start, end({ kind: 'aborted', reason: { kind: 'disposed' } })] } }); assert.equal(service.records.a, true)
  await service.status({ id: 'a', status: 'idle', session: { snapshotEvents: () => [start, end({ kind: 'completed' })] } }); assert.equal(service.records.a, undefined)
})


test('an already materialized idle tab is continued instead of skipped', async () => {
  const queued = [], live = { id: 'loaded', status: 'idle', session: { snapshotEvents: () => [start, end({ kind: 'aborted', reason: { kind: 'disposed' } })] }, inbox: { nextTurn: [], nextStep: [] }, followup: input => queued.push(input), ctx: { parallel: async () => {} } }
  const service = new RestartResume({ agents: { get: () => live }, sessionController: { inspect: async () => { throw new Error('must not cold-open a loaded session') }, resolveAgent: async () => { throw new Error('must reuse loaded Agent') } } }, { call: async () => ({ auto_resume_interrupted: true }) }, '')
  service.previous = new Set(['loaded']); service.records.loaded = true; service.persist = async () => {}
  await service.recover(new AbortController().signal)
  assert.equal(queued.length, 1)
})
test('first upgrade boot discovers recent restart evidence but excludes completed and stale history', async () => {
  const queued = [], now = Date.now()
  const rows = { interrupted: [start, { ...end({ kind: 'aborted', reason: { kind: 'disposed' } }), time: now - 1000 }], completed: [start, { ...end({ kind: 'completed' }), time: now - 1000 }], stale: [start, { ...end({ kind: 'aborted', reason: { kind: 'disposed' } }), time: now - 3600000 }] }
  const service = new RestartResume({ agents: { get: () => undefined }, sessionController: { list: async () => ({ items: Object.keys(rows).map(sessionId => ({ sessionId })) }), inspect: async id => ({ events: rows[id] }), resolveAgent: async id => ({ agent: { status: 'idle', inbox: { nextTurn: [], nextStep: [] }, followup: () => queued.push(id), session: {}, ctx: { parallel: async () => {} } } }) }, logger: { warn: () => {} } }, { call: async () => ({ auto_resume_interrupted: true }) }, '')
  service.previous = new Set(); service.needsBootstrap = true; service.persist = async () => {}
  await service.recover(new AbortController().signal)
  assert.deepEqual(queued, ['interrupted'])
})
test('factory repaired crash boundaries retain restart evidence without treating manual interruption as restart', () => {
  const closed = { ...end({ kind: 'interrupted' }), seq: 2 }
  assert.equal(interruptedByRestart([start, closed]), false)
  assert.equal(interruptedByRestart([start, closed, { seq: 3, type: 'plugin:kode/restart-interrupted', data: { startSeq: 1 } }]), true)
})


test('a protected routing failure is rediscovered after an earlier journal dropped its intent', async () => {
  const queued = []
  const failed = [start, end({ kind: 'error', error: { message: 'Kode 原生 Agent 会话被普通 dsh 执行器接管，已在写入系统提示前停止。' } })]
  const rows = { protected: failed, ordinary: [start, end({ kind: 'error', error: { message: 'network failed' } })], stopped: [...failed, { seq: 4, type: 'plugin:kode/manual-stop' }] }
  const service = new RestartResume({ agents: { get: () => undefined }, sessionController: {
    list: async () => ({ items: Object.keys(rows).map(sessionId => ({ sessionId })) }),
    inspect: async id => ({ events: rows[id] }),
    resolveAgent: async id => ({ agent: { isKodeNativeAgent: true, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, followup: () => queued.push(id), session: {}, ctx: { parallel: async () => {} } } }),
  }, logger: { warn: () => {} } }, { call: async () => ({ auto_resume_interrupted: true }) }, '')
  service.previous = new Set(); service.persist = async () => {}
  await service.recover(new AbortController().signal)
  assert.deepEqual(queued, ['protected'])
})
