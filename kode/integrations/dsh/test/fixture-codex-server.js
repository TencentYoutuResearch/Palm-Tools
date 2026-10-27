/** Deterministic app-server protocol fixture; never runs an external model. */
import readline from 'node:readline'
import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const result = (id, value) => send({ id, result: value })
const notify = (method, params) => send({ method, params })
let turn = 0
const dynamic = new Map()
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => { void receive(JSON.parse(line)).catch(error => send({ id: null, error: { message: error.message } })) })
async function receive(message) {
  const { id, method, params } = message
  if (process.env.KODE_FIXTURE_RPC_LOG && method) await appendFile(process.env.KODE_FIXTURE_RPC_LOG, JSON.stringify({ method, params, label: process.env.KODE_FIXTURE_AGENT_LABEL, hostCredentialPresent: Boolean(process.env.KODE_BRIDGE_TOKEN || process.env.KODE_MESSAGING_ADMIN_TOKEN_FILE || process.env.KODE_SESSION_ID) }) + '\n')
  if (method === 'initialize') return result(id, { userAgent: 'fixture' })
  if (method === 'initialized') return
  if (method === 'model/list') return result(id, { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture' }], nextCursor: null })
  if (method === 'thread/start' || method === 'thread/resume') return result(id, { thread: { id: params.threadId ?? 'same-native-id' } })
  if (method === 'turn/interrupt') { result(id, {}); return }
  if (method === 'turn/start') {
    const turnId = 'turn-' + ++turn, threadId = params.threadId
    result(id, { turn: { id: turnId, status: 'inProgress' } })
    notify('turn/started', { threadId, turn: { id: turnId } })
    const text = params.input[0]?.text ?? ''
    const complete = () => {
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: `${process.env.KODE_FIXTURE_AGENT_LABEL ?? 'fixture'}: ${text}` })
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'answer', text: `${process.env.KODE_FIXTURE_AGENT_LABEL ?? 'fixture'}: ${text}` } })
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
    }
    if (text.includes('WAIT')) return
    const target = text.match(/KODE_TEST_SEND ([A-Za-z0-9_.:-]+)\/([A-Za-z0-9_.:-]+)/)
    if (text.includes('TOOL') || target) {
      dynamic.set('tool-1', complete)
      const action = target ? { tool: 'kode_sessions_send', arguments: { node_id: target[1], session_id: target[2], content: 'KODE_TEST_REQUEST Confirm this native Codex message.', idempotency_key: 'native-fixture-' + createHash('sha256').update(text).digest('hex').slice(0, 32) } } : { tool: 'kode_sessions_list', arguments: {} }
      return send({ id: 'tool-1', method: 'item/tool/call', params: { threadId, turnId, callId: 'call-1', ...action } })
    }
    complete(); return
  }
  if (dynamic.has(id)) { dynamic.get(id)(); dynamic.delete(id); return }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'unknown fixture method' } })
}
