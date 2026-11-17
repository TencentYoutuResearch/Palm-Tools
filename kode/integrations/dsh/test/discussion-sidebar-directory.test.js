import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { discussionKey, discussionScope, sameDiscussionScope } from '../packages/collab/discussion-model.js'

const scope = { home_hub: 'home', host_id: 'host', workspace_id: 'workspace', root_ref: '/fixture' }
const source = readFileSync(new URL('../packages/collab/discussion-sidebar-directory.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '').replace('export function', 'function')
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
function fixture() {
  const states = [], requests = [], timers = new Map()
  let index = 0, dependencies, cleanup, pendingEffect, nextTimer = 0
  const sandbox = { discussionKey, discussionScope, sameDiscussionScope, AbortController,
    useState(initial) {
      const slot = index++
      if (!(slot in states)) states[slot] = initial
      return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value }]
    },
    useEffect(effect, deps) {
      if (!dependencies || deps.some((value, i) => value !== dependencies[i])) {
        dependencies = deps; pendingEffect = effect
      }
    },
    requestDiscussion(path, query, body, options) {
      return new Promise((resolve, reject) => requests.push({ path, query, body, ...options, resolve, reject }))
    },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  vm.runInNewContext(source + '\nthis.hook = useDiscussionSidebarDirectory', sandbox)
  return { requests, timers,
    render(value = scope, version = 0) {
      index = 0
      const output = sandbox.hook(value, version)
      if (pendingEffect) { const effect = pendingEffect; pendingEffect = null; cleanup?.(); cleanup = effect() }
      return output
    },
    dispose() { cleanup?.() },
  }
}
const page = (value = scope) => ({ scope: value, items: [{ id: 'existing', kind: 'channel', scope: value }] })

test('sidebar failure offers exact-scope read-only retry and recovers existing rows', async () => {
  const f = fixture(); f.render()
  f.requests[0].reject(Error('temporarily unavailable')); await flush()
  const failed = f.render(); assert.match(failed.error, /暂不可用/); assert.equal(failed.page, null)
  failed.retry(); f.render(); assert.equal(f.requests.length, 2)
  for (const request of f.requests) {
    assert.equal(request.path, 'surfaces'); assert.deepEqual(request.query, scope)
    assert.equal(request.body, undefined, 'never create or send anything')
  }
  assert.equal(f.requests[0].signal.aborted, true)
  f.requests[1].resolve(page()); await flush()
  assert.equal(f.render().page.items[0].id, 'existing'); assert.equal(f.render().error, '')
  assert.equal(f.timers.size, 0); f.dispose()
})

test('scope change aborts old request and rejects its late response', async () => {
  const f = fixture(), other = { ...scope, workspace_id: 'other' }; f.render()
  assert.equal(f.render(other).page, null); assert.equal(f.requests[0].signal.aborted, true)
  f.requests[1].resolve(page(other)); await flush()
  f.requests[0].resolve(page()); await flush()
  assert.equal(f.render(other).page.scope.workspace_id, 'other'); f.dispose()
})

test('previous scope rows are not exposed even before next effect completes', async () => {
  const f = fixture(); f.render(); f.requests[0].resolve(page()); await flush()
  assert.ok(f.render().page)
  assert.equal(f.render({ ...scope, root_ref: '/another' }).page, null); f.dispose()
})

test('cross-scope or malformed directory pages fail closed', async () => {
  for (const invalid of [null, { scope, items: null }, page({ ...scope, host_id: 'other' }),
    { scope, items: [{ scope: { ...scope, home_hub: 'other' } }] }]) {
    const f = fixture(); f.render(); f.requests[0].resolve(invalid); await flush()
    assert.equal(f.render().page, null); assert.ok(f.render().error); f.dispose()
  }
})

test('connection-queue timeout exposes retry and late response cannot replace it', async () => {
  const f = fixture(); f.render()
  const timer = [...f.timers.values()][0]; assert.equal(timer.ms, 20000); timer.fn()
  assert.equal(f.requests[0].signal.aborted, true); assert.ok(f.render().error)
  f.requests[0].resolve(page()); await flush(); assert.equal(f.render().page, null)
  f.render().retry(); f.render(); assert.equal(f.requests.length, 2); f.dispose()
})

test('unmount cancels reads and timers, and version refresh remains supported', async () => {
  const f = fixture(); f.render(); f.render(scope, 1)
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].signal.aborted, true)
  f.dispose(); assert.equal(f.requests[1].signal.aborted, true); assert.equal(f.timers.size, 0)
  f.requests[1].resolve(page()); await flush(); assert.equal(f.render(scope, 1).page, null)
})

test('channel sidebar recovery retains the native refresh control and accessible label', () => {
  const ui = readFileSync(new URL('../packages/collab/discussion-ui.js', import.meta.url), 'utf8')
  assert.match(ui, /useDiscussionSidebarDirectory\(scope,tick\)/)
  assert.match(ui, /kind==='channel'&&error/)
  assert.match(ui, /IconButton,\{icon:'refresh',label:'重新读取频道目录',onClick:retry\}/)
})
