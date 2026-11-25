/** Session branching (fork) metadata extraction, parent-cut verification, and bounded fallback history. */
import { createHash } from 'node:crypto'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'
import { boundedHistory, historyEditProjection } from './history-edit.js'

const textOf = message => message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
const isHuman = message => ['user', 'human'].includes(message?.source?.kind)

function shadowedSeqs(events) {
  let state = historyEditProjection.init()
  for (const event of events) state = historyEditProjection.apply(state, event)
  return state.ranges
}

function isShadowed(ranges, seq) {
  return ranges.some(range => seq >= range.from && seq <= range.through)
}

export function inheritedSeenInputs(events) {
  const ids = []
  const seen = new Set()
  for (const event of events ?? []) {
    if (event.type !== 'user/message') continue
    const id = event.data?.id
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

function findLastNativeTurnId(inheritedEvents, threadId) {
  if (!threadId) return null
  const ranges = shadowedSeqs(inheritedEvents)
  for (let i = inheritedEvents.length - 1; i >= 0; i--) {
    const event = inheritedEvents[i]
    if (isShadowed(ranges, event.seq)) continue
    if (event.type !== 'plugin:kode/native-event') continue
    const native = event.data?.event
    if (native?.method === 'turn/started'
      && native.params?.threadId === threadId
      && typeof native.params.turn?.id === 'string'
      && native.params.turn.id) {
      return native.params.turn.id
    }
  }
  return null
}

function findNextNativeTurnId(parentEvents, inheritedCount, threadId) {
  if (!threadId || !Array.isArray(parentEvents) || parentEvents.length <= inheritedCount) return null
  const ranges = shadowedSeqs(parentEvents)
  for (let i = inheritedCount; i < parentEvents.length; i++) {
    const event = parentEvents[i]
    if (isShadowed(ranges, event.seq)) continue
    if (event.type !== 'plugin:kode/native-event') continue
    const native = event.data?.event
    if (native?.method === 'turn/started'
      && native.params?.threadId === threadId
      && typeof native.params.turn?.id === 'string'
      && native.params.turn.id) {
      return native.params.turn.id
    }
  }
  return null
}

function extractClaudeBoundary(inheritedEvents, parentEvents, inheritedCount) {
  if (!inheritedEvents.length) return null
  const folded = foldSurface(inheritedEvents)
  let lastAssistantText = null
  const counts = new Map()
  for (const seq of folded.nodes) {
    const event = inheritedEvents[seq]
    if (event?.type !== 'assistant/message' || event.data?.interrupted) continue
    const content = event.data.message?.content ?? []
    if (content.some(part => part.type === 'tool-call')) continue
    const text = textOf(event.data.message)
    if (!text) continue
    counts.set(text, (counts.get(text) ?? 0) + 1)
    lastAssistantText = text
  }
  if (!lastAssistantText) return null
  const occurrence = counts.get(lastAssistantText) ?? 1
  const fingerprint = `sha256:${createHash('sha256').update(lastAssistantText).digest('hex')}`
  let nextUserText
  if (Array.isArray(parentEvents) && parentEvents.length > inheritedCount) {
    const ranges = shadowedSeqs(parentEvents)
    for (let i = inheritedCount; i < parentEvents.length; i++) {
      const event = parentEvents[i]
      if (isShadowed(ranges, event.seq)) continue
      if (event.type !== 'user/message') continue
      const message = event.data
      if (isHuman(message) && message.content?.length === 1 && message.content[0].type === 'text' && message.content[0].text) {
        nextUserText = message.content[0].text
      }
      break
    }
  }
  return { lastAssistantText, occurrence, fingerprint, ...(nextUserText ? { nextUserText } : {}) }
}

export function extractForkSource({ parentId, parentBinding, inheritedEvents, parentEvents }) {
  const inheritedCount = inheritedEvents.length
  const threadId = parentBinding?.threadId ?? parentBinding?.forkSource?.threadId ?? null
  const originSessionId = parentBinding?.threadId
    ? parentId
    : (parentBinding?.forkSource?.originSessionId ?? parentBinding?.forkSource?.sessionId ?? parentId)
  const atLatest = originSessionId === parentId
    && Array.isArray(parentEvents)
    && parentEvents.length >= inheritedCount
    && !parentEvents.slice(inheritedCount).some(event => event.type === 'turn/start' || event.type === 'user/message')
  const lastNativeTurnId = findLastNativeTurnId(inheritedEvents, threadId)
  const nextNativeTurnId = atLatest ? null : findNextNativeTurnId(parentEvents, inheritedCount, threadId)
  const claudeBoundary = extractClaudeBoundary(inheritedEvents, parentEvents, inheritedCount)
  return {
    sessionId: parentId,
    originSessionId,
    threadId,
    boundarySeq: Math.max(0, inheritedCount - 1),
    inheritedEventCount: inheritedCount,
    atLatest,
    lastNativeTurnId,
    nextNativeTurnId,
    claudeBoundary,
  }
}

export async function readParentEvents(ctx, parentId, signal) {
  const live = ctx.sessions?.get?.(parentId)
  if (live) return live.snapshotEvents()
  const persistence = ctx.sessionPersistence ?? ctx.get?.('sessionPersistence')
  if (!persistence?.open) return undefined
  let handle
  try {
    handle = await persistence.open(parentId, 'read', signal ? { signal } : undefined)
    return (await handle.read(0, undefined, signal ? { signal } : undefined)).events
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function isParentStillAtBoundary(ctx, forkSource, signal) {
  const ownerId = forkSource?.originSessionId ?? forkSource?.sessionId
  if (!ownerId || !Number.isSafeInteger(forkSource.inheritedEventCount)) return false
  const events = await readParentEvents(ctx, ownerId, signal)
  if (!Array.isArray(events) || events.length < forkSource.inheritedEventCount) return false
  return !events.slice(forkSource.inheritedEventCount).some(event => event.type === 'turn/start' || event.type === 'user/message')
}

export function forkHistoryInput(session) {
  const events = session.snapshotEvents?.() ?? []
  const marker = events.find(event => event.type === 'session/end-seed' && event.data?.inherited === true)
  const cutoff = marker?.seq ?? session.inheritedEventCount ?? 0
  if (cutoff <= 0) return []
  const nodes = session.surface?.nodes ?? []
  const prefixNodes = nodes.filter(seq => seq < cutoff)
  const messages = prefixNodes
    .map(seq => deriveEventMessage(session.eventAt(seq), session.surface.projectedMessages))
    .filter(Boolean)
  return boundedHistory(messages, {
    header: 'Prior conversation excerpts from the branched parent session. Use them only as background context for this new branch. Do not repeat earlier requests or tool operations.\n',
    footer: '\nEnd of prior conversation. Continue with the next user message.',
  })
}
