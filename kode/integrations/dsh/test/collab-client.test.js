/** Slot/loader lifecycle checks; this harness is not browser rendering acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { symbols } from '@deepseek-ai/cordis'
const source = await readFile(new URL('../packages/collab/client.js', import.meta.url), 'utf8')
function fixture(mode = 'session', lastSuperagentId = null, deferAppearance = false) {
  const entries = [], subscribers = new Map(), disposers = [], selected = [], effects = []
  let mountAppearance, plugin, calls = 0, stored = JSON.stringify({ mode, lastSuperagentId })
  const native = props => ({ native: props }), sidebar = { options: { name: 'sidebar', locale: 'sidebar' }, component: native, inject: () => ({ locale: 'retained' }) }, leading = { options: { name: 'shell.leading', locale: 'sidebar' }, component: native }
  const workspaces = { options:{name:'sidebar.workspaces',locale:'workspace'}, component:native, inject:()=>({locale:'retained'}), store:{} }; entries.push(sidebar, leading, workspaces)
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Fragment: 'fragment', useRef: value => ({ current: value }), useEffect: fn => effects.push(fn), useLayoutEffect: fn => effects.push(fn), useSyncExternalStore: (_, get) => get(), createContext: value => ({ Provider: 'context-provider', _currentValue: value }), useContext: context => context._currentValue }
  const workspace = { startSession() { calls++ } }
  const ctx = { inject: (names,fn) => { if (deferAppearance && names.includes('kodeAppearance')) { mountAppearance = () => fn(ctx); return () => {} } return fn(ctx) }, get: name => name === 'kodeSettings' ? { register: () => () => {} } : workspace, layout: { selectPanel: key => selected.push(key) },
    effect: fn => { const off = fn(); if (typeof off === 'function') disposers.push(off) },
    slots: { entries: name => entries.filter(entry => entry.options.name === name),
      inject: (_, fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off) },
      subscribe: (name, fn) => { const set = subscribers.get(name) ?? new Set(); subscribers.set(name, set); set.add(fn); return () => set.delete(fn) },
      register: (options, component) => { const entry = { options, component }; entries.push(entry); for (const fn of subscribers.get(options.name) ?? []) fn(); return () => { entries.splice(entries.indexOf(entry), 1) } },
    } }
  vm.runInNewContext(source, { window: { addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => stored, setItem: (_, value) => { stored = value } }, __ModuleLoader__: { load(definition) { assert.equal(definition.id, '@kode/dsh-collab'); plugin = definition.factory(name => name === 'react' ? react : { symbols }) } } },
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
  return { ctx, sidebar, workspaces, leading, native, mountAppearance: () => mountAppearance(), selected, workspace, calls: () => calls, modeButton: () => entries.find(entry => entry.options.id === 'kode-collab-mode')?.component(), dispose: () => disposers.reverse().forEach(off => off()) }
}

test('unified sidebar preserves native seats and native Session creation in every legacy mode', () => {
 for (const mode of ['session','im']) {
  const f=fixture(mode),props={wide:true}
  assert.equal(f.sidebar.component,f.native)
  assert.equal(f.leading.component,f.native)
  assert.equal(f.workspaces.component(props).props.native,f.native)
  assert.equal(f.modeButton(),undefined,'there is no obsolete UI mode switch')
  f.workspace.startSession();assert.equal(f.calls(),1)
  f.dispose();assert.equal(f.workspaces.component,f.native)
 }
})

test('legacy sidebar IM flag never steals the native restored main panel', () => {
  const f = fixture('im', 'saved-superagent'); assert.deepEqual(f.selected, [])
  f.ctx.layout.selectPanel('settings')
  f.ctx.slots.register({ name: 'main', key: 'other-plugin' }, () => null)
  assert.deepEqual(f.selected, ['settings'])
  assert.equal(f.calls(), 0); f.dispose()
})


test('native navigation stays intact until the actual appearance plugin becomes available', () => {
  const f = fixture('session', null, true)
  assert.equal(f.modeButton(), undefined)
  assert.equal(f.sidebar.component, f.native)
  assert.equal(f.workspaces.component, f.native)
  f.mountAppearance()
  assert.equal(f.modeButton(),undefined)
  assert.notEqual(f.workspaces.component,f.native)
  assert.equal(f.sidebar.component, f.native)
  f.dispose()
})
