/** Project durable DSH messages, regardless of which Agent produced them. */
import { z } from 'zod'
import { readRelayEnvelope, validMessageTitle } from './message-pages.js'

const recentLimit = 24
const reviewStatus = z.enum(['open', 'merged', 'closed', 'draft'])
const reviewSchema = z.object({ url: z.string(), repo: z.string(), number: z.string(), kind: z.enum(['PR', 'MR']), status: reviewStatus.optional() })
const relaySchema = z.object({
  id: z.string(), nodeId: z.string(), sessionId: z.string(), content: z.string(),
  direction: z.enum(['received', 'sent']), reply: z.boolean(), status: z.string().optional(),
  deliveryStatus:z.string().optional(), receiptSeq:z.number().optional(),
  title: z.string().optional(), replyTo: z.string().optional(), answered: z.literal(true).optional(),
})
const viewSchema = z.object({ reviews: z.array(reviewSchema), relays: z.array(relaySchema) })
const stateSchema = viewSchema.extend({ reviewStates: z.record(z.string(),reviewStatus), pendingTools: z.array(z.object({ callId: z.string(), kind: z.enum(['create', 'send', 'read', 'wait']) })) })
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

// Only accept provider records with a stable review URL. Search results may include
// unrelated reviews: remember their status, but only pin links mentioned in chat.
function observedReviews(message) {
  if (message.isError) return []
  const result = []
  for (const block of message.content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length > 1_000_000) continue
    const call = parseJson(block.text)
    if (!call || !['gongfeng','github','codex_apps'].includes(call.server) || call.status !== 'completed') continue
    const payload = call.result?.structuredContent ?? parseJson(blocksText(call.result?.content, 1_000_000))
    for (const row of Array.isArray(payload) ? payload : [payload]) {
      const project = call.arguments?.tool_args?.project_id ?? call.arguments?.project_id
      const gongfengUrl = call.server === 'gongfeng' && typeof project === 'string' && /^[\w.-]+(?:\/[\w.-]+)+$/.test(project) && row?.iid
        ? `https://git.woa.com/${project}/-/merge_requests/${row.iid}` : undefined
      const ref = reviewReference(row?.web_url ?? row?.html_url ?? row?.url ?? gongfengUrl)
      if (!ref || String(row.iid ?? row.number) !== ref.number) continue
      const phase = String(row.state).toLowerCase()
      const status = row.merged === true || row.merged_at || phase === 'merged' ? 'merged'
        : phase === 'closed' ? 'closed' : ['opened','open','reopened'].includes(phase) ? (row.draft || row.work_in_progress ? 'draft' : 'open') : null
      if (status) result.push([reviewKey(ref.url),status])
    }
  }
  return result
}

const reviewKey = url => url.replace(/^https?:\/\//,'').replace('/-/merge_requests/','/merge_requests/')

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
  return !request.reply && reply.direction !== request.direction &&
    reply.replyTo === request.id && reply.nodeId === request.nodeId && reply.sessionId === request.sessionId
}

function relayReplies(result, relays) {
  if (!Array.isArray(result?.events)) return []
  return result.events.flatMap(event => {
    const reply = relayFromRow(event?.message, 'received')
    if (!reply?.replyTo || relays.some(row => row.id === reply.id)) return []
    // A read includes receipts for outgoing messages. Only an actual reply from
    // the original peer can change the state of an outgoing request.
    return relays.some(row => row.direction === 'sent' && isReplyTo(reply, row)) ? [reply] : []
  })
}

function addRecent(rows, items, key) {
  const byKey = new Map(rows.map(row => [key(row), row]))
  for (const item of items) { byKey.delete(key(item)); byKey.set(key(item), item) }
  return Array.from(byKey.values()).slice(-recentLimit)
}

function addRecentRelays(rows, items) {
  const answered = new Set(rows.filter(row => row.answered).map(row => row.id))
  const replies = [...rows, ...items].filter(row => row.replyTo)
  const previous = new Map(rows.filter(row => row.receiptSeq !== undefined).map(row => [row.id,row]))
  const merged = items.map(item => {
    const old = previous.get(item.id)
    return old && old.nodeId === item.nodeId && old.sessionId === item.sessionId
      ? {...item,receiptSeq:old.receiptSeq,deliveryStatus:old.deliveryStatus} : item
  })
  return addRecent(rows, merged, row => row.id).map(row =>
    answered.has(row.id) || replies.some(reply => isReplyTo(reply, row)) ? { ...row, answered: true } : row)
}

export const sessionPanelProjection = {
  key: 'kodeSessionPanel',
  stateVersion: 5,
  stateSchema,
  init: () => ({ reviewStates: {}, reviews: [], relays: [], pendingTools: [] }),
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
      const updates = observedReviews(result)
      if (updates.length) {
        const states = new Map(Object.entries(state.reviewStates))
        for (const [key,status] of updates) { states.delete(key); states.set(key,status) }
        state = {...state,reviewStates:Object.fromEntries([...states].slice(-128))}
      }
      const callId = result.source?.callId
      const tool = state.pendingTools.find(row => row.callId === callId)
      if (!tool) return state
      const pendingTools = state.pendingTools.filter(row => row.callId !== callId)
      const value = relayToolResult(result)
      const outgoing = tool.kind === 'create' ? value?.assignment : tool.kind === 'send' ? value?.message ?? value : undefined
      const relays = tool.kind === 'create' || tool.kind === 'send'
        ? [relayFromRow(outgoing, 'sent')].filter(Boolean)
        : relayReplies(value, state.relays)
      let recent = relays.length ? addRecentRelays(state.relays, relays) : state.relays
      if ((tool.kind === 'read' || tool.kind === 'wait') && Array.isArray(value?.events)) {
        for (const {seq,message} of value.events.filter(event => event && typeof event === 'object')) {
          if (!Number.isSafeInteger(seq) || seq < 0 || typeof message?.status !== 'string' || message.status.length > 32) continue
          const i = recent.findIndex(row => row.direction === 'sent' && row.id === message.id &&
            row.nodeId === message.target?.node_id && row.sessionId === message.target?.session_id && seq > (row.receiptSeq ?? -1))
          if (i >= 0) recent = recent.with(i,{...recent[i],receiptSeq:seq,deliveryStatus:message.status})
        }
      }
      return { ...state, pendingTools, relays: recent }
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
  wire: { viewSchema, view: ({ reviews, relays, reviewStates }) => ({ reviews:reviews.map(row => reviewStates?.[reviewKey(row.url)] ? {...row,status:reviewStates[reviewKey(row.url)]} : row), relays }) },
}
