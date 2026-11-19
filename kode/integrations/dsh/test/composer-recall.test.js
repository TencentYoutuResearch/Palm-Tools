import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
const helpers = source.slice(source.indexOf('// Composer recall:'), source.indexOf('var directoryBindingCache'))
const component = source.slice(source.indexOf('  function ComposerRecall'), source.indexOf('  function SteeringControls'))
function memoryStorage() {
  const rows = new Map()
  return { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, String(value)), removeItem: key => rows.delete(key) }
}
function load(storage = memoryStorage()) {
  const scope = { sessionStorage: storage, queueMicrotask: fn => fn(), Proxy, Reflect, document: { addEventListener() {}, removeEventListener() {} },
    h: (type, props) => ({ type, props }), useRef: () => ({}), useMemo: fn => fn(), useEffect: () => {} }
  vm.runInNewContext(helpers + component, scope)
  return scope
}
const user = (text, time, kind = 'user') => ({ kind, data: { time, source: { kind: 'user' }, content: [{ type: 'text', text }] } })

test('recall lists newest first, dedupes sent and cleared drafts, and skips the current draft and non-human input', () => {
  const storage = memoryStorage(), scope = load(storage)
  scope.archiveComposerText('s1', '  cleared idea  ', 'draft', 30, storage)
  scope.archiveComposerText('s1', 'second', 'sent', 25, storage)
  scope.archiveComposerText('other', 'elsewhere', 'sent', 99, storage)
  const nodes = [user('first', 10), user('second', 20), user('steered', 40, 'steering'), user('typing', 50),
    { kind: 'user', data: { time: 60, source: { kind: 'agent-message' }, content: [{ type: 'text', text: 'relay' }] } }]
  const entries = scope.composerRecallEntries('s1', nodes, 'typing', storage)
  assert.deepEqual(Array.from(entries, row => `${row.source}:${row.text}`), ['sent:steered', 'draft:cleared idea', 'sent:second', 'sent:first'])
})

test('↑ starts only at the draft start, walks to the oldest and ↓ restores the unsent draft', () => {
  const { composerRecallStep: step } = load()
  const entries = [{ text: 'newer', source: 'sent' }, { text: 'older', source: 'draft' }]
  const at = n => ({ start: n, end: n })
  assert.equal(step(null, 'up', 'draft', at(3), () => entries).text, undefined, 'caret inside the draft keeps ↑ for the editor')
  let move = step(null, 'up', 'draft', at(0), () => entries)
  assert.equal(move.text, 'newer')
  move = step(move.nav, 'up', 'newer', at(5), () => assert.fail('entries load once'))
  assert.equal(move.text, 'older')
  assert.equal(step(move.nav, 'up', 'older', at(5)).text, 'older', 'the oldest entry stays put')
  assert.equal(step(move.nav, 'down', 'older', at(2)).text, undefined, '↓ needs the caret at the end')
  move = step(move.nav, 'down', 'older', at(5))
  assert.equal(move.text, 'newer')
  move = step(move.nav, 'down', 'newer', at(5))
  assert.equal(move.text, 'draft')
  assert.equal(move.nav, null)
  assert.equal(step(null, 'down', 'draft', at(5)).text, undefined)
})

test('editing a recalled entry ends navigation instead of discarding the edit', () => {
  const { composerRecallStep: step } = load()
  const first = step(null, 'up', '', { start: 0, end: 0 }, () => [{ text: 'recalled', source: 'sent' }])
  const edited = step(first.nav, 'down', 'recalled plus edit', { start: 18, end: 18 })
  assert.equal(edited.text, undefined)
  assert.equal(edited.nav, null)
})

test('the wrapped keyboard yields to an open menu, modifiers and IME, and archives sent and cleared drafts', () => {
  const storage = memoryStorage(), listeners = {}, updates = [], calls = [], drafts = [], attributes = {}
  const scope = load(storage)
  scope.document = { addEventListener: (type, fn) => { listeners[type] = fn }, removeEventListener() {} }
  scope.useEffect = fn => fn()
  let menu = 'pass'
  const root = { contains: () => true, setAttribute: (key, value) => { attributes[key] = value }, removeAttribute: key => { delete attributes[key] } }
  const keyboard = {
    snapshot: { phase: 'plain', draft: '' }, caretSpan: () => ({ start: 0, end: 0 }),
    editor: { getRootElement: () => root, registerUpdateListener: fn => { updates.push(fn); return () => {} } },
    arbitrate: () => menu, submit: (...args) => calls.push(args), steerQueue() { calls.push(this === keyboard) },
  }
  const view = scope.ComposerRecall({ native: 'bar', keyboard, sessionId: 's1', inputActions: { setDraft: text => drafts.push(text) },
    useChat: select => select({ nodes: { values: () => [user('earlier', 1)] } }) })
  const wrapped = view.props.keyboard
  const press = (event = {}, composing = false) => { listeners.keydown({ key: 'ArrowUp', target: root, ...event }); return wrapped.arbitrate('up', composing) }
  menu = 'consumed'
  assert.equal(press(), 'consumed', 'an open trigger menu keeps the arrow')
  menu = 'pass'
  assert.equal(press({ shiftKey: true }), 'pass')
  assert.equal(press({ metaKey: true }), 'pass')
  assert.equal(press({}, true), 'pass')
  assert.equal(wrapped.arbitrate('up', false), 'pass', 'an arbitrate without its keydown is not recall')
  assert.deepEqual(drafts, [])
  assert.equal(press(), 'consumed')
  assert.deepEqual(drafts, ['earlier'])
  assert.equal(attributes['aria-description'], '历史消息 1/1')
  wrapped.steerQueue()
  assert.deepEqual(calls, [true], 'other keyboard verbs keep their receiver')

  keyboard.snapshot = { phase: 'plain', draft: 'brand new' }
  wrapped.submit('queue', 'enter')
  assert.deepEqual(calls.at(-1), ['queue', 'enter'])
  assert.equal(attributes['aria-description'], undefined)
  keyboard.snapshot = { phase: 'plain', draft: '' }; updates.forEach(fn => fn())
  keyboard.snapshot = { phase: 'plain', draft: 'half typed thought' }; updates.forEach(fn => fn())
  keyboard.snapshot = { phase: 'plain', draft: '' }; updates.forEach(fn => fn())
  assert.deepEqual(Array.from(scope.readComposerHistory('s1', storage), row => `${row.source}:${row.text}`), ['draft:half typed thought', 'sent:brand new'])
})

test('claimed commands keep the arrows', () => {
  const scope = load(), listeners = {}
  scope.document = { addEventListener: (type, fn) => { listeners[type] = fn }, removeEventListener() {} }
  scope.useEffect = fn => fn()
  const root = { contains: () => true, setAttribute() {}, removeAttribute() {} }
  const keyboard = { snapshot: { phase: 'claimed', draft: '/goal ' }, caretSpan: () => ({ start: 0, end: 0 }), arbitrate: () => 'pass', editor: { getRootElement: () => root } }
  const view = scope.ComposerRecall({ native: 'bar', keyboard, sessionId: 's1', inputActions: { setDraft: () => assert.fail('no recall') },
    useChat: select => select({ nodes: { values: () => [user('earlier', 1)] } }) })
  listeners.keydown({ key: 'ArrowUp', target: root })
  assert.equal(view.props.keyboard.arbitrate('up', false), 'pass')
})

test('the inert composer renders without a keyboard', () => {
  const view = load().ComposerRecall({ native: 'bar', sessionId: 's1' })
  assert.equal(view.type, 'bar')
  assert.equal(view.props.keyboard, undefined)
})
