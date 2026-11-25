/** Project durable DSH messages, regardless of which Agent produced them. */
import { z } from 'zod'
import { readRelayEnvelope, validMessageTitle } from './message-pages.js'

const recentLimit = 24
const reviewSchema = z.object({ url: z.string(), repo: z.string(), number: z.string(), kind: z.enum(['PR', 'MR']) })
const relaySchema = z.object({
  id: z.string(), nodeId: z.string(), sessionId: z.string(), content: z.string(),
  direction: z.enum(['received', 'sent']), reply: z.boolean(), status: z.string().optional(),
  title: z.string().optional(), replyTo: z.string().optional(), answered: z.literal(true).optional(),
})
const viewSchema = z.object({ reviews: z.array(reviewSchema), relays: z.array(relaySchema) })
const stateSchema = viewSchema.extend({ pendingTools: z.array(z.object({ callId: z.string(), kind: z.enum(['create', 'send', 'read', 'wait']) })) })
const blocksText = (blocks, limit) => {
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    text += block.text.slice(0, limit - text.length)
    if (text.length === limit) break
  }
  return text
}
const reviewPath = /^\/((?:[^/]+\/)+?[^/]+)\/(pull|(?:-\/)?merge_requests)\/([1-9]\d{0,15})(?=\/|$)/

export function reviewReference(value) {
  let url
  try { url = new URL(value) } catch { return }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return
  const match = reviewPath.exec(url.pathname)
  if (!match) return
  const [, repo, segment, number] = match
  return { url: url.origin + match[0], repo, number, kind: segment === 'pull' ? 'PR' : 'MR' }
}

function reviewsIn(text) {
  if (!text.includes('/pull/') && !text.includes('/merge_requests/')) return []
  const urls = text.match(/https?:\/\/[^\s<>"'`()[\]{}]+/gi) ?? []
  return urls.flatMap(value => reviewReference(value.replace(/[.,;:!?，。；：！？]+$/u, '')) ?? [])
}

function relayFor(message) {
  if (message.source?.kind !== 'agent-message' || !message.source.senderSessionId?.startsWith('kode:')) return
  const relay = readRelayEnvelope(blocksText(message.content, 16384))
  if (relay && message.source.senderSessionId === `kode:${relay.nodeId}:${relay.sessionId}`) {
    return { ...relay, content: relay.content.slice(0, 1200), direction: 'received' }
  }
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return }
}
const sessionTool = /(?:^|__)(?:kode_)?sessions_(create|send|read|wait)$/
function relayTool({ name, arguments: args }) {
  const direct = sessionTool.exec(name)?.[1]
  if (direct) return direct
  if (name !== 'kode_native_mcpToolCall' && name !== 'kode_native_commandExecution') return
  const native = parseJson(args)
  return sessionTool.exec(native?.tool ?? native?.name ?? '')?.[1] ??
    /\b(?:kode_)?sessions_(create|send|read|wait)\b/.exec(native?.title ?? '')?.[1]
}

function relayToolResult(result) {
  if (result.isError) return
  const value = parseJson(blocksText(result.content, 65536))
  return value?.result?.structuredContent ?? parseJson(blocksText(value?.result?.content, 65536)) ??
    parseJson(value?.aggregatedOutput) ?? value
}

function relayFromRow(row, direction) {
  const { id, content, status, in_reply_to, title } = row ?? {}
  const peer = direction === 'sent' ? row?.target : row?.source
  const nodeId = peer?.node_id, sessionId = peer?.session_id
  if (![id, nodeId, sessionId].every(value => typeof value === 'string' && value && value.length <= 256) || typeof content !== 'string') return
  const replyTo = typeof in_reply_to === 'string' && in_reply_to.length <= 160 ? in_reply_to : ''
  return { id, nodeId, sessionId, content: content.slice(0, 1200), direction, reply: Boolean(replyTo),
    ...(replyTo ? { replyTo } : {}),
    ...(validMessageTitle(title) ? { title } : {}),
    ...(typeof status === 'string' ? { status: status.slice(0, 32) } : {}) }
}

function isReplyTo(reply, request) {
  return request.direction === 'sent' && !request.reply && reply.direction === 'received' &&
    reply.replyTo === request.id && reply.nodeId === request.nodeId && reply.sessionId === request.sessionId
}

function relayReplies(result, relays) {
  if (!Array.isArray(result?.events)) return []
  return result.events.flatMap(event => {
    const reply = relayFromRow(event?.message, 'received')
    if (!reply?.replyTo || relays.some(row => row.id === reply.id)) return []
    // A read includes receipts for outgoing messages. Only an actual reply from
    // the original peer can change the state of an outgoing request.
    return relays.some(row => isReplyTo(reply, row)) ? [reply] : []
  })
}

function addRecent(rows, items, key) {
  const byKey = new Map(rows.map(row => [key(row), row]))
  for (const item of items) { byKey.delete(key(item)); byKey.set(key(item), item) }
  return Array.from(byKey.values()).slice(-recentLimit)
}

function addRecentRelays(rows, items) {
  const answered = new Set(rows.filter(row => row.answered).map(row => row.id))
  const replies = [...rows, ...items].filter(row => row.direction === 'received' && row.replyTo)
  return addRecent(rows, items, row => row.id).map(row =>
    answered.has(row.id) || replies.some(reply => isReplyTo(reply, row)) ? { ...row, answered: true } : row)
}

export const sessionPanelProjection = {
  key: 'kodeSessionPanel',
  stateVersion: 3,
  stateSchema,
  init: () => ({ reviews: [], relays: [], pendingTools: [] }),
  apply(state, event) {
    if (event.type === 'tool/call') {
      const kind = relayTool(event.data)
      const callId = event.data.callId
      if (!kind || typeof callId !== 'string') return state
      const pendingTools = addRecent(state.pendingTools, [{ callId, kind }], row => row.callId)
      return { ...state, pendingTools }
    }
    if (event.type === 'tool/result') {
      const result = event.data.message
      const callId = result.source?.callId
      const tool = state.pendingTools.find(row => row.callId === callId)
      if (!tool) return state
      const pendingTools = state.pendingTools.filter(row => row.callId !== callId)
      const value = relayToolResult(result)
      const outgoing = tool.kind === 'create' ? value?.assignment : tool.kind === 'send' ? value?.message ?? value : undefined
      const relays = tool.kind === 'create' || tool.kind === 'send'
        ? [relayFromRow(outgoing, 'sent')].filter(Boolean)
        : relayReplies(value, state.relays)
      return { ...state, pendingTools, relays: relays.length ? addRecentRelays(state.relays, relays) : state.relays }
    }
    const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : undefined
    if (!message || event.surfaceOp === 'replace') return state
    const relay = event.type === 'user/message' ? relayFor(message) : undefined
    const visible = event.type === 'assistant/message' || message.source?.kind === 'user'
    const reviews = reviewsIn(relay?.content ?? (visible ? blocksText(message.content, 65536) : ''))
    if (!reviews.length && !relay) return state
    return { ...state, reviews: reviews.length ? addRecent(state.reviews, reviews, row => row.url) : state.reviews,
      relays: relay ? addRecentRelays(state.relays, [relay]) : state.relays }
  },
  wire: { viewSchema, view: ({ reviews, relays }) => ({ reviews, relays }) },
}
