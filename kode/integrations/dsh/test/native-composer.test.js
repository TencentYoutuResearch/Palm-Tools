import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

const extension = await readFile(new URL('../patches/dsh-conversation-0.2.1-rc.5/extension.js', import.meta.url), 'utf8')
function mount(overrides = {}) {
  const effects = [], states = [], edits = []
  let runtime, handlers
  const rootEvents = new Map()
  const root = { addEventListener(name, fn) { rootEvents.set(name, fn) }, removeEventListener(name) { rootEvents.delete(name) } }
  class Runtime {
    constructor(deps) { this.deps = deps; this.projection = { clipboardText: '' }; this.editor = { isComposing: () => false, registerRootListener(fn) { fn(root, null); return () => fn(null, root) } }; runtime = this }
    register() { return () => {} }
    refreshProjection() {}
    clearHistory() {}
    setDraft(text) { this.projection.clipboardText = text; this.deps.onUpdate() }
    paste(text) { this.setDraft(this.projection.clipboardText + text) }
  }
  const react = {
    useRef: value => ({ current: value }),
    useState: value => [value, update => states.push(update)],
    useLayoutEffect: fn => effects.push(fn),
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const context = { queueMicrotask, react, DraftEditorRuntime: Runtime, DraftEditor() {}, InputBar_module_css_default: {}, exports: {}, registerComposerKeymap(_editor, value) { handlers = value; return () => {} } }
  vm.createContext(context)
  vm.runInContext(extension + '\nthis.mount = PortableTextComposerInstance;', context)
  const props = { scopeKey: 'workspace:channel:thread', value: 'hello', ariaLabel: 'Reply', onChange: text => edits.push(text), onSubmit: async () => {}, ...overrides }
  const tree = context.mount(props)
  const cleanup = effects.map(fn => fn()).filter(Boolean)
  return { runtime, handlers, tree, states, edits, cleanup, rootEvents, api: context.exports }
}

test('native adapter exports a scoped contract with native attachment/activity seats', () => {
  const { api } = mount()
  assert.deepEqual(Object.keys(api).sort(), ['PortableTextComposer', 'apply', 'portableComposerCapabilities'])
  assert.equal(api.portableComposerCapabilities.attachments, true)
  assert.equal(api.portableComposerCapabilities.voice, true)
  assert.equal(api.portableComposerCapabilities.header, true)
  assert.throws(() => api.PortableTextComposer({ value: '' }), /requires/)
  assert.equal(api.PortableTextComposer({ scopeKey: 'b', value: '', ariaLabel: 'Reply' }).props.key, 'b')
})
test('synchronous guard prevents duplicate submission and preserves scope/text', async () => {
  let release, count = 0, request
  const pending = new Promise(resolve => { release = resolve })
  const { handlers } = mount({ onSubmit: async value => { count++; request = value; await pending } })
  const first = handlers.submit()
  await handlers.submit()
  assert.equal(count, 1)
  assert.equal(request.scopeKey, 'workspace:channel:thread')
  assert.equal(request.text, 'hello')
  assert.ok(Object.isFrozen(request))
  release(); await first
  assert.equal(handlers.canSubmit(), true)
})
test('failed submit stays retryable and surfaces an error without clearing draft', async () => {
  const { handlers, states, runtime } = mount({ onSubmit: async () => { throw Error('offline') } })
  await handlers.submit()
  assert.ok(states.some(value => typeof value === 'string' && value.includes('发送尚未确认')))
  assert.equal(runtime.projection.clipboardText, 'hello')
  assert.equal(handlers.canSubmit(), true)
})
test('length boundary rejects oversized sends without truncating user text', async () => {
  let count = 0
  const { handlers, runtime, states, edits } = mount({ maxLength: 6, onSubmit: async () => { count++ } })
  handlers.pasteText('!!')
  assert.equal(runtime.projection.clipboardText, 'hello!!')
  assert.equal(handlers.canSubmit(), false)
  await handlers.submit(); assert.equal(count, 0)
  assert.equal(runtime.projection.clipboardText, 'hello')
  assert.ok(states.some(value => typeof value === 'string' && value.includes('6')))
  assert.deepEqual(edits, [])
  runtime.setDraft('short'); assert.deepEqual(edits, ['short'])
  await handlers.submit(); assert.equal(count, 1)
})
test('65536 is a hard ceiling even when a caller asks for more', async () => {
  let sent = 0
  const { runtime, handlers } = mount({ maxLength: 999999, onSubmit: async () => { sent++ } })
  runtime.setDraft('a'.repeat(65536)); await handlers.submit(); assert.equal(sent, 1)
  runtime.setDraft('a'.repeat(65537)); await handlers.submit(); assert.equal(sent, 1)
  assert.equal(runtime.projection.clipboardText.length, 65536)
})

test('oversized paste rejects the entire edit and retains the durable draft across scope changes', async () => {
  const original = 'a'.repeat(65000)
  let saved = original
  const first = mount({ value: original, onChange: text => { saved = text } })
  first.handlers.pasteText('b'.repeat(1000))
  assert.equal(first.handlers.canSubmit(), false)
  await Promise.resolve()
  assert.equal(first.runtime.projection.clipboardText, original)
  assert.equal(saved, original)
  assert.ok(first.states.some(value => typeof value === 'string' && value.includes('本次超限输入未加入草稿，原草稿已保留')))
  first.cleanup.forEach(fn => fn())
  const other = mount({ scopeKey: 'other', value: 'other draft' })
  other.cleanup.forEach(fn => fn())
  const returned = mount({ value: saved, onChange: text => { saved = text } })
  assert.equal(returned.runtime.projection.clipboardText, original)
  returned.runtime.setDraft('short')
  assert.equal(saved, 'short')
  returned.handlers.pasteText(' safe')
  assert.equal(saved, 'short safe')
  assert.equal(returned.handlers.canSubmit(), true)
})

test('boundary append and committed Chinese IME edits restore the latest accepted revision', async () => {
  const base = 'a'.repeat(65534), changes = []
  const state = mount({ value: base, onChange: value => changes.push(value) })
  // Native onUpdate receives committed IME text; props have not rerendered yet.
  state.runtime.setDraft(base + '中文')
  assert.equal(changes.at(-1), base + '中文')
  state.runtime.setDraft(base + '中文再')
  assert.equal(state.handlers.canSubmit(), false)
  await Promise.resolve()
  assert.equal(state.runtime.projection.clipboardText, base + '中文')
  assert.equal(changes.length, 1)
  state.handlers.pasteText('!')
  await Promise.resolve()
  assert.equal(state.runtime.projection.clipboardText, base + '中文')
  assert.equal(changes.length, 1)
  state.runtime.setDraft('短稿')
  assert.equal(changes.at(-1), '短稿')
  assert.equal(state.handlers.canSubmit(), true)
})


test('IME preedit is never saved and oversized composition restores the pre-composition draft', async () => {
  const original = 'a'.repeat(65535), changes = []
  const state = mount({ value: original, onChange: text => changes.push(text) })
  state.rootEvents.get('compositionstart')()
  state.runtime.setDraft(original + 'a')
  assert.equal(changes.length, 0)
  state.runtime.setDraft(original + '中文')
  await Promise.resolve()
  assert.equal(state.runtime.projection.clipboardText, original + '中文', 'do not interrupt live IME')
  assert.equal(changes.length, 0)
  state.rootEvents.get('compositionend')()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(state.runtime.projection.clipboardText, original)
  assert.equal(changes.length, 0)
  state.runtime.setDraft('short')
  state.rootEvents.get('compositionstart')()
  state.runtime.setDraft('shortzhongwen')
  state.runtime.setDraft('short中文')
  assert.equal(changes.at(-1), 'short')
  state.rootEvents.get('compositionend')()
  await Promise.resolve()
  assert.equal(changes.at(-1), 'short中文')
})

test('returning to the controlled value refreshes the rollback baseline before props rerender', async () => {
  const state = mount({ value: 'hello', maxLength: 6 })
  state.runtime.setDraft('helloa')
  state.runtime.setDraft('hello')
  state.handlers.pasteText('!!')
  await Promise.resolve()
  assert.equal(state.runtime.projection.clipboardText, 'hello')
})

test('oversized preloaded value remains intact, unsendable and explicitly unsaved', async () => {
  const original = 'a'.repeat(65537)
  const state = mount({ value: original })
  assert.equal(state.runtime.projection.clipboardText, original)
  assert.equal(state.handlers.canSubmit(), false)
  assert.ok(state.states.some(value => typeof value === 'string' && value.includes('尚未保存，不能发送')))
  state.runtime.setDraft('recovered')
  assert.deepEqual(state.edits, ['recovered'])
  assert.equal(state.handlers.canSubmit(), true)
})

test('disabled/read-only block sending; uncertain drafts allow retry but no paste', async () => {
  for (const flag of ['disabled', 'readOnly']) {
    const { handlers, runtime } = mount({ [flag]: true })
    assert.equal(handlers.canSubmit(), false)
    handlers.pasteText('extra'); assert.equal(runtime.projection.clipboardText, 'hello')
  }
  const { handlers, runtime, states } = mount({ editingDisabled: true })
  handlers.pasteText('extra'); assert.equal(runtime.projection.clipboardText, 'hello')
  assert.equal(handlers.canSubmit(), true)
  handlers.intakeFiles(); assert.ok(states.some(value => typeof value === 'string' && value.includes('文件未上传')))
})
test('production artifact is pinned, independently named and does not register Conversation', async () => {
  const base = new URL('../', import.meta.url)
  const lock = JSON.parse(await readFile(new URL('packages/composer/upstream-lock.json', base)))
  const sha = value => createHash('sha256').update(value).digest('hex')
  assert.equal(lock.extensionSha256, sha(extension))
  assert.equal(lock.clientSha256, sha(await readFile(new URL('node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', base))))
  const output = await readFile(new URL('packages/composer/client.js', base), 'utf8')
  assert.match(output, /id:'@kode\/dsh-composer'/)
  assert.doesNotMatch(output, /ctx\.plugin|slots\.inject|ConversationController/)
  assert.match(output, /function registerComposerKeymap/)
  assert.match(output, /function DraftEditor/)
  assert.match(output, /InputBar\.module\.css/)
  assert.doesNotMatch(output, /createElement\(["']textarea/)
})

test('native keymap retains Enter, Shift+Enter, IME, repeat and plain-text paste semantics', async () => {
  const source = await readFile(new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('\t\tfunction isComposingEvent(')
  const code = source.slice(start, source.indexOf('\t\t//#endregion', start))
  const commands = new Map(), events = new Map()
  const context = { Date, Eu: (...dispose) => () => dispose.forEach(fn => fn()) }
  for (const [, symbol] of code.matchAll(/editor\.registerCommand\(([\w$]+),/g)) context[symbol] = symbol
  vm.createContext(context)
  vm.runInContext(code, context)
  const root = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener() {}, toggleAttribute() {} }
  const editor = { registerRootListener(fn) { fn(root, null); return () => {} }, registerUpdateListener() { return () => {} }, registerCommand(key, fn) { commands.set(key, fn); return () => {} }, isComposing: () => false, update(_fn, options) { options.onUpdate() } }
  let sent = 0, pasted = '', files = 0
  context.registerComposerKeymap(editor, { arbitrate: () => 'pass', dismissPopup() {}, space: () => false, canSubmit: () => true, submit() { sent++ }, pasteText(text) { pasted = text }, intakeFiles(value) { files += value.length } })
  const event = changes => ({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, repeat: false, keyCode: 13, getModifierState: () => false, preventDefault() {}, ...changes })
  const enter = commands.get('cn$1')
  assert.equal(enter(event({ shiftKey: true })), false); assert.equal(sent, 0)
  enter(event({ isComposing: true })); enter(event({ keyCode: 229 })); enter(event({ repeat: true })); assert.equal(sent, 0)
  events.get('compositionstart')(); enter(event({})); assert.equal(sent, 0)
  events.get('compositionend')(); enter(event({})); assert.equal(sent, 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  enter(event({})); assert.equal(sent, 1)
  let prevented = false
  commands.get('Je$2')({ clipboardData: { items: [], getData: type => type === 'text/plain' ? 'hello\nworld' : '<b>hello</b>' }, preventDefault() { prevented = true } })
  assert.equal(pasted, 'hello\nworld'); assert.equal(prevented, true)
  commands.get('Je$2')({ clipboardData: { items: [{ kind: 'file', getAsFile: () => ({ name: 'test.png' }) }], getData: () => '' }, preventDefault() {} })
  assert.equal(files, 1)
})
test('attachment seat stages only through a caller that declared support, never uploads', () => {
  const added = [], file = { name: 'a.png', size: 1 }
  const refused = mount({ attachments: { items: [], canAccept: false, unsupportedLabel: '当前对话不支持图片', onAdd: files => added.push(files), onRemove() {} } })
  refused.handlers.intakeFiles([file])
  assert.equal(added.length, 0); assert.ok(refused.states.includes('当前对话不支持图片'))
  const ok = mount({ attachments: { items: [], canAccept: true, onAdd: files => added.push(files), onRemove() {} } })
  ok.handlers.intakeFiles([file]); assert.equal(added.length, 1); assert.equal(added[0][0], file)
  const locked = mount({ editingDisabled: true, attachments: { items: [], canAccept: true, onAdd: files => added.push(files), onRemove() {} } })
  locked.handlers.intakeFiles([file]); assert.equal(added.length, 1)
})
test('image-only drafts can be sent and the receipt carries exact attachment identities', async () => {
  const sent = []
  const { handlers } = mount({ value: '', attachments: { items: [{ id: 'img-1', kind: 'image', file: {} }], canAccept: true, onAdd() {}, onRemove() {} }, onSubmit: async request => { sent.push(request) } })
  assert.equal(handlers.canSubmit(), true)
  await handlers.submit()
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ scopeKey: 'workspace:channel:thread', text: '', attachmentIds: ['img-1'] }])
})
test('native voice activity inserts a transcript only into the unchanged captured draft', () => {
  let seat
  const { runtime, edits } = mount({ renderActivity: props => { seat = props; return null } })
  assert.equal(typeof seat.onActiveChange, 'function'); assert.equal(seat.locked, false)
  const span = seat.inputActions.captureInsertion()
  assert.equal(seat.inputActions.insertText('语音补充', span), true)
  assert.equal(runtime.projection.clipboardText, 'hello 语音补充'); assert.deepEqual(edits.at(-1), 'hello 语音补充')
  const stale = seat.inputActions.captureInsertion()
  runtime.setDraft('用户继续输入')
  assert.equal(seat.inputActions.insertText('迟到的转写', stale), false)
  assert.equal(runtime.projection.clipboardText, '用户继续输入')
  let locked
  mount({ editingDisabled: true, renderActivity: props => { locked = props; return null } })
  assert.equal(locked.locked, true)
  assert.equal(locked.inputActions.insertText('x', locked.inputActions.captureInsertion()), false)
})
