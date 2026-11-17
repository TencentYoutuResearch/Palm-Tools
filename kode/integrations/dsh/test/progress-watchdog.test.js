import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { progressWatchdog } from '../src/progress-watchdog.js'

test('progress renews only its own watchdog; stalled concurrent work expires', async () => {
  const active = progressWatchdog(120), stalled = progressWatchdog(120)
  try {
    for (let i = 0; i < 5; i++) { await delay(40); active.progress() }
    assert.equal(active.signal.aborted, false)
    assert.equal(stalled.signal.reason.code, 'managed_cli_idle_timeout')
    await delay(150)
    assert.equal(active.signal.reason.code, 'managed_cli_idle_timeout')
  } finally { active.dispose(); stalled.dispose() }
})

test('disposed watchdog cannot be rearmed by late output', async () => {
  const watch = progressWatchdog(20), before = watch.lastProgressAt
  watch.dispose()
  await delay(30)
  watch.progress()
  await delay(30)
  assert.equal(watch.signal.aborted, false)
  assert.equal(watch.lastProgressAt, before)
})
