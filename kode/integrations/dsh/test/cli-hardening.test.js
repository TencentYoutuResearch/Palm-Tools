import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { RpcProcess } from '../src/rpc-process.js'
import { CodexManagedDecision } from '../src/codex-managed-decision.js'
import { DecisionOutput, decisionTexts } from '../src/decision-output.js'

function rpc() {
  return Object.assign(Object.create(RpcProcess.prototype), {
    buffer: '', closed: false, frames: [], receive(message) { this.frames.push(message) },
    fail(error) { this.error = error; this.closed = true },
  })
}
test('RPC bounds each complete frame, not the combined stdout chunk', () => {
  const peer = rpc(), text = 'x'.repeat(4.5 * 1024 * 1024)
  const a = JSON.stringify({ method: 'a', params: { text } })
  const b = JSON.stringify({ method: 'b', params: { text } })
  peer.receiveChunk(a + '\n' + b + '\n')
  assert.equal(peer.error, undefined)
  assert.equal(peer.frames.length, 2)
  assert.equal(peer.buffer, '')
})
test('RPC retains a fragmented frame while accepting adjacent frames', () => {
  const peer = rpc(), line = JSON.stringify({ method: 'a', params: { text: 'x'.repeat(8 * 1024 * 1024 - 128) } })
  peer.receiveChunk(line.slice(0, -1))
  peer.receiveChunk(line.slice(-1) + '\n' + JSON.stringify({ method: 'b', text: 'x'.repeat(2048) }) + '\n')
  assert.equal(peer.error, undefined)
  assert.equal(peer.frames.length, 2)
})
test('RPC still rejects oversized complete, partial and UTF8 frames', () => {
  for (const value of ['x'.repeat(8 * 1024 * 1024 + 1), 'x'.repeat(8 * 1024 * 1024 + 1) + '\n', '界'.repeat(3 * 1024 * 1024)]) {
    const peer = rpc(); peer.receiveChunk(value)
    assert.match(peer.error.message, /frame exceeds/)
    assert.equal(peer.frames.length, 0)
  }
})
test('closing resumes stdout and late tail events cannot apply backpressure again', async () => {
  const actor = Object.create(CodexManagedDecision.prototype), stop = new AbortController()
  let paused = true, finish
  const draining = new Promise(resolve => { finish = resolve })
  Object.assign(actor, { events: Array.from({ length: 512 }, () => ({ event: {}, bytes: 0 })), eventBytes: 0,
    // This prototype fixture must preserve constructor-owned close() options.
    options: {}, watchdog: { dispose() {} }, stop, signal: stop.signal, wake() {},
    rpc: { child: { stdout: { pause() { paused = true }, resume() { paused = false } } }, close: () => draining },
    gate: { async close() {} } })
  const closing = actor.close()
  assert.equal(actor.draining, true)
  assert.equal(paused, false)
  actor.push({ method: 'thread/tokenUsage/updated', params: {} })
  assert.equal(paused, false)
  assert.equal(actor.events.length, 513)
  finish({ process_group_empty: true })
  await closing
})
async function output(t) {
  const root = await mkdtemp(join(tmpdir(), 'kode-output-hardening-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, output: new DecisionOutput(root, 1) }
}
test('private output archive seals only after close and is fully consumed with a verified digest', async t => {
  const f = await output(t)
  await f.output.append('第一段'); await f.output.append('second')
  assert.equal(f.output.artifact.complete, false)
  assert.throws(() => f.output.seal(), /cannot be marked complete/)
  await f.output.close()
  assert.equal(f.output.artifact.complete, false)
  f.output.seal()
  const artifact = f.output.artifact
  assert.equal(artifact.sha256, createHash('sha256').update(await readFile(artifact.path)).digest('hex'))
  assert.equal((await stat(artifact.path)).mode & 0o777, 0o600)
  assert.equal((await stat(join(artifact.path, '..'))).mode & 0o777, 0o700)
  const texts = []
  for await (const text of decisionTexts({ output_artifact: artifact })) texts.push(text)
  assert.deepEqual(texts, ['第一段', 'second'])
})
test('unsealed and corrupted output archives yield no text', async t => {
  const f = await output(t)
  await f.output.append('first'); await f.output.append('second'); await f.output.close()
  let yielded = 0
  await assert.rejects(async () => { for await (const _ of decisionTexts({ output_artifact: f.output.artifact })) yielded++ }, /incomplete/)
  f.output.seal()
  const bytes = await readFile(f.output.artifact.path, 'utf8')
  await writeFile(f.output.artifact.path, bytes.replace('first', 'other'))
  await assert.rejects(async () => { for await (const _ of decisionTexts({ output_artifact: f.output.artifact })) yielded++ }, /integrity/)
  assert.equal(yielded, 0)
})
test('partial writes cannot be sealed and symlink substitution cannot be consumed', async t => {
  const f = await output(t)
  await f.output.append('first')
  const write = f.output.file.writeFile
  f.output.file.writeFile = async () => { throw new Error('storage failure') }
  await assert.rejects(f.output.append('second'), /storage failure/)
  f.output.file.writeFile = write
  await f.output.close()
  assert.throws(() => f.output.seal(), /cannot be marked complete/)
  assert.equal(f.output.artifact.complete, false)
  const path = join(f.root, 'alias')
  await symlink(f.output.artifact.path, path)
  await assert.rejects(async () => { for await (const _ of decisionTexts({ output_artifact: { ...f.output.artifact, path, complete: true } })) {} })
})
