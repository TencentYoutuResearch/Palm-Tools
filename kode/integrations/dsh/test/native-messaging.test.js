/** Cross the native protocol, dsh tool executor, real backend and reply inbox. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { apply } from '../src/host.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { BackendClient } from '../src/backend-client.js'

const url = process.env.KODE_TEST_BACKEND_URL, tokenFile = process.env.KODE_TEST_TOKEN_FILE
const prefix = '/api/v1/messaging/'
for (const type of ['codex', 'cursor', 'custom']) test(`${type} native tools send through the real backend and receive a reply in the owning dsh inbox`, { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-native-messaging-'))
  const tools = new Map(), disposers = [], inbox = [], events = []
  const sessionId = `native-${randomUUID()}`, peerId = `peer-${randomUUID()}`
  let adapter
  const session = { header: { cwd: root }, append: (type, data) => events.push({ type, data }) }
  const agent = { id: sessionId, session, followup: input => inbox.push(input), ctx: {
    parallel: async () => {}, get: () => undefined,
    tools: {
      register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
      execute: async exec => {
        assert.equal(exec.agent, agent)
        const value = await tools.get(exec.name).execute(exec.arguments, exec)
        return { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }
      },
    },
  } }
  const ctx = {
    agents: { list: () => [agent], get: id => id === sessionId ? agent : undefined },
    logger: { warn: (...args) => { throw new Error(args.join(' ')) } }, on() {},
    effect: callback => disposers.push(callback()),
    sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) },
  }
  try {
    await apply(ctx, { url, tokenFile, stateFile: join(root, 'tokens.json'), pollMs: 20, agentRuntime: false })
    const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
    const node = await admin.call(`${prefix}node`)
    const other = await admin.call(`${prefix}sessions`, { session_id: peerId, title: 'Native messaging reviewer', runtime: 'external' })
    const peer = admin.forSession(other.owner_token)
    const fixture = fileURLToPath(new URL(type === 'codex' ? './fixture-codex-server.js' : './fixture-acp-server.js', import.meta.url))
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'configured', name: 'Native fixture', type, executable: process.execPath, args: [fixture] }])
    adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: () => {} })
    const request = {
      sessionId, provider: profileRoute('configured'), model: 'default', signal: AbortSignal.timeout(10000),
      messages: [{ id: randomUUID(), role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: `KODE_TEST_SEND ${node.node_id}/${peerId}` }] }],
      tools: [...tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
    }
    for await (const _chunk of adapter.stream(request)) { /* fully drain the native turn */ }
    const claimed = await peer.call(`${prefix}sessions/${peerId}/claim`, {})
    assert.equal(claimed.messages.length, 1)
    const sent = claimed.messages[0]
    assert.equal(sent.source.session_id, sessionId, 'the native process cannot choose its source identity')
    assert.match(sent.content, /native (Codex|ACP) message/)
    await peer.call(`${prefix}messages/${sent.id}`, { session_id: peerId, status: 'accepted' })
    const reply = await peer.call(`${prefix}messages`, { target: sent.source, content: 'Native roundtrip verified', in_reply_to: sent.id, idempotency_key: randomUUID() })
    let receipt
    const deadline = Date.now() + 5000
    do {
      receipt = await peer.call(`${prefix}messages/${reply.id}`)
      if (receipt.status === 'accepted') break
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.equal(receipt.status, 'accepted')
    assert.equal(inbox.length, 1)
    assert.match(inbox[0].content[0].text, /Native roundtrip verified/)
    assert.equal(inbox[0].source.senderSessionId, `kode:${node.node_id}:${peerId}`)
    assert.ok(events.some(event => event.type === 'tool/call' && event.data.name === 'kode_sessions_send'))
    assert.equal(profiles.binding(sessionId).lastOutcome, 'completed')
  } finally {
    await adapter?.close()
    for (const dispose of disposers.reverse()) await dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
