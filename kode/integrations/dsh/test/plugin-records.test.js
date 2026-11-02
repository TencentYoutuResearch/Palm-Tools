import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { zstdDecompressSync } from 'node:zlib'
import { appendFastPreference, fastProjection } from '../src/model-fast.js'
import { repairPluginRecordEnvelopes } from '../src/repair-plugin-records.js'
import { encodeHistoryArtifact } from '../src/native-history.js'
const route = { provider: 'kode-agent-fixture', model: 'fixture-model' }
const validate = (header, events) => { validateStoredEvents(header, structuredClone(events)); assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES) }
test('Fast preferences survive the released V4 disk reader and retain their plugin projection', () => {
  const session = Session.create('plugin-roundtrip')
  appendFastPreference(session, route, true, 'priority')
  appendFastPreference(session, route, false)
  const events = session.snapshotEvents()
  assert.ok(events.every(event => event.ignorable === true))
  const [wire, ...restored] = zstdDecompressSync(encodeHistoryArtifact({ type: 'session', ...session.header }, events)).toString().trim().split('\n').map(JSON.parse)
  const header = { ...wire }; delete header.type
  validate(header, restored)
  const reopened = Session.create(session.id, restored, header, 0)
  const projection = reopened.snapshotEvents().reduce(fastProjection.apply, fastProjection.init())
  assert.deepEqual(projection.preferences, [{ ...route, fast: false }])
})
test('legacy envelope repair fixes the exact reader rejection without rewriting history or hiding unknown events', () => {
  const session = Session.create('legacy-plugin-record')
  session.append('plugin:kode/model-fast', { ...route, fast: true })
  session.append('plugin:kode/shared-interaction', { id: 'request', kind: 'ask_user_question', payload: { question: 'Fixture?' }, state: 'closed' })
  const events = session.snapshotEvents()
  assert.throws(() => validate(session.header, events), /unknown|ignorable/)
  const repaired = repairPluginRecordEnvelopes(events)
  assert.equal(repaired.changes.length, 2)
  assert.deepEqual(repaired.events.map(({ ignorable, ...event }) => event), events.map(({ ignorable, ...event }) => event))
  validate(session.header, repaired.events)
  assert.deepEqual(repairPluginRecordEnvelopes(repaired.events).changes, [])
  const foreign = { ...events[0], type: 'plugin:foreign/required-state' }
  assert.equal(repairPluginRecordEnvelopes([foreign]).events[0], foreign)
  assert.throws(() => validate(session.header, [foreign]), /unknown|ignorable/)
})

test('offline migration backs up the exact artifact, clears its projection cache, and is idempotent', { skip: process.platform === 'win32' }, async () => {
  const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const root = await mkdtemp(join(tmpdir(), 'kode-plugin-migration-'))
  try {
    const id = 'session-migration', session = Session.create(id)
    session.append('plugin:kode/model-fast', { ...route, fast: true })
    const directory = join(root, 'sessions/fixture', id), cache = join(root, 'storages/session_projcache/sessions')
    await mkdir(directory, { recursive: true }); await mkdir(cache, { recursive: true })
    const path = join(directory, 'session.v4.jsonl.zstd'), original = encodeHistoryArtifact({ type: 'session', ...session.header }, session.snapshotEvents())
    await writeFile(path, original); await writeFile(join(directory, 'session.lock'), ''); await writeFile(join(cache, id + '.json'), 'old-cache')
    const worker = fileURLToPath(new URL('../scripts/repair-plugin-records.py', import.meta.url))
    const modules = process.env.KODE_TEST_DSH_NODE_MODULES ?? fileURLToPath(new URL('../node_modules', import.meta.url))
    const args = [worker, '--home', root, '--session-id', id, '--runtime-modules', modules, '--node', process.execPath]
    const run = async extra => JSON.parse((await promisify(execFile)('python3', [...args, ...extra])).stdout)
    assert.equal((await run([])).applied, false); assert.deepEqual(await readFile(path), original)
    const repaired = await run(['--apply'])
    assert.equal(repaired.applied, true)
    assert.deepEqual(await readFile(join(repaired.backup, 'session.v4.jsonl.zstd')), original)
    assert.equal(await readFile(join(repaired.backup, 'projection-cache.json'), 'utf8'), 'old-cache')
    assert.deepEqual(await readdir(cache), [])
    assert.equal((await run(['--apply'])).applied, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
