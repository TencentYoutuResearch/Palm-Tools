import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../packages/chat/workbench-ui.js', import.meta.url), 'utf8')
test('jobs move to the composer with native injections, locale, output and kill handlers intact and restore on disposal', () => {
  const slots = [], cleanups = [], native = () => {}, inject = () => ({ hooks: { jobs: 'state' }, killJob: 'kill', observe: 'output' })
  const entry = { options: { id: 'job-list', name: 'conversation.session.header.actions', order: 20 }, locale: 'job', inject, component: native }
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

for (const initialPeriod of ['today', 'follow']) test(`token island (${initialPeriod}) loads selected-host statistics, changes period, and never displays a previous host snapshot`, async () => {
  let enabled = true, meterPeriod = initialPeriod, poll
  let cursor = 0, host = 'local', activityState = { state: 'awaiting', label: '全局：2 个会话等待操作' }
  const state = [], effects = [], requests = [], listeners = new Map()
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const react = { createElement: h, Fragment: 'fragment',
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] },
    useRef(initial) { const i = cursor++; return state[i] ??= { current: initial } }, useId: () => 'usage-panel', useCallback: fn => fn, useSyncExternalStore: (subscribe, snapshot) => snapshot(),
    useEffect(fn, deps) { const i = cursor++, previous = state[i]; if (!previous || deps.some((value, j) => value !== previous.deps[j])) { previous?.cleanup?.(); const effect = { deps }; state[i] = effect; effects.push(() => { effect.cleanup = fn() }) } } }
  const transport = { get current() { return host }, subscribe: () => () => {}, async fetch(path, options, selected) {
    requests.push({ path, selected, options })
    return { ok: true, json: async () => ({ totals: { total_tokens: selected !== 'local' ? 9000 : path.includes('since_ms=') ? 4800 : path.includes('period=all') ? 3600 : path.includes('period=month') ? 2400 : 1200 }, rows: [], daily: [] }) }
  } }
  const popups = []
  const scope = { kodeDesktop: { island: true, resizeIsland() {} }, window: { open() {
    const popupListeners = new Map(), windowListeners = new Map()
    const popup = { listeners: popupListeners, addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name), closed: false, close() { this.closed = true }, screen: { availHeight: 1000 }, document: { hidden: false, addEventListener: (name, fn) => popupListeners.set(name, fn), removeEventListener: name => popupListeners.delete(name), createElement: () => ({}), head: { append() {} }, body: {} } }; popups.push(popup); return popup
  } }, react_dom: { createPortal: content => content }, react, context: { get: () => transport }, _deepseek_ai_dsh_client_ui_primitives: { IconChevronDownOutlineRegular: 'chevron', IconCloseOutlineRegular: 'close' },
    document: { querySelector: () => null, hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    AbortController, setTimeout, clearTimeout, setInterval: fn => { poll = fn; return 1 }, clearInterval() {}, Intl }
  const component = vm.runInNewContext(source + '\nkodeWorkbenchContext = context; KodeTokenIsland', scope)
  const render = () => { cursor = 0; const tree = component({ appearance: { subscribe: () => () => {}, getSnapshot: () => ({ tokenIsland: enabled, tokenPeriod: meterPeriod }) }, activity: { subscribe: () => () => {}, getSnapshot: () => activityState } }); effects.splice(0).forEach(fn => fn()); return tree }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const find = (node, predicate) => node && typeof node === 'object' ? predicate(node) ? node : (node.children ?? []).map(child => find(child, predicate)).find(Boolean) : undefined
  let tree = render(); await settle(); tree = render()
  assert.equal(find(tree, node => node.type === 'strong').children[0], '1.2K')
  assert.equal(find(tree, node => node.type === 'i').props['data-state'], 'awaiting')
  activityState = { state: 'ongoing', label: '全局：1 个会话正在运行' }; tree = render()
  assert.equal(find(tree, node => node.type === 'i').props['data-state'], 'ongoing')
  assert.equal(requests[0].selected, 'local'); assert.ok(requests[0].options.signal)
  scope.document.hidden = true // The native island stays visible when the owner is backgrounded.
  for (const selectedPeriod of ['month', 'all', 'today']) {
    meterPeriod = selectedPeriod; tree = render()
    assert.equal(find(tree, node => node.type === 'strong').children[0], '—', 'never relabel a stale total as a new period')
    await settle(); tree = render(); await settle(); tree = render()
    assert.ok(requests.at(-1).path.includes(`period=${selectedPeriod}`))
    assert.match(find(tree, node => node.props.className === 'kode-token-notch').props['aria-label'], new RegExp(({today:'今日',month:'本月',all:'全部'})[selectedPeriod]))
  }
  let beforePoll = requests.length
  poll(); await settle(); tree = render()
  assert.ok(requests.length > beforePoll, 'visible native island keeps polling behind other apps')
  popups[0].document.hidden = true; beforePoll = requests.length
  poll(); await settle()
  assert.equal(requests.length, beforePoll, 'hidden owner and panel pause history scans')
  popups[0].document.hidden = false
  popups[0].listeners.get('visibilitychange')(); await settle(); tree = render()
  assert.ok(requests.length > beforePoll, 'native visibility resumes reads without foregrounding the owner')
  find(tree, node => node.props.className === 'kode-token-notch').props.onClick(); tree = render(); await settle(); tree = render()
  assert.ok(find(tree, node => node.props['aria-label'] === 'Token 用量'))
  find(tree, node => node.type === 'button' && node.children.includes('本月')).props.onClick(); tree = render(); await settle(); tree = render()
  assert.ok(requests.some(row => row.path.includes('period=month')))
  for (const label of ['全部', '今天']) {
    find(tree, node => node.type === 'button' && node.children.includes(label)).props.onClick()
    tree = render(); await settle(); tree = render()
    assert.equal(find(tree, node => node.props.role === 'status' && node.children.includes('正在读取 CLI 历史…')), undefined)
    assert.ok(find(tree, node => node.props.className === 'kode-token-totals'), 'background period changes render the loaded totals')
  }
  const begin = () => find(tree, node => node.props['aria-label'] === '开始时间')
  const end = () => find(tree, node => node.props['aria-label'] === '结束时间')
  assert.ok(begin().props.value); assert.ok(end().props.value)
  assert.equal(find(tree, node => node.type === 'button' && node.children.includes('从此时至今')), undefined)
  begin().props.onChange({ target: { value: '2026-01-12T08:23' } }); tree = render(); await settle(); tree = render()
  assert.ok(requests.at(-1).path.includes(`since_ms=${new Date('2026-01-12T08:23').getTime()}`))
  end().props.onChange({ target: { value: '2026-01-13T12:00' } }); tree = render(); await settle(); tree = render()
  assert.ok(requests.at(-1).path.includes(`until_ms=${new Date('2026-01-13T12:00').getTime()}`))
  assert.ok(requests.at(-1).path.includes('period=today'))
  const requestCount = requests.length
  begin().props.onChange({ target: { value: '2026-01-14T08:23' } }); tree = render(); await settle(); tree = render()
  assert.equal(begin().props['aria-invalid'], true)
  assert.equal(requests.length, requestCount)
  meterPeriod = 'follow'; tree = render()
  assert.equal(find(tree, node => node.type === 'strong').children[0], '—')
  await settle(); tree = render()
  assert.equal(find(tree, node => node.type === 'strong').children[0], '4.8K')
  assert.match(find(tree, node => node.props.className === 'kode-token-notch').props['aria-label'], /所选范围/)
  assert.ok(requests.at(-1).path.includes(`until_ms=${new Date('2026-01-13T12:00').getTime()}`))
  tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); tree = render(); await settle(); tree = render()
  assert.equal(find(tree, node => node.type === 'strong').children[0], '4.8K', 'closing details preserves the custom meter range')
  poll(); await settle(); tree = render()
  assert.ok(requests.at(-1).path.includes('since_ms='))
  find(tree, node => node.props.className === 'kode-token-notch').props.onClick(); tree = render(); await settle(); tree = render()
  for (const [label, total] of [['本月', '2.4K'], ['全部', '3.6K']]) {
    const before = requests.length
    find(tree, node => node.type === 'button' && node.children.includes(label)).props.onClick()
    tree = render()
    assert.equal(find(tree, node => node.type === 'strong').children[0], '—')
    await settle(); tree = render()
    assert.equal(find(tree, node => node.type === 'strong').children[0], total)
    assert.equal(requests.length, before + 1, 'following details reuses one statistics request')
    assert.equal(requests.at(-1).path.includes('since_ms='), false)
  }
  assert.equal(requests.some(row => row.path.includes('period=follow')), false)
  meterPeriod = 'today'; tree = render(); await settle(); tree = render(); await settle(); tree = render()
  assert.equal(find(tree, node => node.type === 'strong').children[0], '1.2K', 'fixed scope is restored when follow mode is disabled')
  host = 'remote:fixture.example'; tree = render()
  assert.equal(find(tree, node => node.type === 'strong').children[0], '—')
  await settle(); tree = render(); assert.equal(find(tree, node => node.type === 'strong').children[0], '9K')
  assert.equal(requests.at(-1).selected, host)
  tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); tree = render()
  assert.equal(find(tree, node => node.props['aria-label'] === 'Token 用量').props['aria-hidden'], true)
  assert.equal(popups.length, 1); assert.equal(popups[0].closed, false)
  enabled = false; assert.equal(render(), null); await settle()
  assert.equal(popups[0].closed, true)
  const stoppedRequests = requests.length
  render(); await settle(); assert.equal(requests.length, stoppedRequests)
  assert.equal(listeners.has('visibilitychange'), false)
  assert.equal(popups[0].listeners.size, 0)
  enabled = true; tree = render(); await settle(); tree = render(); await settle(); tree = render()
  assert.ok(requests.length > stoppedRequests)
  assert.equal(popups.length, 2); assert.equal(popups[1].closed, false)
  for (const value of state) value?.cleanup?.()
})

test('token island is registered once on the application overlay rather than inside each session', async () => {
  const seats = [], entries = []
  const document = { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } }
  const install = vm.runInNewContext(source + '\ninstallWorkbenchUi', { document })
  install({ inject(names, fn) { fn(this) }, get: () => null, effect: fn => fn(), slots: { inject: (seat, fn) => { seats.push(seat); if (seat === 'shell.overlay') fn() }, register: (options, component) => { entries.push({ options, component }); return () => {} } } })
  assert.deepEqual(seats, ['conversation.session.header.actions', 'shell.overlay'])
  assert.equal(entries.length, 1); assert.equal(entries[0].options.id, 'kode-token-island')
  const build = await readFile(new URL('../scripts/build-chat.js', import.meta.url), 'utf8')
  assert.doesNotMatch(build, /react\.createElement\(KodeTokenIsland/)
})

test('period buckets begin with selected activity and retain elapsed gaps with multi-select totals', () => {
  const viewOf = vm.runInNewContext(source + '\nusageView', { Intl })
  const now = new Date(2026, 10, 6, 10, 30)
  const rows = [{ backend: 'codex', model: 'shared', total_tokens: 100, input_tokens: 80, output_tokens: 20 }, { backend: 'claude', model: 'shared', total_tokens: 50, input_tokens: 40, output_tokens: 10 }, { backend: 'claude', model: 'other', total_tokens: 30, input_tokens: 20, output_tokens: 10 }]
  const snapshot = { rows, timeline: [{ date: '2026-11-06T02:00', rows: rows.slice(0, 1) }, { date: '2026-11-06T10:00', rows: rows.slice(1) }] }
  let view = viewOf(snapshot, 'today', 'backend', null, now)
  assert.equal(view.timeline.length, 9); assert.equal(view.timeline[0].key, '2026-11-06T02:00')
  assert.equal(view.totals.total_tokens, 180); assert.equal(view.timeline.reduce((sum, bucket) => sum + bucket.total, 0), 180)
  view = viewOf(snapshot, 'today', 'backend', ['claude'], now)
  assert.equal(view.totals.total_tokens, 80); assert.equal(view.timeline.length, 1); assert.equal(view.timeline[0].key, '2026-11-06T10:00'); assert.equal(view.timeline[0].total, 80)
  view = viewOf(snapshot, 'today', 'model', ['shared'], now)
  assert.equal(view.rows.length, 1); assert.equal(view.totals.total_tokens, 150); assert.equal(view.timeline.at(-1).total, 50)
  view = viewOf(snapshot, 'today', 'model', ['shared', 'other'], now)
  assert.equal(view.totals.total_tokens, 180)
  assert.equal(viewOf(snapshot, 'today', 'model', [], now).totals.total_tokens, 0)
  assert.equal(viewOf({ rows, timeline: [] }, 'month', 'model', null, now).timeline.length, 0)
  view = viewOf({ rows, timeline: [{ date: '2025-11', rows }, { date: '2026-11', rows }] }, 'all', 'model', null, now)
  assert.equal(view.timeline.length, 13); assert.equal(view.timeline[0].key, '2025-11'); assert.equal(view.timeline[1].total, 0)
})


test('stacked area boundaries add each selected series and support a single data point', () => {
  const scope = vm.runInNewContext(source + '\n({ usageView, usageAreaPaths, usagePeriod })', { Intl })
  const rows = [{ backend: 'a', model: 'one', total_tokens: 60 }, { backend: 'b', model: 'two', total_tokens: 40 }]
  const view = scope.usageView({ rows, timeline: [{ date: '2026-11-06T10:00', rows }] }, 'today', 'backend', null, new Date(2026, 10, 6, 10, 30))
  const paths = scope.usageAreaPaths(view)
  assert.equal(paths.length, 2)
  assert.match(paths[0].line, /M0.00 47.20 L560.00 47.20/)
  assert.match(paths[1].line, /M0.00 12.00 L560.00 12.00/)
  assert.match(paths[1].area, /L560.00 47.20 L0.00 47.20 Z$/)
  const since = new Date(2026, 10, 6, 8, 20).getTime()
  const custom = scope.usageView({ rows, timeline: [{ date: '2026-11-06T10:00', rows }] }, 'today', 'backend', null, new Date(2026, 10, 6, 10, 30), since)
  assert.equal(custom.timeline[0].key, '2026-11-06T08:00'); assert.equal(custom.timeline[0].total, 0)
  assert.equal(custom.timeline.at(-1).total, 100)
  assert.equal(scope.usagePeriod('custom', since, since + 3600000), 'today')
  assert.equal(scope.usagePeriod('custom', since, since + 7 * 86400000), 'month')
  assert.equal(scope.usagePeriod('custom', since, since + 200 * 86400000), 'all')
})

test('camera menu bars hide only text labels and keep compact geometry aligned with the native panel', () => {
 assert.match(source, /html\[data-kode-menu-camera=true\] \.kode-island-name,html\[data-kode-menu-camera=true\] \.kode-island-period-label\{display:none\}/)
 assert.match(source, /grid-template-columns:24px var\(--kode-camera-gap,200px\) 96px/)
 assert.match(source, /className: 'kode-island-name'/)
 assert.match(source, /className: 'kode-island-period-label'/)
})
