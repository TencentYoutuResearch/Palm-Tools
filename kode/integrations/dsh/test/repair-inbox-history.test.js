import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { Session } from '@deepseek-ai/dsh-session'
import { encodeHistoryArtifact } from '../src/native-history.js'
const run = promisify(execFile)
test('maintenance repairs under writer lock, backs up log/cache, preserves input and is idempotent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-inbox-maintenance-')), id = 'session-inbox-fixture'
  const directory = join(home, 'sessions', 'workspace', id), path = join(directory, 'session.v4.jsonl.zstd')
  const cache = join(home, 'storages/session_projcache/sessions', id + '.json')
  const session = Session.create(id), input = { id: 'pending', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original input' }] }
  const events = ['next-turn', 'next-step'].map((target, seq) => ({ type: 'agent/inbox/spliced', seq, time: seq, data: { target, start: 0, removedCount: 0, inserted: [input] } }))
  events.push({ type: 'plugin:kode/model-fast', seq: events.length, time: 2, data: { provider: 'fixture', model: 'fixture', fast: true } })
  const original = encodeHistoryArtifact({ type: 'session', ...session.header }, events)
  const modules = resolve(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session'))), '../../..')
  const args = [fileURLToPath(new URL('../scripts/repair-inbox-history.py', import.meta.url)), '--home', home, '--session-id', id, '--runtime-modules', modules, '--node', process.execPath]
  let holder
  try {
    await mkdir(directory, { recursive: true }); await mkdir(dirname(cache), { recursive: true })
    await writeFile(path, original); await writeFile(join(directory, 'session.lock'), '')
    await writeFile(cache, '{"stale":true}')
    const preview = JSON.parse((await run('python3', args)).stdout)
    assert.equal(preview.applied, false)
    assert.deepEqual(await readFile(path), original)
    holder = spawn('python3', ['-u', '-c', 'import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("locked",flush=True); sys.stdin.read()', join(directory, 'session.lock')], { stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject) })
    await assert.rejects(run('python3', [...args, '--apply']), /BlockingIOError/)
    const unlocked = new Promise(resolve => holder.once('exit', resolve)); holder.stdin.end(); await unlocked; holder = undefined
    const report = JSON.parse((await run('python3', [...args, '--apply'])).stdout)
    assert.equal(report.applied, true)
    assert.deepEqual(await readFile(join(report.backup, 'session.v4.jsonl.zstd')), original)
    assert.equal(await readFile(join(report.backup, 'projection-cache.json'), 'utf8'), '{"stale":true}')
    await assert.rejects(readFile(cache), { code: 'ENOENT' })
    const again = JSON.parse((await run('python3', [...args, '--apply'])).stdout)
    assert.equal(again.applied, false); assert.deepEqual(again.changes, [])
  } finally { holder?.stdin.end(); await rm(home, { recursive: true, force: true }) }
})
