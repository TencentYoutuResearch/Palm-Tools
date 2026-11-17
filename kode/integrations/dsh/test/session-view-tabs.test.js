import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pure data source over the native `conversation.view` slot; React/runtime imports are inert stubs.
const stub = { name: 'stub', setup(b) { b.onResolve({ filter: /^[^./]/ }, args => ({ path: args.path, namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'const any=new Proxy(function(){},{get:(t,k)=>k==="__esModule"?false:any,apply:()=>any});module.exports=any', loader: 'js' })) } }
const out = await build({ entryPoints: ['packages/collab/session-view-tabs.js'], bundle: true, format: 'esm', platform: 'node', plugins: [stub], write: false })
const dir = await mkdtemp(join(tmpdir(), 'session-view-tabs-')), file = join(dir, 'tabs.mjs')
await writeFile(file, out.outputFiles[0].text)
const { conversationViewSource } = await import(file)
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
