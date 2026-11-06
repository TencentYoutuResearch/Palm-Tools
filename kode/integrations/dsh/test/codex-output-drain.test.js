import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { observeCodexOutputDrain } from '../src/codex-output-drain.js'
import { RpcProcess } from '../src/rpc-process.js'

const listenerCounts = stream => ['end', 'error', 'close'].map(name => stream.listenerCount(name))

test('native output drain observes an already consumed stdout without listeners', async () => {
  const stream = new PassThrough()
  stream.resume()
  stream.end()
  await once(stream, 'end')
  const before = listenerCounts(stream)
  const drain = observeCodexOutputDrain(stream)
  assert.deepEqual(await drain.wait(), { drained: true, reason: 'stdout_ended' })
  drain.dispose()
  assert.deepEqual(listenerCounts(stream), before)
})

test('native output drain requires consumed end and releases every observer', async () => {
  const stream = new PassThrough()
  stream.resume()
  const before = listenerCounts(stream)
  const drain = observeCodexOutputDrain(stream)
  stream.end('last owned protocol bytes')
  assert.deepEqual(await drain.wait(), { drained: true, reason: 'stdout_ended' })
  assert.equal(stream.readableEnded, true)
  assert.deepEqual(listenerCounts(stream), before)
})

test('native output drain rejects stdout destroyed before consumption', async () => {
  const stream = new PassThrough()
  const before = listenerCounts(stream)
  const drain = observeCodexOutputDrain(stream)
  stream.destroy()
  assert.deepEqual(await drain.wait(), { drained: false, reason: 'stdout_closed_before_end' })
  assert.deepEqual(listenerCounts(stream), before)
})

test('native output drain rejects pipe errors without persisting arbitrary text', async () => {
  const stream = new PassThrough()
  const before = listenerCounts(stream)
  const drain = observeCodexOutputDrain(stream)
  stream.destroy(new Error('fixture private diagnostic'))
  assert.deepEqual(await drain.wait(), { drained: false, reason: 'stdout_error' })
  assert.deepEqual(listenerCounts(stream), before)
})

test('native output drain has one bounded deadline and removes timed-out listeners', async () => {
  const stream = new PassThrough()
  const before = listenerCounts(stream)
  const drain = observeCodexOutputDrain(stream, { timeoutMs: 15 })
  assert.equal(drain.wait(), drain.wait())
  assert.deepEqual(await drain.wait(), { drained: false, reason: 'drain_timeout' })
  assert.deepEqual(listenerCounts(stream), before)
  stream.resume()
  stream.end()
  assert.deepEqual(await drain.wait(), { drained: false, reason: 'drain_timeout' })
})

test('native output drain supports explicit cleanup and missing stdout', async () => {
  const stream = new PassThrough()
  const before = listenerCounts(stream)
  const drain = observeCodexOutputDrain(stream)
  drain.dispose()
  drain.dispose()
  assert.deepEqual(await drain.wait(), { drained: false, reason: 'observer_disposed' })
  assert.deepEqual(listenerCounts(stream), before)
  assert.deepEqual(await observeCodexOutputDrain(undefined).wait(), { drained: false, reason: 'stdout_missing' })
})

test('native output drain rejects an unbounded or invalid observation deadline', () => {
  for (const timeoutMs of [0, -1, 1.5, 10001, Infinity]) {
    assert.throws(() => observeCodexOutputDrain(undefined, { timeoutMs }), /deadline/)
  }
})

test('owned child exit and RpcProcess close can precede parsed final usage', {
  skip: process.platform === 'win32', timeout: 10000,
}, async t => {
  const source = `
    process.stdin.resume();
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({
      method: 'thread/tokenUsage/updated', params: { threadId: 'owned-thread', turnId: 'owned-turn',
        tokenUsage: { total: { inputTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 3 } } }
    }) + '\\n', () => process.exit(0)));
    process.stdout.write(JSON.stringify({ method: 'fixture/ready', params: {} }) + '\\n');
  `
  const rpc = new RpcProcess({ executable: process.execPath, args: ['--input-type=module', '-e', source] },
    process.cwd(), { inheritEnvironment: false, gracefulCloseMs: 2000 })
  const stdout = rpc.child.stdout, resume = stdout.resume.bind(stdout)
  const childClosed = once(rpc.child, 'close')
  let usage = false, released = false, drain
  rpc.on('notification', event => { if (event.method === 'thread/tokenUsage/updated') usage = true })
  t.after(async () => {
    released = true
    stdout.resume = resume
    resume()
    drain?.dispose()
    await rpc.close()
    await childClosed
  })
  await once(rpc, 'notification')
  // Temporarily suspend the consumer, including Node's automatic exit-time
  // resume. The child still writes its small final frame and exits normally.
  stdout.pause()
  stdout.resume = () => released ? resume() : stdout
  drain = observeCodexOutputDrain(stdout, { timeoutMs: 2000 })
  const stopped = await rpc.close()
  assert.equal(stopped.leader_exited, true)
  assert.equal(stopped.process_group_empty, true)
  assert.equal(stopped.exit_code, 0)
  assert.equal(usage, false)
  assert.equal(stdout.readableEnded, false)
  released = true
  stdout.resume = resume
  resume()
  assert.deepEqual(await drain.wait(), { drained: true, reason: 'stdout_ended' })
  assert.equal(usage, true)
  await childClosed
})
