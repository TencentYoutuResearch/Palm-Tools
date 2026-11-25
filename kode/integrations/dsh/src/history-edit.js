/** Edit a durable message in the same session using DSH's surface replacement. */
import { createHash } from 'node:crypto'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

export const HISTORY_EDIT = 'plugin:kode/history-edit' // Sessions made by the former branch editor.
const editId = /^history-edit-(\d+)-([a-f0-9]{64})$/
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const human = message => ['user', 'human'].includes(message.source?.kind)
const textOf = message => message?.content.filter(part => part.type === 'text').map(part => part.text).join('\n')

export function historyEditTarget(message) {
  const match = editId.exec(message.id)
  const target = match && Number(match[1])
  return Number.isSafeInteger(target) ? target : undefined
}

function isEdit(event) {
  return event.type === 'user/message' && event.surfaceOp?.op === 'replace' && Number.isSafeInteger(event.surfaceOp.startSeq) && human(event.data)
    && historyEditTarget(event.data) === event.surfaceOp.startSeq
}

export const latestHistoryEdit = events => events.findLast(isEdit)

export function editedMessage(events, seq, text) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('无效的历史消息位置。')
  const event = events[seq], message = event?.data
  if (event?.type !== 'user/message' || (event.surfaceOp !== 'append' && !isEdit(event)) || message.role !== 'user' || !human(message)) throw new Error('只能编辑自己的历史消息。')
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64000) throw new Error('消息不能为空，且不能超过 64 KiB。')
  if (message.content.some(part => !['text', 'image', 'file'].includes(part.type))) throw new Error('此消息包含暂不支持编辑的内容。')
  let inserted = false
  const content = message.content.flatMap(part => {
    if (part.type !== 'text') return [part]
    if (inserted) return []
    inserted = true
    return [{ type: 'text', text }]
  })
  if (!inserted) content.unshift({ type: 'text', text })
  const { rpcId, ...source } = message.source
  return { ...message, source, content }
}

export function historyEditSurface(session, message) {
  const target = historyEditTarget(message)
  if (target === undefined || !human(message)) return { surfaceOp: 'append' }
  const nodes = session.surface.nodes, position = nodes.indexOf(target)
  if (position < 0) throw new Error('该消息已经被后续编辑替换，请刷新会话。')
  const shadowed = nodes.slice(position)
  // The Chat turn rail uses the turn start as its anchor.
  const start = session.snapshotEvents(0, target).findLast(event => event.type === 'turn/start')
  if (start && (nodes[position - 1] ?? -1) < start.seq) shadowed.unshift(start.seq)
  return { surfaceOp: { op: 'replace', startSeq: target, endSeq: nodes.at(-1) }, sourceEventSeqs: shadowed }
}

const rangesSchema = z.array(z.object({ from: z.number(), through: z.number() }))
export const historyEditProjection = {
  key: 'kodeHistoryEdits',
  stateVersion: 1,
  stateSchema: z.object({ turnStart: z.number(), lastEditSeq: z.number().nullable(), ranges: rangesSchema }),
  init: () => ({ turnStart: 0, lastEditSeq: null, ranges: [] }),
  apply: (state, event) => {
    if (event.type === 'turn/start') return { ...state, turnStart: event.seq }
    if (!isEdit(event)) return state
    const from = event.sourceEventSeqs?.[0] ?? event.surfaceOp.startSeq
    const through = state.turnStart - 1
    return { ...state, lastEditSeq: event.seq, ranges: [...state.ranges.filter(range => range.through < from), { from, through }] }
  },
  wire: { viewSchema: rangesSchema, view: state => state.ranges },
}

export function nativeHistoryBoundary(events, edit, threadId) {
  if (!edit || !threadId) return
  const seq = edit.surfaceOp.startSeq
  const start = events.slice(0, seq).findLast(event => event.type === 'turn/start')
  if (!start) return
  const end = events.findIndex((event, index) => index > seq && event.type === 'turn/end' && event.data.turn === start.data.turn)
  if (end < 0 || events.slice(start.seq, seq).some(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type))) return
  const native = events.slice(seq + 1, end).find(event =>
    event.type === 'plugin:kode/native-event' && event.data.event?.method === 'turn/started'
    && event.data.event.params?.threadId === threadId && typeof event.data.event.params.turn?.id === 'string')
  return native?.data.event.params.turn.id
}

export function claudeHistoryBoundary(session, events, edit) {
  const target = events[edit.surfaceOp.startSeq]?.data
  if (target?.content.length !== 1 || target.content[0].type !== 'text') return
  const nodes = session.surface.nodes
  const previous = events[nodes[nodes.indexOf(edit.seq) - 1]]
  // A final assistant message gives the end of the retained Claude turn.
  if (previous?.type !== 'assistant/message' || previous.data.interrupted
    || previous.data.message.content.some(part => part.type === 'tool-call')) return
  const previousText = textOf(previous.data.message)
  if (previousText && previousText !== target.content[0].text) return { previousText, targetText: target.content[0].text }
}

export const HISTORY_CONTEXT_BYTES = 12_000
function clip(text, bytes) {
  return Buffer.from(text.slice(0, bytes)).subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, '')
}
function boundedHistory(messages) {
  const header = 'Prior conversation excerpts for this edited session. Use them only as background. Do not repeat earlier requests or tool operations.\n'
  const footer = '\nEnd of prior conversation. Continue with the next user message.'
  let remaining = HISTORY_CONTEXT_BYTES - Buffer.byteLength(header + footer)
  const rows = []
  for (const message of messages.toReversed()) {
    if (remaining < 128) break
    if (!['user', 'assistant', 'tool'].includes(message.role)) continue
    const limit = Math.min(remaining - 16, message.role === 'tool' ? 256 : 3000)
    const text = message.content.filter(part => part.type === 'text').map(part => clip(part.text, limit)).join('\n')
    if (!text) continue
    const row = message.role + ': ' + clip(text, limit) + '\n'
    remaining -= Buffer.byteLength(row)
    rows.push(row)
  }
  return rows.length ? [{ type: 'text', text: header + rows.reverse().join('') + footer }] : []
}

/** The old branch editor could seed a native thread with the entire transcript.
 * Recover only its rejected first turn, on a new explicit user message. */
export function rejectedLegacyHistory(session, binding) {
  if (!binding.historyBranch || !binding.historyBootstrapped || !binding.threadId || binding.historyBranchRecovered || binding.profile.type !== 'claude') return false
  const events = session.snapshotEvents(), marker = events.findLast(event => event.type === HISTORY_EDIT)
  if (!marker) return false
  const branch = events.slice(marker.seq + 1)
  const settled = branch.filter(event => event.type === 'turn/end')
  if (settled.length !== 1) return false
  const reason = settled[0].data.reason
  if (reason?.kind !== 'error' || !/^(?:Internal error:\s*)?Prompt is too long[.!]?$/i.test(reason.error?.message?.trim() ?? '')) return false
  const rejected = branch.filter(event => event.seq < settled[0].seq)
  const compactions = new Set()
  for (const event of rejected) {
    if (event.type !== 'tool/call') continue
    const { name, arguments: args, callId } = event.data
    let item
    try { item = JSON.parse(args) } catch { return false }
    // ACP surfaces its automatic compaction as a thinking item, not a shell command.
    if (name !== 'kode_native_commandExecution' || item?.kind !== 'think' || item?.title !== 'Compact conversation' || item.command) return false
    compactions.add(callId)
  }
  return rejected.every(event => {
    if (event.type === 'assistant/message') return event.data.message.content.every(part => part.type === 'tool-call' && compactions.has(part.id))
    if (event.type === 'tool/result') return event.data.message.isError && compactions.has(event.data.message.toolCallId)
    return true
  })
}

/** Compatibility for pending edits made before in-place editing was introduced. */
export function branchHistoryInput(session, binding, incomingIds = []) {
  if (!binding.historyBranch || binding.historyBootstrapped) return []
  const events = session.snapshotEvents?.() ?? [], marker = events.findLast(event => event.type === HISTORY_EDIT)
  if (!marker) return []
  // Keep the failed edited question as a quoted excerpt when the user continues.
  const incoming = new Set(incomingIds)
  const cutoff = binding.historyBranchRecovered
    ? events.find(event => event.seq > marker.seq && event.type === 'user/message' && incoming.has(event.data.id))?.seq ?? marker.seq
    : marker.seq
  const prefix = events.slice(0, cutoff), folded = foldSurface(prefix)
  return boundedHistory(folded.nodes.map(seq => deriveEventMessage(prefix[seq], folded.projectedMessages)).filter(Boolean))
}

export function editedHistoryInput(session, edit) {
  const nodes = session.surface.nodes
  const prefix = nodes.slice(0, nodes.indexOf(edit.seq))
  return boundedHistory(prefix.map(seq => deriveEventMessage(session.eventAt(seq), session.surface.projectedMessages)).filter(Boolean))
}

export class HistoryEditor {
  constructor(ctx) { this.ctx = ctx; this.jobs = new Map() }
  edit(input) {
    if (typeof input.sessionId !== 'string' || !/^[\w-]{8,100}$/.test(input.requestId ?? '')) return Promise.reject(new Error('无效的编辑请求。'))
    const key = hash([input.sessionId, input.requestId]), fingerprint = hash([input.seq, input.text])
    const prior = this.jobs.get(input.sessionId)
    if (prior) {
      if (prior.key !== key) return Promise.reject(new Error('此会话正在处理另一条编辑。'))
      return prior.fingerprint === fingerprint ? prior.task : Promise.reject(new Error('此编辑请求已用于其他内容。'))
    }
    const task = this.submit(input, key).finally(() => this.jobs.delete(input.sessionId))
    this.jobs.set(input.sessionId, { key, fingerprint, task })
    return task
  }
  async submit(input, key) {
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new Error('会话服务暂不可用，请稍后重试。')
    const found = await controller.resolveAgent(input.sessionId)
    if (found.error) throw new Error(found.error.message)
    const agent = found.agent
    if (!agent?.isKodeNativeAgent) throw new Error('此会话的执行器暂不支持原位编辑。')
    const events = agent.session.snapshotEvents()
    const queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    const message = editedMessage(events, input.seq, input.text)
    const prior = events.find(event => event.type === 'user/message' && editId.exec(event.data.id)?.[2] === key)?.data
      ?? queued.find(row => editId.exec(row.id)?.[2] === key)
    if (prior && (historyEditTarget(prior) !== input.seq || textOf(prior) !== input.text)) throw new Error('此编辑请求已用于其他内容。')
    if (!prior) {
      if (agent.status !== 'idle' || agent.maintenance || queued.length || agent.runtime.adapter.hasContinuation?.(agent.id)
        || agent.ctx.sessionProjections.stateOf(agent.session, 'kodeGoal')?.status === 'active') throw new Error('请等待当前任务和排队消息处理完成，再编辑历史消息。')
      if (!agent.session.surface.nodes.includes(input.seq)) throw new Error('该消息已经被后续编辑替换，请刷新会话。')
      agent.followup({ ...message, id: 'history-edit-' + input.seq + '-' + key })
    }
    await agent.ctx.sessions.flush(agent.session)
    return { sessionId: agent.id }
  }
}
