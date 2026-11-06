import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../packages/chat/workbench-ui.js', import.meta.url), 'utf8')
test('jobs move to the composer with native injections, locale, output and kill handlers intact and restore on disposal', () => {
  const slots = [], cleanups = [], native = () => {}, inject = () => ({ hooks: { jobs: 'state' }, killJob: 'kill', observe: 'output' })
  const entry = { options: { id: 'job-list', name: 'conversation.session.header.actions', order: 20, locale: 'job', inject }, component: native }
  let subscriber
  const ctx = { slots: { inject(seat, fn) { cleanups.push(fn()) }, entries: () => [entry], subscribe(seat, fn) { subscriber = fn; return () => {} }, register(options, component) { const row = { options, component, disposed: false }; slots.push(row); return () => { row.disposed = true } } } }
  const relocate = vm.runInNewContext(source + '\nrelocateWorkbenchJobs', { react: { createElement: (type, props, child) => ({ type, props, child }) } })
  relocate(ctx); subscriber(); assert.equal(slots.length, 1); assert.equal(entry.component(), null)
  assert.equal(slots[0].options.name, 'conversation.input.dock'); assert.equal(slots[0].options.inject, inject); assert.equal(slots[0].options.locale, 'job')
  const node = slots[0].component({ sessionId: 'session' }); assert.equal(node.child.type, native); assert.equal(node.child.props.sessionId, 'session')
  cleanups[0](); assert.equal(entry.component, native); assert.equal(slots[0].disposed, true)
})
test('worktree search lives inside the dropdown and preserves selection while filtering local and remote branches', async () => {
  const client = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
  let cursor = 0, value = 'refs/heads/main'
  const state = [], info = { branch: 'main', commit: '1234567890', branches: [{ name: 'main', ref: value, commit: '1234567890' }, { name: 'origin/FEATURE', ref: 'refs/remotes/origin/FEATURE', commit: '2345678901' }] }
  const scope = { h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), Menu: 'menu', IconChevronDownOutlineRegular: 'chevron', IconSearchOutlineRegular: 'search', IconCheckOutlineRegular: 'check',
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], next => { state[i] = next }] } }
  vm.runInNewContext(client.slice(client.indexOf('  function BranchPicker('), client.indexOf('  function WorktreeForm(')), scope)
  const render = () => { cursor = 0; return scope.BranchPicker({ info, value, disabled: false, onChange: next => { value = next } }) }
  const find = (node, predicate) => node && typeof node === 'object' ? predicate(node) ? node : (node.children ?? []).map(child => find(child, predicate)).find(Boolean) : undefined
  let tree = render(), menu = find(tree, node => node.type === 'menu')
  assert.equal(menu.props.open, false)
  assert.equal(find(tree, node => node.props.type === 'search'), find(menu, node => node.props.type === 'search'))
  menu.props.anchor.props.onClick(); tree = render(); menu = find(tree, node => node.type === 'menu')
  assert.equal(menu.props.open, true); assert.equal(menu.props.portal, true)
  find(menu, node => node.props.type === 'search').props.onChange({ target: { value: '  feature ' } }); tree = render()
  assert.equal(value, 'refs/heads/main')
  assert.equal(find(tree, node => node.props.className === 'kode-branch-name').children[0], 'origin/FEATURE')
  assert.equal(find(tree, node => node.props['aria-checked'] === true), undefined)
  find(tree, node => node.props.role === 'menuitemradio').props.onClick(); tree = render()
  assert.equal(value, 'refs/remotes/origin/FEATURE'); assert.equal(find(tree, node => node.type === 'menu').props.open, false)
  find(tree, node => node.type === 'menu').props.anchor.props.onClick(); tree = render()
  find(tree, node => node.props.type === 'search').props.onChange({ target: { value: 'missing' } }); tree = render()
  assert.equal(value, 'refs/remotes/origin/FEATURE'); assert.match(find(tree, node => node.props.role === 'status').children[0], /没有匹配/)
})

test('token island loads selected-host statistics, changes period, and never displays a previous host snapshot', async () => {
  let cursor = 0, host = 'local'
  const state = [], effects = [], requests = [], listeners = new Map()
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const react = { createElement: h, Fragment: 'fragment',
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] },
    useRef(initial) { const i = cursor++; return state[i] ??= { current: initial } }, useId: () => 'usage-panel', useCallback: fn => fn, useSyncExternalStore: (subscribe, snapshot) => snapshot(),
    useEffect(fn, deps) { const i = cursor++, previous = state[i]; if (!previous || deps.some((value, j) => value !== previous.deps[j])) { previous?.cleanup?.(); const effect = { deps }; state[i] = effect; effects.push(() => { effect.cleanup = fn() }) } } }
  const transport = { get current() { return host }, subscribe: () => () => {}, async fetch(path, options, selected) {
    requests.push({ path, selected, options })
    return { ok: true, json: async () => ({ totals: { total_tokens: selected === 'local' ? 1200 : 9000 }, rows: [], daily: [] }) }
  } }
  const scope = { react, context: { get: () => transport }, _deepseek_ai_dsh_client_ui_primitives: { IconChevronDownOutlineRegular: 'chevron', IconCloseOutlineRegular: 'close' },
    document: { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    AbortController, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, Intl }
  const component = vm.runInNewContext(source + '\nkodeWorkbenchContext = context; KodeTokenIsland', scope)
  const render = () => { cursor = 0; const tree = component(); effects.splice(0).forEach(fn => fn()); return tree }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const find = (node, predicate) => node && typeof node === 'object' ? predicate(node) ? node : (node.children ?? []).map(child => find(child, predicate)).find(Boolean) : undefined
  let tree = render(); await settle(); tree = render()
  assert.equal(find(tree, node => node.type === 'strong').children[0], '1.2K')
  assert.equal(requests[0].selected, 'local'); assert.ok(requests[0].options.signal)
  find(tree, node => node.props.className === 'kode-token-notch').props.onClick(); tree = render(); await settle(); tree = render()
  assert.ok(find(tree, node => node.props['aria-label'] === 'Token 用量'))
  find(tree, node => node.type === 'button' && node.children.includes('本月')).props.onClick(); tree = render(); await settle(); tree = render()
  assert.ok(requests.some(row => row.path.includes('period=month')))
  host = 'remote:fixture.example'; tree = render()
  assert.equal(find(tree, node => node.type === 'strong').children[0], '—')
  await settle(); tree = render(); assert.equal(find(tree, node => node.type === 'strong').children[0], '9K')
  assert.equal(requests.at(-1).selected, host)
  tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); tree = render()
  assert.equal(find(tree, node => node.props['aria-label'] === 'Token 用量').props['aria-hidden'], true)
  for (const value of state) value?.cleanup?.()
})

test('token island is registered once on the application overlay rather than inside each session', async () => {
  const seats = [], entries = []
  const document = { createElement: () => ({ remove() {} }), head: { append() {} } }
  const install = vm.runInNewContext(source + '\ninstallWorkbenchUi', { document })
  install({ effect: fn => fn(), slots: { inject: (seat, fn) => { seats.push(seat); if (seat === 'shell.overlay') fn() }, register: (options, component) => { entries.push({ options, component }); return () => {} } } })
  assert.deepEqual(seats, ['conversation.session.header.actions', 'shell.overlay'])
  assert.equal(entries.length, 1); assert.equal(entries[0].options.id, 'kode-token-island')
  const build = await readFile(new URL('../scripts/build-chat.js', import.meta.url), 'utf8')
  assert.doesNotMatch(build, /react\.createElement\(KodeTokenIsland/)
})
