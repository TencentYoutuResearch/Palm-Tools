/** Optional compatibility gate against the actual pinned dsh Session reader. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
const modules = process.env.KODE_TEST_DSH_NODE_MODULES
for (const type of ['codex', 'cursor', 'custom']) test(`${type} tool activity forms a complete dsh log that its released reader can restore`, { skip: !modules }, async () => {
  const { Session, KNOWN_SESSION_EVENT_TYPES, appendPluginRecord } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session/lib/index.js')))
  const { assertReleasedV4Relationships } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')))
  const root = await mkdtemp(join(tmpdir(), 'kode-dsh-log-'))
  const model = type === 'codex' ? 'fixture' : 'fixture-fast'
  const profiles = await new AgentProfiles(join(root, 'agents.json')).open([{ id: 'codex', name: 'Protocol fixture', type, executable: process.execPath, args: [fileURLToPath(new URL(type === 'codex' ? './fixture-codex-server.js' : './fixture-acp-server.js', import.meta.url))] }])
  const raw = Session.create('native-tool-log'), events = []
  let notify
  const session = { header: raw.header, append: (...args) => { const event = raw.append(...args); events.push(event); notify?.(session, event); return event }, requestHeader: () => raw.requestHeader() }
  const user = { id: 'input-one', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'TOOL read directory' }] }
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 }); session.append('user/message', user, { surfaceOp: 'append' })
  const agent = { id: 'native-tool-log', session, ctx: { parallel: async () => {}, get: () => undefined,
    tools: { execute: async () => ({ isError: false, content: [{ type: 'text', text: 'directory' }] }) } } }
  let turn = 1
  const ctx = { on: (name, callback) => { if (name === 'session/event') notify = callback }, agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: turn, lastStepBoundary: { kind: 'start', seq: 1 } }) } }
  const recordNative = (_session, data) => { const seq = appendPluginRecord(raw, 'plugin:kode/native-event', data); const event = raw.snapshotEvents(seq)[0]; events.push(event); notify?.(session, event) }
  let adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative })
  try {
    let text = ''
    for await (const chunk of adapter.stream({ sessionId: agent.id, provider: profileRoute('codex'), model, messages: [user], signal: AbortSignal.timeout(5000), tools: [{ name: 'kode_sessions_list', description: 'List', parameters: { type: 'object' } }] })) if (chunk.type === 'text-delta') text += chunk.text
    session.append('assistant/message', { turn: 1, step: 1, message: { id: 'answer', role: 'assistant', source: { kind: 'model', provider: profileRoute('codex'), model: 'fixture' }, content: [{ type: 'text', text }] }, stream: [] }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const steering = { ...user, id: 'steering-input' }
    session.append('step/start', { turn: 1, step: 2 }); session.append('user/message', steering, { surfaceOp: 'append' })
    for await (const _ of adapter.stream({ sessionId: agent.id, provider: profileRoute('codex'), model, messages: [user, steering], signal: AbortSignal.timeout(5000), tools: [{ name: 'kode_sessions_list', description: 'List', parameters: { type: 'object' } }] })) { /* a steered input may use a second step in the same turn */ }
    session.append('step/end', { turn: 1, step: 2 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await adapter.close()
    adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative })
    turn = 2
    const next = { ...user, id: 'input-two' }
    session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 }); session.append('user/message', next, { surfaceOp: 'append' })
    for await (const _ of adapter.stream({ sessionId: agent.id, provider: profileRoute('codex'), model, messages: [user, next], signal: AbortSignal.timeout(5000), tools: [{ name: 'kode_sessions_list', description: 'List', parameters: { type: 'object' } }] })) { /* drain the second native turn */ }
    session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } })
    const artifact = { header: raw.header, inheritedEventCount: 0, events }
    assert.doesNotThrow(() => assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES))
    assert.doesNotThrow(() => Session.create(raw.id, events, raw.header, 0))
    const ids = events.filter(e => e.type === 'tool/call').map(e => e.data.callId)
    assert.equal(ids.length, 3)
    assert.equal(new Set(ids).size, 3, 'a restarted native process may reuse native call IDs')
    const broken = events.filter(e => !(e.type === 'assistant/message' && e.data.message.content.some(c => c.type === 'tool-call'))).map((e, seq) => ({ ...e, seq }))
    assert.throws(() => assertReleasedV4Relationships({ ...artifact, events: broken }, KNOWN_SESSION_EVENT_TYPES), /no advertised tool lifecycle/)
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})
