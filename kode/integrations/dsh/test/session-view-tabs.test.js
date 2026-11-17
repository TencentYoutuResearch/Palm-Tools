import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pure data source over the native `conversation.view` slot; React/runtime imports are inert stubs.
const reactStub = `
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment',
useSyncExternalStore:(subscribe,getSnapshot)=>getSnapshot(),useState:initial=>[initial,()=>{}],useMemo:fn=>fn()};
module.exports=React;module.exports.default=React;
`
const stub = { name: 'stub', setup(b) { b.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path, namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path === 'react' ? reactStub : 'const any=new Proxy(function(){},{get:(t,k)=>k==="__esModule"?false:any,apply:()=>any});module.exports=any', loader: 'js' })) } }
const out = await build({ entryPoints: ['packages/collab/session-view-tabs.js'], bundle: true, format: 'esm', platform: 'node', plugins: [stub], write: false })
const dir = await mkdtemp(join(tmpdir(), 'session-view-tabs-')), file = join(dir, 'tabs.mjs')
await writeFile(file, out.outputFiles[0].text)
const { conversationViewSource, createTabbedConversationView } = await import(file)
test.after(() => rm(dir, { recursive: true, force: true }))

const slots = entries => { const subs = new Set(); return { entries: () => entries, subscribe: (_, fn) => { subs.add(fn); return () => subs.delete(fn) }, subs } }
const switchSource = on => { const subs = new Set(); return { getSnapshot: () => on, set(v) { on = v; for (const fn of subs) fn() }, subscribe: fn => { subs.add(fn); return () => subs.delete(fn) } } }

test('native views: trajectory follows the developer-tools switch, snapshot stays stable', () => {
  const s = slots([{ options: { id: 'trajectory', label: () => '轨迹' } }, { options: { id: 'chat', label: '对话' } }, { options: {} }])
  const dev = switchSource(false)
  const source = conversationViewSource(s, dev)
  const first = source.getSnapshot()
  assert.deepEqual(first, [{ id: 'chat', label: '对话' }])
  assert.equal(source.getSnapshot(), first)
  let calls = 0
  const off = source.subscribe(() => calls++)
  dev.set(true)
  assert.equal(calls, 1)
  assert.deepEqual(source.getSnapshot().map(t => t.id), ['trajectory', 'chat'])
  off()
  assert.equal(s.subs.size, 0)
  assert.deepEqual(conversationViewSource(s, null).getSnapshot().map(t => t.id), ['chat'])
})

test('native views: optional resources follow the current session and visibility subscriptions', () => {
  let tapd = false, gongfeng = false
  const listeners = new Set(), subscribedSessions = []
  const subscribe = (sessionId, fn) => {
    subscribedSessions.push(sessionId); listeners.add(fn)
    return () => listeners.delete(fn)
  }
  const s = slots([
    { options: { id: 'chat', label: '对话' } },
    { options: { id: 'kode-resource-tapd', label: 'TAPD', kodeVisibleForSession: () => tapd, kodeVisibilitySubscribe: subscribe } },
    { options: { id: 'kode-resource-gongfeng', label: '工蜂 Git', kodeVisibleForSession: () => gongfeng, kodeVisibilitySubscribe: subscribe } },
  ])
  const source = conversationViewSource(s, null, 'session-a')
  assert.deepEqual(source.getSnapshot().map(tab => tab.label), ['对话'])
  let calls = 0
  const off = source.subscribe(() => calls++)
  assert.deepEqual(subscribedSessions, ['session-a'])
  tapd = true
  for (const fn of listeners) fn()
  assert.equal(calls, 1)
  assert.deepEqual(source.getSnapshot().map(tab => tab.label), ['对话', 'TAPD'])
  gongfeng = true
  for (const fn of listeners) fn()
  assert.deepEqual(source.getSnapshot().map(tab => tab.label), ['对话', 'TAPD', '工蜂 Git'])
  off()
  assert.equal(listeners.size, 0)
  assert.equal(s.subs.size, 0)
})

test('tabbed conversation binds its data source to the embedded session', () => {
  let visible = false
  const s = slots([
    { options: { id: 'chat', label: '对话' } },
    { options: { id: 'kode-resource-tapd', label: 'TAPD', kodeVisibleForSession: sessionId => sessionId === 'session-a' && visible } },
  ])
  const View = createTabbedConversationView(conversationViewSource(s, null))
  const renderSlot = (name, props) => ({ type: name, props, children: [] })
  let tree = View({ sessionId: 'session-a', renderSlot })
  assert.doesNotMatch(JSON.stringify(tree), /TAPD/)
  visible = true
  tree = View({ sessionId: 'session-a', renderSlot })
  assert.match(JSON.stringify(tree), /TAPD/)
  tree = View({ sessionId: 'session-b', renderSlot })
  assert.doesNotMatch(JSON.stringify(tree), /TAPD/)
})
