import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { buildHistorySeed } from '../src/native-history.js'
import { repairNativeSystemHeads } from '../src/repair-system-heads.js'

function fixture(provider = 'kode-agent-fixture') {
  const session = Session.create('native-system-head'), route = { provider, model: 'fixture' }
  const events = buildHistorySeed({ messages: [{ role: 'user', kind: 'text', text: 'Original user input' }, { role: 'assistant', kind: 'text', text: 'Original reply' }] }, route)
  const push = (type, data, surfaceOp) => events.push({ type, seq: events.length, time: 1, data, ...(surfaceOp ? { surfaceOp } : {}) })
  push('plugin:kode/native-event', { event: { method: 'turn/completed' } }); events.at(-1).ignorable = true
  push('turn/start', { turn: 2 }); push('step/start', { turn: 2, step: 1 })
  push('system/message', { turn: 2, step: 1, message: { id: 'misplaced-system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Harness prompt accidentally injected after native messages' }] } }, 'append')
  push('request/header', { header: { config: route }, reason: 'resume' })
  push('step/end', { turn: 2, step: 1 }); push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { header: { delegationDepth: 0, ...session.header }, events }
}
const validate = ({ header, events }) => {
  validateStoredEvents(header, structuredClone(events))
  restoreReleasedV4Artifact({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
  Session.create(header.id, events, header, 0)
}
test('misplaced native system head is preserved verbatim as optional evidence and restores with the released reader', () => {
  const { header, events } = fixture()
  assert.throws(() => validate({ header, events }), /protected first surface head/)
  const original = structuredClone(events), repaired = repairNativeSystemHeads(events)
  const index = events.findIndex(event => event.type === 'system/message')
  assert.deepEqual(repaired.events[index].data.originalEvent, events[index])
  assert.equal(repaired.events[index].ignorable, true)
  assert.equal(repaired.events[index].seq, events[index].seq)
  assert.deepEqual(repaired.events.filter((_, i) => i !== index), events.filter((_, i) => i !== index))
  assert.deepEqual(events, original)
  validate({ header, events: repaired.events })
  assert.deepEqual(repairNativeSystemHeads(repaired.events).changes, [])
})
test('ordinary system heads, foreign routes and unproven native histories are not rewritten', () => {
  const foreign = fixture('official-provider')
  assert.deepEqual(repairNativeSystemHeads(foreign.events).changes, [])
  const unproven = fixture().events.filter(event => event.type !== 'plugin:kode/native-event')
  assert.deepEqual(repairNativeSystemHeads(unproven).changes, [])
  const head = fixture().events.find(event => event.type === 'system/message')
  assert.deepEqual(repairNativeSystemHeads([head]).changes, [])
})

test('offline worker repairs misplaced native system heads with an exact backup and no message loss', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { encodeHistoryArtifact } = await import('../src/native-history.js')
  const { zstdDecompressSync } = await import('node:zlib')
  const root = await mkdtemp(join(tmpdir(), 'kode-native-system-head-'))
  try {
    const { header, events } = fixture(), directory = join(root, 'sessions', 'workspace', header.id)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'session.v4.jsonl.zstd'), original = encodeHistoryArtifact({ type: 'session', ...header }, events)
    await writeFile(path, original); await writeFile(join(directory, 'session.lock'), '')
    const modules = resolve(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session'))), '../../..')
    const args = [fileURLToPath(new URL('../scripts/repair-inbox-history.py', import.meta.url)), '--home', root, '--session-id', header.id, '--runtime-modules', modules, '--node', process.execPath, '--apply']
    const result = JSON.parse((await promisify(execFile)('python3', args)).stdout)
    assert.equal(result.applied, true)
    assert.deepEqual(await readFile(join(result.backup, 'session.v4.jsonl.zstd')), original)
    const [wire, ...repaired] = zstdDecompressSync(await readFile(path)).toString().trim().split('\n').map(JSON.parse)
    assert.equal(repaired.length, events.length)
    assert.deepEqual(repaired.find(e => e.type === 'plugin:kode/system-head-repair').data.originalEvent, events.find(e => e.type === 'system/message'))
    const storedHeader = { ...wire }; delete storedHeader.type
    validate({ header: storedHeader, events: repaired })
    assert.equal(JSON.parse((await promisify(execFile)('python3', args)).stdout).applied, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
