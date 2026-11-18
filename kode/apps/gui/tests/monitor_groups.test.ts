import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupMonitorSessions,
  monitorPathBasename,
} from '../src/lib/monitor_groups.ts'

test('groups by first-seen cwd and preserves Worker session order', () => {
  const groups = groupMonitorSessions([
    { id: 1, cwd: '/work/palm-device' },
    { id: 2, cwd: '/work/kode' },
    { id: 3, cwd: '/work/palm-device' },
    { id: 4, cwd: '/work/kode' },
  ])

  assert.deepEqual(groups.map((group) => group.name), ['palm-device', 'kode'])
  assert.deepEqual(groups[0].sessions.map((session) => session.id), [1, 3])
  assert.deepEqual(groups[1].sessions.map((session) => session.id), [2, 4])
})

test('uses the final segment of Windows paths as the group name', () => {
  const groups = groupMonitorSessions([
    { id: 1, cwd: 'D:\\kode' },
    { id: 2, cwd: 'D:\\palm-device' },
  ])

  assert.deepEqual(groups.map((group) => group.name), ['kode', 'palm-device'])
  assert.equal(monitorPathBasename('D:\\one\\two\\'), 'two')
})

test('keeps a missing-cwd group at its first-seen position', () => {
  const groups = groupMonitorSessions([
    { id: 1, cwd: '/work/kode' },
    { id: 2, cwd: null },
  ])

  assert.deepEqual(groups.map((group) => group.name), ['kode', 'Other'])
  assert.equal(groups[1].id, '(no cwd)')
})

test('shows a path hint only when directory basenames collide', () => {
  const groups = groupMonitorSessions([
    { id: 1, cwd: '/one/kode' },
    { id: 2, cwd: '/two/kode' },
    { id: 3, cwd: '/work/palm-device' },
  ])

  assert.equal(groups[0].showPathHint, true)
  assert.equal(groups[0].pathHint, '/one')
  assert.equal(groups[1].showPathHint, true)
  assert.equal(groups[2].showPathHint, false)
})
