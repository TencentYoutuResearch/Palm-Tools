import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRunPage, mergeRunPage, nextRunRefresh } from '../packages/collab/run-pages.js'
const team = { id: 'team', home_hub: 'home' }
const row = (n, revision = 1) => ({ id: String(n).padStart(3, '0'), team_id: 'team', home_hub: 'home', revision, completion_authorized: false })
const result = (items, next = null) => ({ team_id: 'team', home_hub: 'home', items, next_cursor: next })
test('rotating task pages preserve loaded rows, pagination and newer detail revisions', () => {
  const previous = { items: Array.from({ length: 50 }, (_, n) => row(n)), next: '049', loaded: true }
  previous.items[5].revision = 3
  const first = result(Array.from({ length: 25 }, (_, n) => row(n, 2)), '024')
  validateRunPage(first, team)
  const merged = mergeRunPage(previous, first)
  assert.equal(merged.items.length, 50); assert.equal(merged.items[5].revision, 3)
  assert.equal(merged.next, '049'); assert.equal(nextRunRefresh(previous, first), '024')
  const second = result(Array.from({ length: 25 }, (_, n) => row(n + 25, 2)), '049')
  assert.equal(nextRunRefresh(merged, second), '')
  const refreshed = mergeRunPage(merged, second)
  assert.equal(refreshed.items[49].revision, 2); assert.equal(refreshed.next, '049')
  const more = mergeRunPage(refreshed, result([row(50)]), { more: true })
  assert.equal(more.items.length, 51); assert.equal(more.next, null)
})
test('small windows discover new tasks without automatic unbounded pagination', () => {
  const previous = { items: [row(0)], loaded: true, next: null }
  const first = result(Array.from({ length: 25 }, (_, n) => row(n)), '024')
  const merged = mergeRunPage(previous, first)
  assert.equal(merged.items.length, 25); assert.equal(merged.next, '024')
  const beyond = mergeRunPage(merged, result([row(24, 2), row(25)], null))
  assert.equal(beyond.items.length, 25); assert.equal(beyond.next, '024')
  assert.equal(nextRunRefresh(merged, first), '')
  assert.throws(() => validateRunPage(result([row(1), row(0)]), team), /identity/)
  assert.throws(() => validateRunPage(result([{ ...row(0), team_id: 'other' }]), team), /identity/)
  assert.throws(() => validateRunPage(result([row(0)], '999'), team), /cursor/)
})
