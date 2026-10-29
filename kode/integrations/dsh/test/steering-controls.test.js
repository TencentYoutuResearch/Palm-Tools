import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
function controls() {
  const h = (type, props) => ({ type, props })
  const scope = { h, React: {
    isValidElement: node => Boolean(node.type && node.props),
    cloneElement: (node, props, children) => h(node.type, { ...node.props, ...props, children }),
  } }
  vm.runInNewContext(source.slice(source.indexOf('  function SteeringControls'), source.indexOf('  function useDirectory')), scope)
  return scope.SteeringControls
}

test('unsupported Agent disables only the queue steering button without changing edit, remove or content', () => {
  const render = controls(), click = () => {}, text = 'Keep the complete input'
  const original = { type: 'div', props: { children: [
    { type: 'span', props: { children: text } },
    ...['edit', 'remove', 'steer'].map(action => ({ type: 'button', props: { 'aria-label': action, onClick: click } })),
  ] } }
  const tree = render({ native: () => original, useProjection: () => ({ type: 'codebuddy' }), t: key => key.split('.').at(-1) })
  const children = tree.props.children
  assert.equal(children[0].props.children, text)
  assert.equal(children[1].props.onClick, click)
  assert.equal(children[2].props.onClick, click)
  assert.equal(children[3].props.disabled, true)
  assert.equal(children[3].props.onClick, undefined)
  assert.equal(original.props.children[3].props.disabled, undefined)
})

test('Codex keeps the original queue controls unchanged', () => {
  const tree = { type: 'button', props: { 'aria-label': 'steer', onClick() {} } }
  assert.equal(controls()({ native: () => tree, useProjection: () => ({ type: 'codex' }), t: () => 'steer' }), tree)
})

test('the inert composer retains its component and does not invoke a memo component as a function', () => {
  const native = {}, props = { native, seat: 'conversation.composer.bar', useProjection: () => null }
  const view = controls()(props)
  assert.equal(view.type, native)
  assert.equal(view.props.keyboard, undefined)
})

test('unsupported composer coerces steering to queue and blocks empty-draft queue steering without modifying its input', () => {
  const calls = [], input = { draft: 'Unfinished draft', queue: [{ id: 'queued' }], attachmentIds: ['image'] }
  const keyboard = { submit: (...args) => calls.push(args), steerQueue: () => calls.push('steerQueue'), editor: {} }
  const props = { native() {}, keyboard, useProjection: () => ({ type: 'claude' }),
    useInput: select => select(input), useBusyEnter: select => select('steer') }
  const view = controls()(props)
  view.props.keyboard.submit('steer', 'enter')
  view.props.keyboard.submit('queue', 'click')
  view.props.keyboard.steerQueue()
  assert.deepEqual(calls, [['queue', 'enter'], ['queue', 'click']])
  assert.equal(view.props.keyboard.editor, keyboard.editor)
  assert.equal(view.props.useBusyEnter(value => value), 'queue')
  assert.equal(view.props.useInput(value => value.draft), input.draft)
  assert.equal(view.props.useInput(value => value.attachmentIds), input.attachmentIds)
  assert.equal(view.props.useInput(value => value.queue).length, 0)
  assert.equal(input.queue.length, 1)
  const codex = controls()({ ...props, useProjection: () => ({ type: 'codex' }) })
  assert.equal(codex.props.keyboard, keyboard)
  assert.equal(codex.props.useInput, props.useInput)
})
