import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { insertRemoteAttachments, remoteAttachmentReferences, RemoteDropGuard, remoteUploadCounts, withRemoteUpload, clearRemoteUploads } from '../src/lib/remote_attachments.ts'
import { isRemoteClipboardPaste } from '../src/lib/terminal_clipboard.ts'

const key = { key: 'v', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, isComposing: false }
test('remote paste supports Ctrl and Cmd without interfering with IME or AltGr', () => {
  assert.equal(isRemoteClipboardPaste(key), true)
  assert.equal(isRemoteClipboardPaste({ ...key, key: 'V', ctrlKey: false, metaKey: true }), true)
  for (const overrides of [{ altKey: true }, { isComposing: true }, { ctrlKey: false }, { metaKey: true }]) {
    assert.equal(isRemoteClipboardPaste({ ...key, ...overrides }), false)
  }
})
test('remote references quote paths and never submit input', () => {
  const text = remoteAttachmentReferences(['/tmp/a.png', '/tmp/中文 image.png', '/tmp/a"b', "/tmp/a'b"])
  assert.equal(text, '@/tmp/a.png @"/tmp/中文 image.png" @"/tmp/a\\"b" @"/tmp/a\'b" ')
  assert.equal(/[\r\n\x1b]/.test(text), false)
  for (const path of ['local.png', '/tmp/a\r', '/tmp/a\x1b', '/tmp/a\x00']) assert.throws(() => remoteAttachmentReferences([path]))
})
test('upload completion checks original target and writes only returned remote paths', async () => {
  let alive = true
  const written: string[] = []
  let finish!: (paths: string[]) => void
  const pending = new Promise<string[]>(resolve => { finish = resolve })
  const run = insertRemoteAttachments(() => pending, () => alive, async text => { written.push(text) })
  alive = false
  finish(['/tmp/remote.png'])
  assert.equal(await run, false)
  assert.deepEqual(written, [])
  alive = true
  assert.equal(await insertRemoteAttachments(async () => ['/tmp/remote.png'], () => alive, async text => { written.push(text) }), true)
  assert.deepEqual(written, ['@/tmp/remote.png '])
  await assert.rejects(insertRemoteAttachments(async () => { throw new Error('upload failed') }, () => true, async text => { written.push(text) }))
  assert.equal(written.length, 1)
})
test('native and HTML5 events share an in-flight guard; failures can retry', async () => {
  const guard = new RemoteDropGuard()
  let calls = 0
  let finish!: () => void
  const work = () => { calls++; return new Promise<void>(resolve => { finish = resolve }) }
  const first = guard.run('session:paths', work)
  await guard.run('session:paths', work)
  assert.equal(calls, 1)
  finish()
  await first
  await guard.run('session:paths', work)
  assert.equal(calls, 1)
  await assert.rejects(guard.run('failed', async () => { throw new Error('denied') }))
  await guard.run('failed', async () => { calls++ })
  assert.equal(calls, 2)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const count = (id: number) => get(remoteUploadCounts)[id] ?? 0

test('upload badge tracks concurrent tasks by session until each finishes', async () => {
  const a = deferred<void>(), b = deferred<void>(), other = deferred<void>()
  const first = withRemoteUpload(101, () => true, start => { start(); start(); return a.promise })
  const second = withRemoteUpload(101, () => true, start => { start(); return b.promise })
  const third = withRemoteUpload(102, () => true, start => { start(); return other.promise })
  assert.equal(count(101), 2)
  assert.equal(count(102), 1)
  a.resolve()
  await first
  assert.equal(count(101), 1)
  b.resolve()
  other.resolve()
  await Promise.all([second, third])
  assert.equal(count(101), 0)
  assert.equal(count(102), 0)
})

test('text and empty clipboard operations never show upload activity', async () => {
  const values: number[] = []
  const unsubscribe = remoteUploadCounts.subscribe(counts => values.push(counts[103] ?? 0))
  await withRemoteUpload(103, () => true, async () => ({ kind: 'text', text: 'ordinary text' }))
  await withRemoteUpload(103, () => true, async () => ({ kind: 'empty' }))
  unsubscribe()
  assert.deepEqual(values, [0])
})

test('upload and reference-write failures clear animation and reject late start', async () => {
  let lateStart!: () => void
  await assert.rejects(withRemoteUpload(104, () => true, async start => {
    lateStart = start
    start()
    assert.equal(count(104), 1)
    throw new Error('upload denied')
  }))
  lateStart()
  assert.equal(count(104), 0)
  const writing = deferred<void>()
  const work = withRemoteUpload(104, () => true, async start => {
    start()
    await insertRemoteAttachments(async () => ['/tmp/upload.png'], () => true, () => writing.promise)
  })
  assert.equal(count(104), 1)
  writing.reject(new Error('write failed'))
  await assert.rejects(work)
  assert.equal(count(104), 0)
  await withRemoteUpload(104, () => true, async start => { lateStart = start })
  lateStart()
  assert.equal(count(104), 0)
})

test('closed session and delayed channel callbacks cannot revive or finish newer tasks', async () => {
  const old = deferred<void>(), latest = deferred<void>()
  let lateStart!: () => void
  const previous = withRemoteUpload(105, () => true, start => {
    lateStart = start
    start()
    return old.promise
  })
  clearRemoteUploads(105)
  assert.equal(count(105), 0)
  lateStart()
  assert.equal(count(105), 0)
  const next = withRemoteUpload(105, () => true, start => { start(); return latest.promise })
  old.resolve()
  await previous
  assert.equal(count(105), 1)
  latest.resolve()
  await next
  assert.equal(count(105), 0)
  await withRemoteUpload(105, () => false, async start => { start(); assert.equal(count(105), 0) })
})

test('drop deduplication does not create multiple upload activities', async () => {
  const guard = new RemoteDropGuard(), pending = deferred<void>()
  let starts = 0
  const work = () => withRemoteUpload(106, () => true, async start => {
    starts++
    start()
    await pending.promise
  })
  const first = guard.run('drop-animation', work)
  await guard.run('drop-animation', work)
  assert.equal(starts, 1)
  assert.equal(count(106), 1)
  pending.resolve()
  await first
  assert.equal(count(106), 0)
})
