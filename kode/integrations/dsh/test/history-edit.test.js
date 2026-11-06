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
import { HISTORY_EDIT, HistoryEditor, editedMessage, editBranchSeed, branchHistoryInput } from '../src/history-edit.js'

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

test('exact edit prefix survives the released reader, quotes prior context only, and cancels inherited queued inputs', async () => {
  const events = history(), seq = targetSeq(events)
  // Simulate a later prompt queued before the message being edited was admitted.
  events.splice(seq - 1, 0, { type: 'agent/inbox/spliced', seq: 0, time: 0, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'queued', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'EXCLUDED_QUEUED' }] }] } })
  events.forEach((event, index) => { event.seq = index })
  const cut = targetSeq(events), before = JSON.stringify(events)
  const seed = editBranchSeed(events, cut, { fingerprint: 'test', sourceId: 'source', editedSeq: cut }, selection)
  assert.equal(JSON.stringify(events), before)
  assert.deepEqual(seed.slice(0, cut), events.slice(0, cut))
  const queues = []
  for (const event of seed) if (event.type === 'agent/inbox/spliced') queues.splice(event.data.start, event.data.removedCount, ...event.data.inserted)
  assert.deepEqual(queues, [])
  const session = Session.create('edited', seed)
  assert.doesNotThrow(() => assertReleasedV4Relationships({ header: session.header, events: session.snapshotEvents(), inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES))
  const input = JSON.stringify(await branchHistoryInput(session, { historyBranch: true }, undefined, false))
  assert.match(input, /EARLIER_QUESTION/); assert.match(input, /EARLIER_ANSWER/)
  for (const value of ['ORIGINAL_TO_EDIT', 'EXCLUDED_ANSWER', 'EXCLUDED_FUTURE', 'EXCLUDED_QUEUED']) assert.ok(!input.includes(value), value)
  assert.deepEqual(await branchHistoryInput(session, { historyBranch: true, historyBootstrapped: true }, undefined, false), [])
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

test('branch API deduplicates retries across restarts, retains workspace and profile, and never reuses the source native thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-history-edit-'))
  try {
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex' }])
    await profiles.bind('source', 'fixture'); await profiles.patchBinding('source', { threadId: 'SOURCE_WITH_FUTURE', seenInputs: ['old'], historyBootstrapped: true })
    const events = history(), agents = new Map(), sent = [], workspace = { id: 'project', path: '/srv/project', sessionIds: ['source'], async attachSession(id) { this.sessionIds.push(id) } }
    let creations = 0, disposed = 0, renames = 0, failAttach = true
    const services = {
      sessionTitle: { get: () => ({ title: 'Original name' }) },
      sessionController: { rename: async () => { renames++ }, resolveAgent: async id => ({ agent: agents.get(id) }) },
      workspaceRegistry: { list: () => [workspace], get: () => ({ attachSession: async id => { if (failAttach) { failAttach = false; throw new Error('attach interrupted') } await workspace.attachSession(id) } }) },
    }
    const ctx = { get: name => services[name], sessionPersistence: { stat: async id => agents.has(id) ? {} : undefined },
      sessionQuery: { observeSession: async () => ({ header: { cwd: '/srv/project' }, events, [Symbol.dispose]() { disposed++ } }) },
      agents: { get: id => agents.get(id), create: async options => {
        creations++
        const session = Session.create(options.sessionId, options.seed)
        const agent = { id: options.sessionId, session, inbox: { nextTurn: [], nextStep: [] }, ctx: { sessions: { flush: async () => {} } },
          followup(message) { sent.push(message); this.inbox.nextTurn.push(message) } }
        agents.set(agent.id, agent); return { agent }
      } } }
    const service = { profiles, hasRuntime: () => true }, input = { sessionId: 'source', requestId: 'same-request-001', seq: targetSeq(events), text: 'EDITED_REQUEST' }
    const editor = new HistoryEditor(ctx, service)
    const first = editor.edit(input); assert.equal(editor.edit(input), first)
    await assert.rejects(first, /attach interrupted/)
    const result = await new HistoryEditor(ctx, service).edit(input)
    await new HistoryEditor(ctx, service).edit(input)
    assert.equal(creations, 1); assert.equal(sent.length, 1); assert.equal(renames, 1)
    assert.equal(sent[0].content[0].text, 'EDITED_REQUEST')
    assert.equal(sent[0].source.kind, 'user')
    assert.ok(workspace.sessionIds.includes(result.sessionId))
    assert.equal(profiles.binding(result.sessionId).threadId, undefined)
    assert.deepEqual(profiles.binding(result.sessionId).seenInputs, [])
    assert.equal(profiles.binding('source').threadId, 'SOURCE_WITH_FUTURE')
    await assert.rejects(new HistoryEditor(ctx, service).edit({ ...input, text: 'different' }), /其他内容/)
    assert.equal(disposed, 4)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const type of ['codex', 'claude', 'cursor', 'codebuddy', 'custom', 'custom-codex', 'dsh']) test(`${type} receives branch context on a fresh protocol thread exactly once, including after restore`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-history-wire-')), log = join(root, 'rpc.jsonl')
  const codex = ['codex', 'custom-codex'].includes(type), model = codex ? 'fixture' : 'fixture-fast'
  const fixture = fileURLToPath(new URL(codex ? './fixture-codex-server.js' : './fixture-acp-server.js', import.meta.url))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: type, type: type === 'custom-codex' ? 'custom' : type, ...(type === 'custom-codex' ? { protocol: 'codex' } : {}), executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_RPC_LOG: log, KODE_ACP_FIXTURE_LOG: log } }])
  await profiles.bind('branch', 'fixture'); await profiles.patchBinding('branch', { historyBranch: true })
  const old = history(), seq = targetSeq(old), events = editBranchSeed(old, seq, { fingerprint: type }, { ...selection, model })
  const session = { header: { cwd: root }, snapshotEvents: () => events, append: (type, data) => { const event = { type, seq: events.length, time: Date.now(), data }; events.push(event); return event } }
  const agent = { id: 'branch', session, ctx: { parallel: async () => {}, get: () => undefined, tools: { execute: async () => { throw new Error('historical tools must not execute') } } } }
  const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 3, lastStepBoundary: { kind: 'start', step: 1 } }) } }
  const options = { recordNative: () => {}, resolveProfile: async profile => ['dsh', 'claude'].includes(type) ? { ...profile, type: 'custom', protocol: 'acp', executable: process.execPath, args: [fixture], env: { KODE_ACP_FIXTURE_LOG: log } } : profile }
  let adapter = new AgentRuntimeAdapter(ctx, profiles, options)
  const send = async (id, text) => { for await (const _ of adapter.stream({ sessionId: 'branch', provider: profileRoute('fixture'), model, tools: [], messages: [{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], signal: AbortSignal.timeout(10000) })) {} }
  try {
    await send('new', 'EDITED_REQUEST')
    await adapter.close()
    adapter = new AgentRuntimeAdapter(ctx, await new AgentProfiles(profiles.path).open(), options)
    await send('later', 'BRANCH_FOLLOWUP')
    const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.method === (codex ? 'thread/start' : 'session/new')).length, 1)
    assert.equal(rows.filter(row => row.method === (codex ? 'thread/resume' : 'session/load')).length, 1)
    const requests = rows.filter(row => row.method === (codex ? 'turn/start' : 'session/prompt'))
    assert.equal(requests.length, 2)
    const first = JSON.stringify(requests[0])
    for (const value of ['EARLIER_QUESTION', 'EARLIER_ANSWER', 'EDITED_REQUEST']) assert.ok(first.includes(value), value)
    for (const value of ['ORIGINAL_TO_EDIT', 'EXCLUDED_ANSWER', 'EXCLUDED_FUTURE']) assert.ok(!first.includes(value), value)
    assert.ok(!JSON.stringify(requests[1]).includes('EARLIER_QUESTION'))
    assert.match(JSON.stringify(requests[1]), /BRANCH_FOLLOWUP/)
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


test('history transfer keeps image bytes, and a steering cut settles open tools without executing them', async () => {
  const events = history(), seq = targetSeq(events), bytes = Buffer.from('image fixture')
  const ref = { attachmentId: 'fixture', mediaType: 'image/png', bytes: bytes.length, width: 2, height: 2 }
  events.find(event => event.type === 'user/message').data.content.push({ type: 'image', attachment: ref })
  const attachments = { imageHostPath: () => undefined, readImage: async attachment => ({ ref: attachment, data: bytes }) }
  const session = Session.create('images', editBranchSeed(events, seq, { fingerprint: 'image' }, selection))
  const input = await branchHistoryInput(session, { historyBranch: true }, attachments, false)
  assert.deepEqual(input.find(part => part.type === 'image'), { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') })
  await assert.rejects(branchHistoryInput(session, { historyBranch: true }, undefined, false), /附件服务/)
  const source = Session.create('steering-source')
  source.append('turn/start', { turn: 1 }); source.append('step/start', { turn: 1, step: 1 })
  source.append('user/message', { id: 'first', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'initial' }] }, { surfaceOp: 'append' })
  source.append('assistant/message', { turn: 1, step: 1, message: { id: 'tool-message', role: 'assistant', source: { kind: 'model', ...selection }, content: [{ type: 'tool-call', id: 'call', name: 'fixture', arguments: '{}' }] }, stream: [] }, { surfaceOp: 'append' })
  source.append('tool/call', { turn: 1, step: 1, callId: 'call', name: 'fixture', arguments: '{}' })
  const steering = source.append('user/message', { id: 'steer', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'change this' }] }, { surfaceOp: 'append' })
  const seed = editBranchSeed(source.snapshotEvents(), steering.seq, { fingerprint: 'steer' }, selection)
  assert.ok(seed.some(event => event.type === 'tool/result'))
  const child = Session.create('steering-branch', seed)
  assert.doesNotThrow(() => assertReleasedV4Relationships({ header: child.header, events: seed, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES))
  const quoted = JSON.stringify(await branchHistoryInput(child, { historyBranch: true }, undefined, false))
  assert.match(quoted, /tool-call/); assert.ok(!quoted.includes('change this'))
})


test('history edits keep the host selected when the editor opened and refuse a later host switch', async () => {
  const source = await readFile(new URL('../packages/chat/history-edit.js', import.meta.url), 'utf8')
  const bind = vm.runInNewContext(source + '\nhistoryEditBinding')
  const requests = [], opened = [], transport = { current: 'remote:fixture.example', fetch: async (url, options, host) => { requests.push({ url, options, host }); return { ok: true, json: async () => ({ sessionId: 'child' }) } } }
  const binding = bind({ get: name => name === 'kodeTransport' ? transport : { openSession: id => opened.push(id) } }, 'source')
  const host = binding.historyHost()
  transport.current = 'local'
  await assert.rejects(binding.editHistory(5, 'edited', 'request', host), /主机已切换/)
  assert.equal(requests.length, 0)
  transport.current = host
  await binding.editHistory(5, 'edited', 'request', host)
  assert.equal(requests[0].host, host); assert.deepEqual(opened, ['child'])
  assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'edit-message', sessionId: 'source', seq: 5, text: 'edited', requestId: 'request' })
  transport.fetch = async () => { transport.current = 'local'; return { ok: true, json: async () => ({ sessionId: 'other-child' }) } }
  await assert.rejects(binding.editHistory(5, 'edited', 'request', host), /主机已切换/)
  assert.deepEqual(opened, ['child'])
})
