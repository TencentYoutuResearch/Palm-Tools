/** Slot/loader lifecycle checks; this harness is not browser rendering acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { symbols } from '@deepseek-ai/cordis'
const source = await readFile(new URL('../packages/collab/client.js', import.meta.url), 'utf8')
function fixture(mode = 'session') {
  const entries = [], subscribers = new Map(), disposers = [], selected = [], effects = []
  let plugin, calls = 0, stored = JSON.stringify({ mode })
  const native = props => ({ native: props }), sidebar = { options: { name: 'sidebar', locale: 'sidebar' }, component: native, inject: () => ({ locale: 'retained' }) }, leading = { options: { name: 'shell.leading', locale: 'sidebar' }, component: native }
  entries.push(sidebar, leading)
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment', useRef: value => ({ current: value }), useEffect: fn => effects.push(fn), useLayoutEffect: fn => effects.push(fn), useSyncExternalStore: (_, get) => get() }
  const workspace = { startSession() { calls++ } }
  const ctx = { get: () => workspace, layout: { selectPanel: key => selected.push(key) },
    effect: fn => { const off = fn(); if (typeof off === 'function') disposers.push(off) },
    slots: { entries: name => entries.filter(entry => entry.options.name === name),
      inject: (_, fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off) },
      subscribe: (name, fn) => { const set = subscribers.get(name) ?? new Set(); subscribers.set(name, set); set.add(fn); return () => set.delete(fn) },
      register: (options, component) => { const entry = { options, component }; entries.push(entry); for (const fn of subscribers.get(options.name) ?? []) fn(); return () => { entries.splice(entries.indexOf(entry), 1) } },
    } }
  vm.runInNewContext(source, { window: { localStorage: { getItem: () => stored, setItem: (_, value) => { stored = value } }, __ModuleLoader__: { load(definition) { assert.equal(definition.id, '@kode/dsh-collab'); plugin = definition.factory(name => name === 'react' ? react : { symbols }) } } },
    document: { head: { append() {} }, createElement: () => ({ remove() {} }) },
    AbortController, TextEncoder, setTimeout, clearTimeout,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    fetch(path, init) {
      assert.match(path, /^\/api\/kode\/collab\/teams\?/)
      assert.equal(init.method, 'GET')
      return Promise.resolve({ ok: false, status: 503 })
    } })
  assert.ok(plugin.inject.includes('conversation'), 'managed navigation waits for the native composer service')
  plugin.apply(ctx)
  return { ctx, sidebar, leading, native, selected, workspace, calls: () => calls, modeButton: () => entries.find(entry => entry.options.id === 'kode-collab-mode').component(), dispose: () => disposers.reverse().forEach(off => off()) }
}

test('generated collab loader preserves native seats and toggles only panel state', () => {
  const f = fixture(), props = { width: 240, locale: 'native-locale' }
  assert.equal(f.sidebar.component(props).type, f.native)
  assert.equal(f.leading.component(props).type, f.native)
  const inject = f.sidebar.inject
  f.modeButton().props.onClick()
  assert.deepEqual(f.selected, ['kode-collab']); assert.equal(f.calls(), 0)
  assert.notEqual(f.sidebar.component(props).type, f.native)
  assert.equal(f.sidebar.inject, inject)
  f.workspace.startSession(); assert.equal(f.calls(), 0)
  f.modeButton().props.onClick(); assert.equal(f.selected.at(-1), null)
  assert.equal(f.sidebar.component(props).type, f.native)
  f.dispose(); assert.equal(f.sidebar.component, f.native); assert.equal(f.leading.component, f.native)
  f.workspace.startSession(); assert.equal(f.calls(), 1)
})

test('stored IM mode restores once and later main registrations do not steal navigation', () => {
  const f = fixture('im'); assert.deepEqual(f.selected, ['kode-collab'])
  f.ctx.layout.selectPanel('settings')
  f.ctx.slots.register({ name: 'main', key: 'other-plugin' }, () => null)
  assert.deepEqual(f.selected, ['kode-collab', 'settings'])
  assert.equal(f.calls(), 0); f.dispose()
})
