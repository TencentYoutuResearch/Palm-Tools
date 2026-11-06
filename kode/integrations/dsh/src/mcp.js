#!/usr/bin/env node
/** MCP bridge for existing kode-managed CLI agents. No dsh dependency. */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { BackendClient } from './backend-client.js'
import { eventPage, messagePage, lifecyclePage } from './message-pages.js'
import { searchSessions } from './session-search.js'
const prefix = '/api/v1/messaging/'
const readToken = async file => (await readFile(file, 'utf8')).trim()
let client = new BackendClient(process.env.KODE_MESSAGING_URL ?? 'http://127.0.0.1:47870', '')
if (process.env.KODE_MESSAGING_TOKEN_FILE) client = client.forSession(await readToken(process.env.KODE_MESSAGING_TOKEN_FILE))
else if (process.env.KODE_MESSAGING_ADMIN_TOKEN_FILE && /^\d+$/.test(process.env.KODE_SESSION_ID ?? '')) {
  const admin = client.forSession(await readToken(process.env.KODE_MESSAGING_ADMIN_TOKEN_FILE))
  let credential
  for (let attempt = 0; attempt < 20; attempt++) {
    try { credential = await admin.call(`${prefix}native/${process.env.KODE_SESSION_ID}/credential`, {}); break }
    catch (error) { if (!error.message.includes('(404)')) throw error; await new Promise(resolve => setTimeout(resolve, 200)) }
  }
  if (!credential) throw new Error('kode native session did not register')
  client = client.forSession(credential.token)
} else throw new Error('provide a session token file, or native KODE_SESSION_ID and an admin token file')
await client.call(`${prefix}self`) // Refuse a broad admin token as an agent tool credential.
const capabilities = await client.call(`${prefix}node`)
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) })
const tools = [
  ...(capabilities.lifecycle_events === true ? [{ name: 'kode_sessions_lifecycle_read', description: 'Read bounded delivery, consumption and cancellation audit records. This cursor is separate from message reads; continue until an empty page. Historical imports are not causal order. Consumed is not task completion.', inputSchema: object({ after: { type: 'integer', minimum: 0 } }) }] : []),
  { name: 'kode_sessions_list', description: 'Find local and SSH sessions by name or partial title. Inspect matches and disambiguate duplicate names, then send using the returned address; never guess an ID.', inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', description: 'Name or keywords from the user; omit to list all.' } } } },
  { name: 'kode_sessions_send', description: 'Send to an agent; delivery is not task completion. Reuse idempotency_key only for a retry. Reply with in_reply_to.', inputSchema: { ...object({ node_id: { type: 'string' }, session_id: { type: 'string' }, content: { type: 'string' }, idempotency_key: { type: 'string' } }), properties: { node_id: { type: 'string' }, session_id: { type: 'string' }, content: { type: 'string' }, idempotency_key: { type: 'string' }, in_reply_to: { type: 'string' } } } },
  { name: 'kode_sessions_message_read', description: 'Read full persisted messages in bounded pages. Offset counts Unicode code points; follow next until null. A preview is not proof of consumption.', inputSchema: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['message_id'] } },
  { name: 'kode_sessions_delivery_status', description: 'Read persisted input delivery evidence. Queued is not consumed; consumed is not task completion.', inputSchema: object({ message_id: { type: 'string' } }) },
  ...(capabilities.input_cancellation === true ? [
    { name: 'kode_sessions_cancel_input', description: 'Request cancellation of your own message. Queue removal is distinct from stopping execution; a request may remain cancel_unconfirmed.', inputSchema: object({ message_id: { type: 'string' } }) },
    { name: 'kode_sessions_cancellation_status', description: 'Read the persisted cancellation result. A stop request does not prove termination.', inputSchema: object({ message_id: { type: 'string' } }) },
  ] : []),
  { name: 'kode_sessions_read', description: 'Read bounded message/receipt previews. Follow cursor until an empty page; truncated content includes full-message continuation.', inputSchema: object({ after: { type: 'integer', minimum: 0 } }) },
  { name: 'kode_sessions_wait', description: 'Wait up to 30 seconds for this session\'s message or receipt events.', inputSchema: object({ after: { type: 'integer', minimum: 0 }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 30 } }) },
]
async function execute(name, args, signal) {
  if (name === 'kode_sessions_lifecycle_read') {
    if (!tools.some(tool => tool.name === name)) throw new Error('Lifecycle audit is unsupported by this Hub')
    const after = args.after ?? 0
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Cursor must be a nonnegative integer')
    return lifecyclePage(await client.call(`${prefix}lifecycle-events?after=${after}`, undefined, signal), after)
  }
  if (['kode_sessions_delivery_status', 'kode_sessions_cancel_input', 'kode_sessions_cancellation_status'].includes(name)) {
    if (!tools.some(tool => tool.name === name)) throw new Error('Input cancellation is unsupported by this Hub')
    if (typeof args.message_id !== 'string' || !args.message_id) throw new Error('Message ID required')
    const suffix = name === 'kode_sessions_delivery_status' ? 'delivery' : 'cancellation'
    return client.call(`${prefix}messages/${encodeURIComponent(args.message_id)}/${suffix}`, name === 'kode_sessions_cancel_input' ? {} : undefined, signal)
  }
  if (name === 'kode_sessions_list') return searchSessions(await client.call(`${prefix}sessions`, undefined, signal), args.query)
  if (name === 'kode_sessions_send') return client.call(`${prefix}messages`, { target: { node_id: args.node_id, session_id: args.session_id }, content: args.content, idempotency_key: args.idempotency_key, in_reply_to: args.in_reply_to ?? null }, signal)
  if (name === 'kode_sessions_message_read') return messagePage(await client.call(`${prefix}messages/${encodeURIComponent(args.message_id)}`, undefined, signal), args.offset ?? 0)
  if (name === 'kode_sessions_read' || name === 'kode_sessions_wait') {
    const until = Date.now() + (name.endsWith('wait') ? Math.min(30, Math.max(1, args.timeout_seconds ?? 15)) * 1000 : 0)
    do {
      signal.throwIfAborted()
      const result = await client.call(`${prefix}events?after=${Math.max(0, args.after ?? 0)}`, undefined, signal)
      if (result.events.length || Date.now() >= until) return eventPage(result, args.after ?? 0)
      await new Promise(resolve => setTimeout(resolve, 250))
    } while (Date.now() < until)
    return { events: [], cursor: args.after ?? 0, timed_out: true }
  }
  throw new Error('unknown tool')
}
const running = new Map()
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
async function handle(request) {
  if (request.method === 'notifications/cancelled') { running.get(request.params?.requestId)?.abort(); return }
  if (request.id === undefined) return
  const controller = new AbortController(); running.set(request.id, controller)
  try {
    let result
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kode-sessions', version: '0.1.0' } }
    else if (request.method === 'ping') result = {}
    else if (request.method === 'tools/list') result = { tools }
    else if (request.method === 'tools/call') {
      try { result = { content: [{ type: 'text', text: JSON.stringify(await execute(request.params.name, request.params.arguments ?? {}, controller.signal)) }] } }
      catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] } }
    } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return }
    send({ jsonrpc: '2.0', id: request.id, result })
  } catch { send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Kode request failed' } }) }
  finally { running.delete(request.id) }
}
const lines = createInterface({ input: process.stdin })
lines.on('line', line => { try { if (line.length > 131072) throw new Error('frame too large'); void handle(JSON.parse(line)) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) } })
lines.on('close', () => { for (const controller of running.values()) controller.abort() })
