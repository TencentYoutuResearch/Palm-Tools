/** Real native driver + official JSONL backend, with process death between stages. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

for (const compression of ['none', 'zstd']) test(`native identity, queued input and cancellation survive Host SIGKILL with official ${compression} JSONL storage`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-native-persistence-'))
  let child
  const response = (type, action) => new Promise((resolve, reject) => {
    const current = child, timer = setTimeout(() => finish(new Error(`Fixture timed out: ${type}`)), 8000)
    const message = value => { if (value.type === 'error') finish(new Error(value.message)); else if (value.type === type) finish(null, value) }
    const exited = () => finish(new Error('Fixture exited before response'))
    function finish(error, value) { clearTimeout(timer); current.off('message', message); current.off('exit', exited); error ? reject(error) : resolve(value) }
    current.on('message', message); current.once('exit', exited); action?.()
  })
  const start = async mode => {
    child = fork(fileURLToPath(new URL('./fixture-native-persistence.js', import.meta.url)), [root, mode, compression], { execPath: process.env.KODE_TEST_HOST_NODE ?? process.execPath, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    return (await response('ready')).snapshot
  }
  const kill = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  }
  try {
    const first = await start('create')
    assert.deepEqual(first, { id: 'durable-worker', cwd: root, queued: ['queued-original'], consumed: 0 })
    await kill()
    assert.deepEqual(await start('resume'), first)
    const cancelled = await response('cancelled', () => child.send('cancel'))
    assert.deepEqual(cancelled.result, { state: 'queued_removed' })
    assert.deepEqual(cancelled.snapshot.queued, [])
    await kill()
    assert.deepEqual(await start('resume'), { ...first, queued: [] })
    const repeated = await response('cancelled', () => child.send('cancel'))
    assert.deepEqual(repeated.result, { state: 'queued_removed' })
    assert.equal(repeated.snapshot.consumed, 0)
  } finally { await kill(); await rm(root, { recursive: true, force: true }) }
})
