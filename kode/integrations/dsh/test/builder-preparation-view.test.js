import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { builderPreparationSteps, resolveBuilderPreparation } from '../packages/collab/builder-preparation-model.js'

const source = (await readFile(new URL('../packages/collab/builder-preparation-view.js', import.meta.url), 'utf8'))
  .replace(/^import .*$/gm, '').replace('export function BuilderPreparationView', 'function BuilderPreparationView')
const workspace = { host_id: 'home', workspace_id: 'project', root_ref: '/fixture/project' }
const draft = { id: 'draft', home_hub: 'home', revision: 1, status: 'draft', interview: { workspace_refs: [workspace] } }
const selection = { revision: 1, draft_revision: 1, selection: { profile_id: 'builder', provider: 'provider', model: 'model', workspace } }
const base = { draftId: 'draft', home: 'home', draftRevision: 1, selection, funding: null, resources: [{ host: 'home', resource_kind: 'execution_profile', profile_id: 'builder', account: { id: 'owner', current: true } }] }

function render({ snapshot = base, editing = null, loading = false } = {}) {
  const states = [snapshot, loading, '', editing], effects = [], readiness = []
  let index = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: () => [states[index++], () => {}],
    useReducer: () => [0, () => {}],
    useRef: current => ({ current }),
    useEffect: fn => effects.push(fn),
  }
  const context = { React, Button: 'Button', BuilderWorkspaceForm: 'Workspace', BuilderSelectionForm: 'Selection', BuilderAccountForm: 'Account', BuilderFundingForm: 'Funding', builderPreparationSteps, resolveBuilderPreparation, readBuilderPreparation() {}, setTimeout, clearTimeout, Date }
  vm.createContext(context)
  vm.runInContext(source + '\nthis.render = BuilderPreparationView;', context)
  const tree = context.render({ draft, storage: {}, request() {}, onReady: value => readiness.push(value) })
  effects[1]()
  const find = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => find(child, predicate))]
  return { tree, readiness, steps: find(tree, node => node.props.className === 'kode-builder-preparation-step'), forms: find(tree, node => ['Workspace', 'Selection', 'Account', 'Funding'].includes(node.type)), buttons: find(tree, node => node.type === 'Button') }
}

test('only the current preparation task is visible while all form instances stay mounted', () => {
  const result = render()
  assert.equal(result.forms.length, 4)
  assert.deepEqual(result.steps.filter(row => !row.props.hidden).map(row => row.props.key), ['funding'])
  assert.deepEqual(result.readiness, [false])
})

test('editing an already confirmed step does not reveal other forms', () => {
  const result = render({ editing: 'workspace' })
  assert.equal(result.forms.length, 4)
  assert.deepEqual(result.steps.filter(row => !row.props.hidden).map(row => row.props.key), ['workspace'])
  assert.deepEqual(result.readiness, [false])
})

test('accepted funding locks prior setup and reveals only explicit start confirmation readiness', () => {
  const funding = { request: { draft_revision: 1, selection_revision: 1 }, selection, budget: { unit: 'credits', limit: 100, starts_at: 1, ends_at: Date.now() + 100000 }, grant: { policy: { enabled: true, expires_at: Date.now() + 100000 } } }
  const result = render({ snapshot: { ...base, funding } })
  assert.equal(result.forms.length, 4)
  assert.equal(result.steps.filter(row => !row.props.hidden).length, 0)
  assert.equal(result.buttons.filter(row => row.props['aria-label']?.startsWith('修改')).length, 0)
  assert.deepEqual(result.readiness, [true])
})

test('a stale snapshot never re-enables startup while a changed draft is being read', () => {
  const result = render({ snapshot: { ...base, draftRevision: 0 } })
  assert.equal(result.steps.filter(row => !row.props.hidden).length, 0)
  assert.deepEqual(result.readiness, [false])
})
