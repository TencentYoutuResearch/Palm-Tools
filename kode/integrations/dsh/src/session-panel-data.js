/** Project durable DSH messages, regardless of which Agent produced them. */
import { z } from 'zod'
import { readRelayEnvelope } from './message-pages.js'

const recentLimit = 24
const reviewSchema = z.object({ url: z.string(), repo: z.string(), number: z.string(), kind: z.enum(['PR', 'MR']) })
const relaySchema = z.object({
  id: z.string(), nodeId: z.string(), sessionId: z.string(), content: z.string(),
  direction: z.enum(['received', 'sent']), reply: z.boolean(), status: z.string().optional(),
})
const viewSchema = z.object({ reviews: z.array(reviewSchema), relays: z.array(relaySchema) })
const stateSchema = viewSchema.extend({ pendingSends: z.array(z.string()) })
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
const sendTool = /(?:^|__)(?:kode_)?sessions_send$/
function isRelaySend({ name, arguments: args }) {
  if (sendTool.test(name)) return true
  if (name !== 'kode_native_mcpToolCall' && name !== 'kode_native_commandExecution') return false
  const native = parseJson(args)
  return sendTool.test(native?.tool ?? native?.name ?? '') ||
    /\b(?:kode_)?sessions_send\b/.test(native?.title ?? '')
}

function sentRelay(result) {
  if (result.isError) return
  const value = parseJson(blocksText(result.content, 65536))
  const wrapped = value?.result?.structuredContent ?? parseJson(blocksText(value?.result?.content, 65536)) ?? parseJson(value?.aggregatedOutput)
  const row = wrapped?.message ?? wrapped ?? value?.message ?? value
  const { id, target, content, status, in_reply_to } = row ?? {}
  const nodeId = target?.node_id, sessionId = target?.session_id
  if (![id, nodeId, sessionId].every(value => typeof value === 'string' && value && value.length <= 256) || typeof content !== 'string') return
  return { id, nodeId, sessionId, content: content.slice(0, 1200), direction: 'sent', reply: Boolean(in_reply_to),
    ...(typeof status === 'string' ? { status: status.slice(0, 32) } : {}) }
}

function addRecent(rows, items, key) {
  const byKey = new Map(rows.map(row => [key(row), row]))
  for (const item of items) { byKey.delete(key(item)); byKey.set(key(item), item) }
  return Array.from(byKey.values()).slice(-recentLimit)
}

export const sessionPanelProjection = {
  key: 'kodeSessionPanel',
  stateVersion: 1,
  stateSchema,
  init: () => ({ reviews: [], relays: [], pendingSends: [] }),
  apply(state, event) {
    if (event.type === 'tool/call' && isRelaySend(event.data)) {
      const callId = event.data.callId
      if (typeof callId !== 'string') return state
      return { ...state, pendingSends: [...state.pendingSends.filter(id => id !== callId), callId].slice(-recentLimit) }
    }
    if (event.type === 'tool/result') {
      const result = event.data.message
      const callId = result.source?.callId
      if (!state.pendingSends.includes(callId)) return state
      const pendingSends = state.pendingSends.filter(id => id !== callId)
      const relay = sentRelay(result)
      return { ...state, pendingSends, relays: relay ? addRecent(state.relays, [relay], row => row.id) : state.relays }
    }
    const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : undefined
    if (!message || event.surfaceOp === 'replace') return state
    const relay = event.type === 'user/message' ? relayFor(message) : undefined
    const visible = event.type === 'assistant/message' || message.source?.kind === 'user'
    const reviews = reviewsIn(relay?.content ?? (visible ? blocksText(message.content, 65536) : ''))
    if (!reviews.length && !relay) return state
    return { ...state, reviews: reviews.length ? addRecent(state.reviews, reviews, row => row.url) : state.reviews,
      relays: relay ? addRecent(state.relays, [relay], row => row.id) : state.relays }
  },
  wire: { viewSchema, view: ({ reviews, relays }) => ({ reviews, relays }) },
}
