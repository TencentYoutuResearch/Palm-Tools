/** The exported facade renders the production Kode components; no imitation artwork or account state. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
const team = { id: 'team', home_hub: 'home', superagent_id: 'superagent' }
function fixture() {
 let plugin, selected = null, foreign = false
 const calls = [], effects = [], styles = [], preference = new Map(), listeners = new Map(), mutations = []
 const root = { style: { setProperty: (...args) => mutations.push(['set', ...args]), removeProperty: key => mutations.push(['remove', key]) }, setAttribute: key => mutations.push(['attribute', key]), removeAttribute: key => mutations.push(['clear', key]) }
 const react = { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: () => ({ current: { closest: () => root } }), useEffect: fn => { effects.push(fn) }, useSyncExternalStore: (_subscribe, get) => get() }
 const window = { localStorage: { getItem: key => preference.get(key) ?? null, setItem: (key, value) => preference.set(key, value) }, dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event) }, addEventListener(type, fn) { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set) }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn) }, __ModuleLoader__: { load(definition) { plugin = definition.factory(name => name === 'react' ? react : new Proxy({}, { get: (_target, key) => key })) } } }
 const scope = { window, localStorage: window.localStorage, URLSearchParams, Event, setInterval, clearInterval, document: { createElement: () => ({ textContent: '', remove() {} }), head: { append: style => styles.push(style) } }, async fetch(url, options) {
   calls.push({ url, options })
   if (url === '/api/kode/avatars') return { ok: true, json: async () => ({ avatars: [{ id: 'gallery/person', url: '/real-avatar', animations: { idle: ['/real-idle'] }, background: '/real-background' }] }) }
   const input = options.body ? JSON.parse(options.body) : Object.fromEntries(new URLSearchParams(url.split('?')[1]))
   if (options.body) selected = input.avatar_id
   return { ok: true, json: async () => ({ ...input, home_hub: foreign ? 'other' : input.home_hub, profile: { id: 'im-key', name: 'Team', type: 'custom', avatar: selected ? { id: selected, url: '/real-avatar' } : { id: null, url: null } } }) }
 } }
 vm.runInNewContext(source, scope)
 const disposers = [], api = plugin.createAppearanceFacade({ effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) } })
 return { api, calls, effects, styles, mutations, preference, foreign: value => { foreign = value }, flushEffects: () => effects.splice(0).map(fn => fn()), dispose: () => disposers.forEach(fn => fn()) }
}
test('facade is inert until requested and installs the same production avatar/background CSS only once', () => {
 const f = fixture()
 assert.equal(f.calls.length, 0); assert.equal(f.styles.length, 0)
 f.api.installStyles(); f.api.installStyles(); assert.equal(f.styles.length, 1)
 assert.match(f.styles[0].textContent, /\.kode-agent-avatar/)
 assert.match(f.styles[0].textContent, /\[data-conversation-content\]\[data-kode-scene\]/)
 assert.match(f.styles[0].textContent, /88%/)
 assert.equal(typeof f.api.Avatar, 'function'); assert.equal(typeof f.api.Choices, 'function')
 f.dispose()
})
test('team appearance reads and saves its exact identity without entering executor configuration routes', async () => {
 const f = fixture(), store = f.api.store(team)
 assert.equal(f.api.store({ ...team }), store)
 await store.load(); await store.save('gallery/person')
 assert.equal(store.getSnapshot().data.profile.avatar.id, 'gallery/person')
 assert.ok(f.calls.every(row => row.url.startsWith('/api/kode/collab/appearance')))
 const saved = JSON.parse(f.calls.find(row => row.options.body).options.body)
 assert.deepEqual(saved, { team_id: 'team', home_hub: 'home', superagent_id: 'superagent', avatar_id: 'gallery/person' })
 await assert.rejects(store.save(undefined), /有效头像/)
 f.foreign(true)
 const foreign = f.api.store({ ...team, id: 'second', superagent_id: 'second' }); await foreign.load()
 assert.equal(foreign.getSnapshot().data, undefined); assert.match(foreign.getSnapshot().error, /身份/)
})
test('actual Avatar and Background use selected gallery media and honor the existing off preference', async () => {
 const f = fixture(); await f.api.refreshLibrary()
 const profile = { id: 'im-key', type: 'custom', avatar: { id: 'gallery/person', url: '/real-avatar' } }
 const avatar = f.api.Avatar({ profile, size: 44 })
 assert.equal(avatar.props.className, 'kode-agent-avatar'); assert.equal(avatar.children[0].type, 'img'); assert.equal(avatar.children[0].props.src, '/real-idle')
 f.effects.length = 0; f.api.Background({ profile }); const disposers = f.flushEffects()
 assert.ok(f.mutations.some(row => row[0] === 'set' && row[2] === 'url("/real-background")'))
 for (const dispose of disposers) if (typeof dispose === 'function') dispose()
 assert.ok(f.mutations.some(row => row[0] === 'clear' && row[1] === 'data-kode-scene'))
 f.preference.set('kode.avatar-background', 'off'); f.effects.length = 0; f.mutations.length = 0
 f.api.Background({ profile }); f.flushEffects(); assert.equal(f.mutations.length, 0)
})
