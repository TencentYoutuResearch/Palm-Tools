import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
test('model and effort return to the parent menu; repeated Fast switches never dismiss it', () => {
  let cursor = 0, mounted = false
  const state = [], requests = []
  const data = {
    currentProfile: { id: 'agent' }, profiles: [],
    models: [{ id: 'first', provider: 'kode-agent-test', name: 'First', reasoningEfforts: [{ id: 'high' }, { id: 'medium' }], fastCapability: {} }, { id: 'second', provider: 'kode-agent-test' }],
    selection: { provider: 'kode-agent-test', model: 'first', reasoningEffort: 'high' }, fast: false,
  }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const scope = {
    h, Menu: 'Menu', Trigger: 'Trigger', Failure: 'Failure', FastSwitch: 'FastSwitch',
    useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value }] },
    useEffect: fn => { if (!mounted) fn() },
    useDirectory: () => ({ id: 'session', data, busy: false, store: { operate: body => { requests.push(body); return Promise.resolve() } } }),
  }
  vm.runInNewContext(source.slice(source.indexOf('  function ModelControl('), source.indexOf('  async function projectCall')), scope)
  const render = () => { cursor = 0; const tree = scope.ModelControl({ sessionId: 'session', sessions: {} }); mounted = true; return tree.children[0] }
  let menu = render()
  menu.props.anchor.props.onClick(); menu = render(); assert.equal(menu.props.open, true)
  menu.props.onSelect('models'); menu = render(); assert.ok(menu.props.items.some(row => row.id === 'model:1'))
  menu.props.onSelect('model:1'); menu = render()
  assert.equal(menu.props.open, true); assert.ok(menu.props.items.some(row => row.id === 'models'))
  assert.equal(requests.at(-1).model, 'second')
  menu.props.onSelect('effort'); menu = render(); menu.props.onSelect('effort:medium'); menu = render()
  assert.equal(menu.props.open, true); assert.ok(menu.props.items.some(row => row.id === 'models'))
  assert.equal(requests.at(-1).reasoningEffort, 'medium')
  for (const fast of [true, false]) {
    const control = menu.props.items.find(row => row.id === 'fast').label.children[1]
    control.props.onChange(fast); menu = render()
    assert.equal(menu.props.open, true); assert.equal(requests.at(-1).fast, fast)
  }
  menu.props.onClose(); assert.equal(render().props.open, false)
})
