import test from 'node:test'
import assert from 'node:assert/strict'
import { visibleRefresh } from '../packages/collab/visible-refresh.js'
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
test('visible refresh serializes slow reads, pauses hidden pages and disposes pending continuation', async () => {
  let change, resolve, calls = 0, timer, nextDelay
  const doc = { visibilityState: 'visible', addEventListener(_, fn) { change = fn }, removeEventListener(_, fn) { assert.equal(fn, change); change = null } }
  const stop = visibleRefresh({ document: doc, refresh: () => { calls++; return new Promise(r => { resolve = r }) }, setTimer(fn, delay) { timer = fn; nextDelay = delay; return 1 }, clearTimer() { timer = null } })
  assert.equal(calls, 1)
  doc.visibilityState = 'hidden'; change(); doc.visibilityState = 'visible'; change()
  assert.equal(calls, 1)
  resolve(250); await flush(); assert.equal(nextDelay, 0)
  timer(); assert.equal(calls, 2)
  doc.visibilityState = 'hidden'; change(); resolve(3000); await flush(); assert.equal(timer, null)
  doc.visibilityState = 'visible'; change(); assert.equal(calls, 3)
  stop(); resolve(); await flush(); assert.equal(timer, null); assert.equal(change, null)
})
test('hidden mount waits and failed reads use bounded retry instead of a tight loop', async () => {
  let change, timer, delay, calls = 0
  const doc = { visibilityState: 'hidden', addEventListener(_, fn) { change = fn }, removeEventListener() {} }
  const stop = visibleRefresh({ document: doc, refresh: async () => { calls++; throw Error('offline') }, setTimer(fn, ms) { timer = fn; delay = ms; return 1 }, clearTimer() { timer = null } })
  assert.equal(calls, 0); doc.visibilityState = 'visible'; change(); await flush()
  assert.equal(calls, 1); assert.equal(delay, 10000); stop(); assert.equal(timer, null)
})

test('hiding or unmounting aborts an in-flight refresh and resumes once after it settles', async () => {
  let change, signal, resolve, scheduled, calls = 0
  const doc = { visibilityState: 'visible', addEventListener(_, fn) { change = fn }, removeEventListener() {} }
  const stop = visibleRefresh({ document: doc, refresh: value => { signal = value; calls++; return new Promise(r => { resolve = r }) }, setTimer(fn) { scheduled = fn; return 1 }, clearTimer() { scheduled = null } })
  doc.visibilityState = 'hidden'; change(); assert.equal(signal.aborted, true)
  doc.visibilityState = 'visible'; change(); assert.equal(calls, 1)
  resolve(); await flush(); scheduled(); assert.equal(calls, 2); assert.equal(signal.aborted, false)
  stop(); assert.equal(signal.aborted, true); resolve(); await flush(); assert.equal(scheduled, null)
})
