import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { Session, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { buildHistorySeed } from '../src/native-history.js'
import { HISTORY_EDIT, HISTORY_CONTEXT_BYTES, HistoryEditor, branchHistoryInput, editedHistoryInput, editedMessage, historyEditProjection, historyEditSurface } from '../src/history-edit.js'

const selection = { provider: 'kode-agent-fixture', model: 'fixture' }
const timeline = [
  { kind: 'text', role: 'user', text: 'EARLIER_QUESTION' },
  { kind: 'text', role: 'agent', text: 'EARLIER_ANSWER' },
  { kind: 'text', role: 'user', text: 'ORIGINAL_TO_EDIT' },
  { kind: 'text', role: 'agent', text: 'EXCLUDED_ANSWER' },
  { kind: 'text', role: 'user', text: 'EXCLUDED_FUTURE' },
]
function history() { return buildHistorySeed({ timeline }, selection) }
const targetSeq = events => events.find(event => event.type === 'user/message' && event.data.content[0].text === 'ORIGINAL_TO_EDIT').seq

function commitEdit(session, seq, text, hash = 'a') {
  const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
  const message = { ...editedMessage(session.snapshotEvents(), seq, text), id: 'history-edit-' + seq + '-' + hash.repeat(64) }
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const edit = session.append('user/message', message, historyEditSurface(session, message))
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return edit
}

test('the released reader and surface retain the active prefix after repeated edits', () => {
  const events = history(), session = Session.create('source', events)
  const edit = commitEdit(session, targetSeq(events), 'replacement')
  commitEdit(session, edit.seq, 'replacement again', 'b')
  const stored = session.snapshotEvents()
  assert.deepEqual(stored.slice(0, events.length), events)
  assert.doesNotThrow(() => assertReleasedV4Relationships({ header: session.header, events: stored, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES))
  const restored = Session.create('source', stored)
  assert.deepEqual(restored.deriveMessages().map(message => message.content[0].text),
    ['EARLIER_QUESTION', 'EARLIER_ANSWER', 'replacement again'])
  assert.equal(restored.id, 'source')
  const { ranges } = stored.reduce(historyEditProjection.apply, historyEditProjection.init())
  assert.ok(ranges.some(range => range.from <= targetSeq(events) && range.through >= events.length - 1))
  assert.ok(ranges.some(range => range.from <= edit.seq && range.through >= edit.seq))
})

test('a long fallback request contains a bounded prefix without historical attachment bodies', () => {
  const prompts = Array.from({ length: 20 }, (_, n) => [
    { kind: 'text', role: 'user', text: 'question ' + n },
    { kind: 'text', role: 'agent', text: '回复'.repeat(9000) },
  ]).flat()
  const events = buildHistorySeed({ timeline: [...prompts, ...timeline] }, selection)
  const session = Session.create('source', events), edit = commitEdit(session, targetSeq(events), 'replacement')
  const result = editedHistoryInput(session, edit)[0].text
  assert.ok(Buffer.byteLength(result) <= HISTORY_CONTEXT_BYTES)
  assert.match(result, /EARLIER_QUESTION/)
  assert.match(result, /EARLIER_ANSWER/)
  assert.doesNotMatch(result, /ORIGINAL_TO_EDIT|EXCLUDED/)
  // Branches created by previous Kode builds still deliver a pending prefix.
  const seq = targetSeq(events), legacy = events.slice(0, seq)
  legacy.push({ seq, time: 0, type: HISTORY_EDIT, data: {}, ignorable: true })
  const oldBranch = Session.create('old-branch', legacy)
  assert.equal(branchHistoryInput(oldBranch, { historyBranch: true })[0].text, result)
  assert.deepEqual(branchHistoryInput(oldBranch, { historyBranch: true, historyBootstrapped: true }), [])
})

test('editing preserves attachments while refusing injected/replacement/non-user rows and blank text', () => {
  const events = history(), seq = targetSeq(events), message = events[seq].data
  const image = { type: 'image', attachment: { id: 'image' } }, file = { type: 'file', attachment: { id: 'file' } }
  message.content = [image, { type: 'text', text: 'one' }, file, { type: 'text', text: 'two' }]
  const changed = editedMessage(events, seq, 'new')
  assert.deepEqual(changed.content, [image, { type: 'text', text: 'new' }, file])
  assert.equal(message.content.length, 4)
  for (const value of ['', ' ', 'x'.repeat(64001)]) assert.throws(() => editedMessage(events, seq, value))
  assert.throws(() => editedMessage(events, -1, 'new'))
  assert.throws(() => editedMessage(events, seq + 1, 'new'))
  events[seq] = { ...events[seq], surfaceOp: { op: 'replace', start: 0, end: 0 } }
  assert.throws(() => editedMessage(events, seq, 'new'))
  events[seq].surfaceOp = 'append'; message.source = { kind: 'agent-message' }
  assert.throws(() => editedMessage(events, seq, 'new'))
})

test('edit requests deduplicate without creating or reopening a session', async () => {
  const session = Session.create('source', history()), nextTurn = [], nextStep = []
  let didFail = false, flushes = 0
  const agent = { id: 'source', isKodeNativeAgent: true, status: 'idle', session, inbox: { nextTurn, nextStep }, runtime: { adapter: {} },
    ctx: { sessionProjections: { stateOf: () => null }, sessions: { flush: async () => { flushes++; if (!didFail) { didFail = true; throw new Error('flush interrupted') } } } },
    followup(message) { nextTurn.push(message) },
  }
  const controller = { resolveAgent: async id => { assert.equal(id, agent.id); return { agent } } }
  const ctx = { get: name => name === 'sessionController' ? controller : undefined }
  const editor = new HistoryEditor(ctx), input = { sessionId: 'source', requestId: 'same-request-001', seq: targetSeq(history()), text: 'EDITED_REQUEST' }
  agent.status = 'running'
  await assert.rejects(editor.edit(input), /当前任务/)
  agent.status = 'idle'
  const first = editor.edit(input); assert.equal(editor.edit(input), first)
  await assert.rejects(first, /flush interrupted/)
  assert.deepEqual(await new HistoryEditor(ctx).edit(input), { sessionId: 'source' })
  assert.equal(nextTurn.length, 1)
  assert.equal(nextTurn[0].content[0].text, 'EDITED_REQUEST')
  assert.equal(flushes, 2)
  await assert.rejects(editor.edit({ ...input, text: 'different' }), /其他内容/)
})

for (const type of ['codex', 'legacy-codex', 'claude', 'cursor', 'codebuddy', 'custom', 'custom-codex', 'dsh']) test(type + ' continues the same edited conversation after runtime restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-history-wire-')), log = join(root, 'rpc.jsonl')
  const codex = ['codex', 'legacy-codex', 'custom-codex'].includes(type), model = codex ? 'fixture' : 'fixture-fast'
  const nativeCodex = type === 'codex' || type === 'legacy-codex'
  const fixture = fileURLToPath(new URL(codex ? './fixture-codex-server.js' : './fixture-acp-server.js', import.meta.url))
  const profile = { id: 'fixture', name: type, type: type === 'legacy-codex' ? 'codex' : type === 'custom-codex' ? 'custom' : type,
    ...(type === 'custom-codex' ? { protocol: 'codex' } : {}), executable: process.execPath, args: [fixture],
    env: { KODE_FIXTURE_RPC_LOG: log, KODE_ACP_FIXTURE_LOG: log,
      KODE_FIXTURE_HISTORY_REVERT: type === 'legacy-codex' ? 'legacy' : 'current', KODE_ACP_FORK_AT: type === 'claude' ? '1' : '0' },
  }
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([profile])
  const events = history(), seq = targetSeq(events)
  if (nativeCodex) {
    events.splice(seq + 1, 0, { type: 'plugin:kode/native-event', ignorable: true, time: 0, data: { event: {
      method: 'turn/started', params: { threadId: 'original-thread', turn: { id: 'original-turn' } },
    } } })
    events.forEach((event, index) => { event.seq = index })
  }
  const session = Session.create('source', events, { ...Session.create('source').header, cwd: root })
  const edit = commitEdit(session, seq, 'EDITED_REQUEST')
  await profiles.bind('source', 'fixture')
  await profiles.patchBinding('source', { threadId: 'original-thread', seenInputs: events.filter(event => event.type === 'user/message').map(event => event.data.id) })
  const agent = { id: 'source', session, ctx: { sessions: { flush: async () => {} }, parallel: async () => {}, get: () => undefined,
    tools: { execute: async () => { throw new Error('historical tools must not execute') } } } }
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined }, sessionProjections: { stateOf: () => ({ lastTurn: 3, lastStepBoundary: { kind: 'start', step: 1 } }) } }
  const options = { recordNative: () => {}, resolveProfile: async p => ['dsh', 'claude'].includes(type)
    ? { ...profile, type: 'custom', protocol: 'acp' } : p }
  let adapter = new AgentRuntimeAdapter(ctx, profiles, options)
  const send = async (id, text) => { for await (const _ of adapter.stream({ sessionId: 'source', provider: profileRoute('fixture'),
    model, tools: [], messages: [{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], signal: AbortSignal.timeout(10000) })) {} }
  try {
    await send(edit.data.id, 'EDITED_REQUEST')
    await adapter.close()
    const reopened = await new AgentProfiles(profiles.path).open()
    adapter = new AgentRuntimeAdapter(ctx, reopened, options)
    await send('later', 'FOLLOWUP')
    const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    const requests = rows.filter(row => row.method === (codex ? 'turn/start' : 'session/prompt'))
    assert.equal(requests.length, 2)
    const first = JSON.stringify(requests[0])
    assert.match(first, /EDITED_REQUEST/)
    assert.doesNotMatch(first, /ORIGINAL_TO_EDIT|EXCLUDED/)
    assert.match(JSON.stringify(requests[1]), /FOLLOWUP/)
    assert.doesNotMatch(JSON.stringify(requests[1]), /EARLIER_QUESTION/)
    assert.equal(reopened.binding('source').historyEditId, edit.data.id)
    assert.equal(reopened.binding('source').historyEditBootstrap, false)
    if (nativeCodex) {
      assert.equal(reopened.binding('source').threadId, 'original-thread')
      assert.equal(rows.filter(row => row.method === 'thread/start').length, 0)
      assert.equal(rows.find(row => row.method === 'thread/revert').params.beforeTurnId, 'original-turn')
      if (type === 'legacy-codex') assert.equal(rows.find(row => row.method === 'thread/rollback').params.numTurns, 2)
      assert.doesNotMatch(first, /EARLIER_QUESTION|EARLIER_ANSWER/)
    } else if (type === 'claude') {
      assert.equal(reopened.binding('source').threadId, 'fixture-checkpoint-thread')
      assert.equal(rows.find(row => row.method === 'session/fork').params._meta.jetbrains.air.fork.messageId, 'prior-assistant')
      assert.equal(rows.filter(row => row.method === 'session/new').length, 0)
      assert.doesNotMatch(first, /EARLIER_QUESTION|EARLIER_ANSWER/)
    } else {
      assert.equal(rows.filter(row => row.method === (codex ? 'thread/start' : 'session/new')).length, 1)
      assert.equal(rows.filter(row => row.method === (codex ? 'thread/resume' : 'session/load')).length, 1)
      assert.deepEqual(reopened.binding('source').supersededThreads, ['original-thread'])
      assert.match(first, /EARLIER_QUESTION/)
      assert.match(first, /EARLIER_ANSWER/)
    }
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

test('history editor shares native icon actions, edits inline, and retains drafts for retry', async () => {
  const source = await readFile(new URL('../packages/chat/history-edit.js', import.meta.url), 'utf8')
  let cursor = 0, uuid = 0, calls = 0, reject = true
  const state = [], slots = []
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useLayoutEffect: () => {},
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value }] },
    useRef: initial => { const i = cursor++; return state[i] ??= { current: initial } } }
  const editor = vm.runInNewContext(source + '\nHistoryEditableMessage', { react,
    _deepseek_ai_dsh_client_ui_primitives: { Button: 'button', Tooltip: 'tooltip', IconEditOutlineRegular: 'edit' },
    MessageIconActions_module_css_default: { action: 'native-copy-action' }, MessageItem_module_css_default: { userRow: 'native-user-row' },
    contentParts: content => ({ attachments: content.filter(part => part.type !== 'text') }), crypto: { randomUUID: () => String(++uuid) } })
  const attachment = { type: 'image', attachment: { attachmentId: 'fixture' } }
  const props = { native: 'native', node: { data: { seq: 3, source: { kind: 'human' }, content: [{ type: 'text', text: 'original' }, attachment] } }, useAccess: () => true,
    renderFactorySlot: (seat, props) => ({ type: 'attachments', props: { seat, ...props } }),
    editHistory: async (...args) => { calls++; slots.push(args); if (reject) throw new Error('offline') } }
  const render = (extra = {}) => { cursor = 0; return editor({ ...props, ...extra }) }
  const find = (node, predicate) => node && typeof node === 'object' ? predicate(node) ? node : [...(node.children ?? []), node.props?.historyEditAction].map(child => find(child, predicate)).find(Boolean) : undefined
  const editButton = tree => find(tree, node => node.props['aria-label'] === '编辑消息')
  const button = (tree, label) => find(tree, node => node.type === 'button' && node.children.includes(label))
  let tree = render(); assert.equal(tree.type, 'native'); assert.equal(tree.props.node, props.node)
  assert.equal(editButton(tree).props.className, 'native-copy-action')
  assert.equal(editButton(tree).children[0].type, 'edit'); assert.equal(editButton(tree).children.length, 1)
  editButton(tree).props.onClick()
  tree = render(); assert.equal(tree.props['data-kode-history-editing'], true)
  assert.equal(find(tree, node => node.type === 'modal'), undefined)
  assert.equal(find(tree, node => node.type === 'native'), undefined)
  assert.equal(find(tree, node => node.type === 'attachments').props.content.attachments[0], attachment)
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'edited' } })
  tree = render()
  const key = { key: 'Enter', metaKey: true, preventDefault() {} }
  const send = () => find(tree, node => node.type === 'textarea').props.onKeyDown(key)
  send(); send(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1)
  tree = render(); assert.ok(find(tree, node => node.props.role === 'alert'))
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'edited')
  reject = false; find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(slots[0], slots[1]); assert.equal(render().type, 'native')
  editButton(render()).props.onClick(); tree = render(); button(tree, '取消').props.onClick(); assert.equal(render().type, 'native')
  editButton(render()).props.onClick(); tree = render()
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: ' ' } })
  tree = render(); assert.equal(button(tree, '重新发送').props.disabled, true)
  find(tree, node => node.type === 'textarea').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  assert.equal(render().type, 'native')
  assert.equal(editButton(render({ useAccess: () => false })), undefined)
  assert.equal(editButton(render({ node: { data: { ...props.node.data, source: { kind: 'agent-message' } } } })), undefined)
})


test('history edits keep the host selected when the editor opened and refuse a later host switch', async () => {
  const source = await readFile(new URL('../packages/chat/history-edit.js', import.meta.url), 'utf8')
  const bind = vm.runInNewContext(source + '\nhistoryEditBinding')
  const requests = [], opened = [], transport = { current: 'remote:fixture.example', fetch: async (url, options, host) => { requests.push({ url, options, host }); return { ok: true, json: async () => ({ sessionId: 'source' }) } } }
  const binding = bind({ get: name => name === 'kodeTransport' ? transport : { openSession: id => opened.push(id) } }, 'source')
  const host = binding.historyHost()
  transport.current = 'local'
  await assert.rejects(binding.editHistory(5, 'edited', 'request', host), /主机已切换/)
  assert.equal(requests.length, 0)
  transport.current = host
  await binding.editHistory(5, 'edited', 'request', host)
  assert.equal(requests[0].host, host); assert.deepEqual(opened, [])
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'edit-message-in-place', sessionId: 'source', seq: 5, text: 'edited', requestId: 'request' })
  transport.fetch = async () => { transport.current = 'local'; return { ok: true, json: async () => ({ sessionId: 'other-child' }) } }
  await assert.rejects(binding.editHistory(5, 'edited', 'request', host), /不同的会话/)
  assert.deepEqual(opened, [])
})
