import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { encodeHistoryArtifact } from '../src/native-history.js'
import { installSessionRecovery, recoveryLocation } from '../src/session-recovery.js'

const id = 'session-recovery-test'
const path = '/tmp/home/sessions/workspace/' + id + '/session.v4.jsonl.zstd'
const corrupt = (message = 'system/message requires a protected first surface head', file = path) =>
  Object.assign(new Error(message + ' (raw log: ' + file + ')'), { name: 'SessionPersistenceCorruptionError' })
const context = open => ({ sessionPersistence: { open }, logger: { warn() {} } })

test('recovery refuses unrelated failures, unsupported formats and mismatched artifact identities', () => {
  assert.equal(recoveryLocation(new Error('network failure'), id), undefined)
  assert.equal(recoveryLocation(corrupt('unsupported event'), id), undefined)
  assert.equal(recoveryLocation(corrupt(undefined, path.replace(id, 'other-session')), id), undefined)
  assert.equal(recoveryLocation(corrupt(undefined, path.replace('session.v4', 'session.v3')), id), undefined)
  assert.deepEqual(recoveryLocation(corrupt(), id), { path, home: '/tmp/home' })
})

test('concurrent history and resume opens share one repair and retain their access/options', async () => {
  let repaired = false, repairs = 0
  const calls = [], options = { signal: new AbortController().signal }
  const original = async (key, access, opts) => {
    calls.push({ key, access, opts })
    if (!repaired) throw corrupt()
    return access
  }
  const ctx = context(original)
  const release = installSessionRecovery(ctx, { repair: async () => {
    repairs++; await new Promise(resolve => setImmediate(resolve)); repaired = true
    return { applied: true, backup: '/backup' }
  } })
  try {
    assert.deepEqual(await Promise.all([ctx.sessionPersistence.open(id, 'read', options), ctx.sessionPersistence.open(id, 'write', options)]), ['read', 'write'])
    assert.equal(repairs, 1)
    assert.equal(calls.length, 4)
    assert.ok(calls.every(row => row.key === id && row.opts === options))
  } finally { release() }
  assert.equal(ctx.sessionPersistence.open, original)
})

test('failed or ineffective repairs preserve the error and never loop', async () => {
  for (const fails of [true, false]) {
    const original = corrupt(); let opens = 0, repairs = 0
    const ctx = context(async () => { opens++; throw original })
    const release = installSessionRecovery(ctx, { repair: async () => {
      repairs++; if (fails) throw new Error('writer locked'); return { applied: false }
    } })
    try { await assert.rejects(ctx.sessionPersistence.open(id, 'read'), error => error === original) }
    finally { release() }
    assert.equal(opens, fails ? 1 : 2)
    assert.equal(repairs, 1)
  }
})

test('released persistence automatically repairs on history load, then resumes the repaired artifact', { skip: !process.env.KODE_TEST_DSH_NODE_MODULES }, async () => {
  const Jsonl = await import(pathToFileURL(join(process.env.KODE_TEST_DSH_NODE_MODULES, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')))
  const home = await mkdtemp(join(tmpdir(), 'kode-auto-recovery-')), root = join(home, 'sessions')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(Jsonl, { root })
  let release
  try {
    const session = Session.create(id, [], { ...Session.create(id).header, cwd: '/tmp' })
    session.append('turn/start', { turn: 1 })
    session.append('request/header', { header: { config: { provider: 'kode-agent-test', model: 'test' } }, reason: 'initial' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this input' }] }, { surfaceOp: 'append' })
    appendPluginRecord(session, 'plugin:kode/native-event', { event: { method: 'turn/completed' } })
    session.append('system/message', { turn: 1, step: 1, message: { id: 'later', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Keep this prompt' }] } }, { surfaceOp: 'append' })
    const handle = await ctx.sessionPersistence.create(session.header)
    await handle.flush(); await handle.close()
    const artifact = join(root, '--tmp--', id, 'session.v4.jsonl.zstd')
    const original = encodeHistoryArtifact({ type: 'session', ...session.header }, session.snapshotEvents())
    await writeFile(artifact, original)
    await assert.rejects(ctx.sessionPersistence.open(id, 'read'), /protected first surface head/)
    const reports = []
    release = installSessionRecovery({ sessionPersistence: ctx.sessionPersistence, logger: { warn: (...args) => reports.push(args) } })
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      const stored = await reader.read()
      assert.equal(stored.events.length, session.snapshotEvents().length)
      assert.deepEqual(stored.events.find(event => event.type === 'plugin:kode/system-head-repair').data.originalEvent, session.snapshotEvents().find(event => event.type === 'system/message'))
      assert.deepEqual(stored.events.find(event => event.type === 'user/message').data, session.snapshotEvents().find(event => event.type === 'user/message').data)
    } finally { await reader.close() }
    assert.equal(reports.length, 1)
    assert.deepEqual(await readFile(join(reports[0][2], 'session.v4.jsonl.zstd')), original)
    const writer = await ctx.sessionPersistence.open(id, 'write')
    await writer.close()
    assert.equal(reports.length, 1)
  } finally { release?.(); await fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
