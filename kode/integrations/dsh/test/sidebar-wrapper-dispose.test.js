/** Regression: agent wrapper -> collab wrapper -> agent ctx disposed must keep the native list. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { build } from 'esbuild'

const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect() {}, useRef: value => ({ current: value }),
  useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore: (subscribe, get) => { subscribe(() => {}); return get() },
}
const bundled = await build({ entryPoints: [new URL('../packages/collab/component-adapter.js', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'neutral', external: ['react'], write: false })
const adapterModule = { exports: {} }
vm.runInNewContext(bundled.outputFiles[0].text, { module: adapterModule, exports: adapterModule.exports, require: () => react })
const { adaptSlotComponent: collabAdapt } = adapterModule.exports

function apply(shell) {
  let plugin, inactive = false
  const disposers = [], listeners = new Map()
  vm.runInNewContext(source, { window: { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load: definition => { plugin = definition.factory(name => name === 'react' ? react : new Proxy({}, { get: (_o, key) => key })) } } },
    document: { createElement: () => ({ remove() {} }), head: { append() {} } }, setInterval: () => 0, clearInterval() {}, fetch: async () => ({ ok: true, json: async () => ({ current: 'local', hosts: [] }) }) })
  const slots = { entries: name => name === 'sidebar.workspaces' ? [shell] : [], subscribe: (name, fn) => { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn); return () => set.delete(fn) },
    inject: (_name, callback) => { const result = callback(); if (result?.next) for (const _ of result) {}; if (typeof result === 'function') disposers.push(result) }, register: () => () => {} }
  const ctx = { provide(name, value) { this[name] = value }, get(name) { return this[name] }, remote: { $host: { isLoopback: true } }, workspaces: {},
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: {} }) } },
    get slots() { if (inactive) throw Error('cannot get required service "slots" in inactive context'); return slots },
    inject: (_names, callback) => callback(ctx), effect: callback => { const result = callback(); if (typeof result === 'function') disposers.push(result) } }
  plugin.apply(ctx)
  return { dispose() { for (const fn of disposers.splice(0).reverse()) fn(); inactive = true } }
}
// Render until a host element or the native component is reached.
function resolve(element, native) {
  let node = element
  for (let depth = 0; depth < 10 && node && typeof node.type === 'function' && node.type !== native; depth++) node = node.type({ ...node.props, children: node.children })
  return node
}

test('native workspace list survives agent ctx dispose behind an outer collab wrapper and remounts in a new ctx', () => {
  const native = () => 'native-list', shell = { options: { name: 'sidebar.workspaces', locale: 'workspace' }, component: native, store: {}, children: {} }
  const first = apply(shell)
  const agentWrapper = shell.component
  assert.notEqual(agentWrapper, native)
  // collab wraps the agent wrapper and renders it as its native seat.
  const collab = collabAdapt(shell, ({ native: inner, ...props }) => react.createElement(inner, props))
  assert.equal(shell.component, collab.component)
  first.dispose()
  // The outer wrapper still owns entry.component, but the inactive ctx is never read.
  assert.equal(shell.component, collab.component)
  const rendered = resolve(react.createElement(shell.component, {}), native)
  assert.equal(rendered.type, native)
  // A fresh agent ctx wraps the current chain again; the native list is still reachable.
  const second = apply(shell)
  assert.notEqual(shell.component, collab.component)
  const outer = react.createElement(shell.component, {})
  const federated = outer.type(outer.props)
  assert.equal(typeof federated.type, 'function')
  assert.equal(federated.props.native, collab.component)
  assert.equal(resolve(react.createElement(federated.props.native, {}), native).type, native)
  second.dispose()
  assert.equal(shell.component, collab.component)
  collab.deactivate()
  assert.equal(shell.component, agentWrapper)
  assert.equal(resolve(react.createElement(shell.component, {}), native).type, native)
})
