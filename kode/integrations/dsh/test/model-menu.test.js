import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
test('model and effort are native submenus of one stable root; choices and Fast never dismiss it', () => {
  let cursor = 0, mounted = false
  const state = [], requests = []
  const data = {
    currentProfile: { id: 'agent' }, profiles: [],
    models: [{ id: 'first', provider: 'kode-agent-test', name: 'First', reasoningEfforts: [{ id: 'high' }, { id: 'medium' }], fastCapability: {} }, { id: 'second', provider: 'kode-agent-test' }],
    selection: { provider: 'kode-agent-test', model: 'first', reasoningEffort: 'high' }, fast: false,
  }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const scope = {
    h, Menu: 'Menu', Trigger: 'Trigger', Failure: 'Failure', FastSwitch: 'FastSwitch', IconCheckOutlineRegular: 'Check', React: {}, document: { activeElement: null },
    useRef: initial => { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index] },
    useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value }] },
    useEffect: fn => { if (!mounted) fn() },
    useDirectory: () => ({ id: 'session', data, busy: false, store: { load: () => Promise.resolve(), operate: body => { requests.push(body); return Promise.resolve() } } }),
  }
  vm.runInNewContext(source.slice(source.indexOf('  // Model and effort open as native submenus'), source.indexOf('  async function projectCall')), scope)
  const render = () => { cursor = 0; const tree = scope.ModelControl({ sessionId: 'session', sessions: {} }); mounted = true; return tree.children[0] }
  let menu = render()
  menu.props.anchor.props.onClick(); menu = render(); assert.equal(menu.props.open, true)
  assert.deepEqual(Array.from(menu.props.items.filter(row => row.id), row => row.id), ['models', 'effort', 'fast', 'reload'])
  assert.equal(menu.props.listClassName, 'kode-model-menu'); assert.equal(menu.props.submenuBackLabel, '模型与参数')
  const models = menu.props.items.find(row => row.id === 'models').submenu
  assert.deepEqual(Array.from(models, row => row.id), ['model:0', 'model:1'])
  assert.equal(models[0].icon.type, 'Check'); assert.notEqual(models[1].icon.type, 'Check', 'only the current model carries the check')
  menu.props.onSelect('model:0'); assert.equal(requests.length, 0, 'choosing the current model sends nothing')
  menu.props.onSelect('model:1'); menu = render()
  assert.equal(menu.props.open, true); assert.equal(requests.at(-1).model, 'second')
  assert.deepEqual(Array.from(menu.props.items.find(row => row.id === 'effort').submenu, row => row.id), ['effort:high', 'effort:medium'])
  menu.props.onSelect('effort:medium'); menu = render()
  assert.equal(menu.props.open, true); assert.equal(requests.at(-1).reasoningEffort, 'medium')
  for (const fast of [true, false]) {
    const control = menu.props.items.find(row => row.id === 'fast').label.children[1]
    control.props.onChange(fast); menu = render()
    assert.equal(menu.props.open, true); assert.equal(requests.at(-1).fast, fast)
  }
  menu.props.onSelect('reload'); assert.equal(render().props.open, false)
})

test('model submenu motion is short, does not replay on selection and respects reduced motion', () => {
  const rule = /\[role=menu\]:has\(>\[role=presentation\]>\*>\[role=menuitem\] \.kode-model-choice\)\{min-width:200px;animation:kode-model-submenu-in 140ms cubic-bezier\(\.3,\.9,\.25,1\)\}/
  assert.match(source, rule)
  assert.doesNotMatch(source, /data-submenu-layout[^{]*kode-model-choice/, 'the layout attribute is re-set on every measure and would restart the animation')
  assert.match(source, /@media\(prefers-reduced-motion:reduce\)\{\[role=menu\]:has\([^{]*kode-model-choice\)\{animation:none\}\}/)
  assert.match(source, /\.kode-model-menu\{min-width:240px\}/)
  assert.match(source, /chosen\.current = document\.activeElement/)
})
