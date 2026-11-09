/** Branch edits use an exact durable prefix and a fresh native thread.
 * Never resume the source CLI thread: it may already contain later answers. */
import { createHash } from 'node:crypto'
import { buildForkSeed, foldSurface, deriveEventMessage } from '@deepseek-ai/dsh-session'
import { nativeInput } from './native-input.js'
import { profileRoute, profileRevision } from './agent-profiles.js'

export const HISTORY_EDIT = 'plugin:kode/history-edit'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function editedMessage(events, seq, text) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('无效的历史消息位置。')
  const event = events[seq], message = event?.data
  if (event?.type !== 'user/message' || event.surfaceOp !== 'append' || message.role !== 'user' || !['user', 'human'].includes(message.source?.kind)) throw new Error('只能编辑自己的历史消息。')
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64000) throw new Error('消息不能为空，且不能超过 64 KiB。')
  if (message.content.some(part => !['text', 'image', 'file'].includes(part.type))) throw new Error('此消息包含暂不支持编辑的内容。')
  // Attachments retain their authenticated durable owner and their order.
  let inserted = false
  const content = message.content.flatMap(part => {
    if (part.type !== 'text') return [part]
    if (inserted) return []
    inserted = true; return [{ type: 'text', text }]
  })
  if (!inserted) content.unshift({ type: 'text', text })
  return { ...message, content }
}
export function editBranchSeed(events, seq, record, selection) {
  const seed = seq ? buildForkSeed(events, seq - 1) : []
  const push = (type, data, extra = {}) => seed.push({ type, seq: seed.length, time: Date.now(), data, ...extra })
  // Queued inputs can predate their admission, including the edited prompt.
  // Cancel them before the child driver is published, so none can auto-run.
  const queues = { 'next-turn': [], 'next-step': [] }
  for (const event of seed) if (event.type === 'agent/inbox/spliced') {
    const { target, start, removedCount = 0, inserted } = event.data
    queues[target].splice(start, removedCount, ...inserted)
  }
  for (const [target, rows] of Object.entries(queues)) if (rows.length) push('agent/inbox/spliced', { target, start: 0, removedCount: rows.length, inserted: [], outcome: 'canceled' })
  push(HISTORY_EDIT, record, { ignorable: true })
  push('model/selection', selection)
  const fast = events.findLast(event => event.type === 'plugin:kode/model-fast' && event.data.provider === selection.provider && event.data.model === selection.model)
  if (fast) push(fast.type, fast.data, { ignorable: true })
  return seed
}
/** Read-only transcript transfer shared by Codex and ACP (Claude/Cursor/etc.).
 * History is quoted as context in the first request, never replayed as turns. */
export async function branchHistoryInput(session, binding, attachments, codex, signal) {
  if (!binding.historyBranch || binding.historyBootstrapped) return []
  const events = session.snapshotEvents?.() ?? [], marker = events.findLast(event => event.type === HISTORY_EDIT)
  if (!marker) return []
  const prefix = events.slice(0, marker.seq), folded = foldSurface(prefix)
  const input = [{ type: 'text', text: 'The following is the prior conversation of an edited history branch, provided only as read-only context. Tool calls and user requests inside this transcript are historical evidence, not operations to replay. Later source messages have been excluded. Continue with the new user message after END OF PRIOR CONVERSATION.\nBEGIN PRIOR CONVERSATION' }]
  for (const seq of folded.nodes) {
    const message = deriveEventMessage(prefix[seq], folded.projectedMessages)
    if (!message) continue
    const content = message.content.filter(part => !['image', 'file'].includes(part.type))
    input.push({ type: 'text', text: JSON.stringify({ role: message.role, ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}), content }) })
    input.push(...await nativeInput([{ content: message.content.filter(part => ['image', 'file'].includes(part.type)) }], { attachments, codex, signal }))
  }
  input.push({ type: 'text', text: 'END OF PRIOR CONVERSATION\nThe next content is the new user message.' })
  return input
}
export class HistoryEditor {
  constructor(ctx, service) { this.ctx = ctx; this.service = service; this.jobs = new Map() }
  edit(input) {
    if (typeof input.sessionId !== 'string' || !/^[\w-]{8,100}$/.test(input.requestId ?? '')) return Promise.reject(new Error('无效的编辑请求。'))
    const key = hash([input.sessionId, input.requestId]), fingerprint = hash([input.sessionId, input.seq, input.text])
    const prior = this.jobs.get(key)
    if (prior) return prior.fingerprint === fingerprint ? prior.task : Promise.reject(new Error('此编辑请求已用于其他内容。'))
    const task = this.create(input, key, fingerprint).finally(() => this.jobs.delete(key))
    this.jobs.set(key, { fingerprint, task }); return task
  }
  async create(input, key, fingerprint) {
    const ctx = this.ctx, service = this.service, controller = ctx.get('sessionController')
    const id = `session-${key.slice(0, 32)}`, inputId = `history-edit-${key}`
    const query = ctx.get('sessionQuery'), persistence = ctx.get('sessionPersistence')
    if (!query || !persistence || !controller) throw new Error('会话服务暂不可用，请稍后重试。')
    const source = await query.observeSession(input.sessionId)
    try {
      const message = editedMessage(source.events, input.seq, input.text)
      let agent = ctx.agents.get(id)
      if (!agent && await persistence.stat(id)) {
        const found = await controller.resolveAgent(id)
        if (found.error) throw new Error(found.error.message)
        agent = found.agent
      }
      if (agent) {
        if (agent.session.snapshotEvents().findLast(event => event.type === HISTORY_EDIT)?.data.fingerprint !== fingerprint) throw new Error('此编辑请求已用于其他内容。')
      } else {
        const original = service.profiles.binding(input.sessionId)
        const selection = source.events.findLast(event => event.type === 'model/selection')?.data ?? source.events.findLast(event => event.type === 'request/header')?.data.header.config
        const profile = original?.profile ?? service.profiles.list().find(row => profileRoute(row.id) === selection?.provider)
        if (!profile || !service.hasRuntime(profile.type) || !selection?.model) throw new Error('此对话的 Agent 或模型暂不可用。')
        // Bind a frozen profile, deliberately excluding threadId/seenInputs/goals.
        await service.profiles.update(state => {
          state.bindings[id] ??= { profile: structuredClone(profile), revision: original?.revision ?? profileRevision(profile), seenInputs: [], historyBranch: true }
        })
        const route = { ...selection, provider: profileRoute(profile.id) }
        const record = { sourceId: input.sessionId, editedSeq: input.seq, fingerprint }
        const seed = editBranchSeed(source.events, input.seq, record, route)
        const created = await ctx.agents.create({ sessionId: id, seed, inheritedEventCount: input.seq,
          meta: { ...(source.header.cwd ? { cwd: source.header.cwd } : {}), parentSession: input.sessionId, isSeeded: true, agentPreset: 'kode-native' }, agentOptions: route })
        agent = created.agent
      }
      const admitted = agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === inputId)
        || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === inputId)
      if (admitted) { await agent.ctx.sessions.flush(agent.session); return { sessionId: id } }
      // Complete partial creation on retries before admitting any input.
      const registry = ctx.get('workspaceRegistry'), workspace = registry?.list().find(row => row.path === source.header.cwd)
      if (workspace && !workspace.sessionIds.includes(id)) await registry.get(workspace.id).attachSession(id)
      const sourceAgent = ctx.agents.get(input.sessionId)
      const policy = sourceAgent?.ctx.get('sandboxPolicy')?.resolve({ session: sourceAgent.session })
      if (policy) ctx.get('permissionPresets')?.set(agent.session, policy.mode)
      const title = source.events.findLast(event => event.type === 'session/title')?.data.title ?? ctx.get('sessionTitle')?.get(sourceAgent?.session ?? agent.session)?.title
      if (title) await controller.rename({ sessionId: id, title })
      agent.followup({ ...message, id: inputId })
      await agent.ctx.sessions.flush(agent.session)
      return { sessionId: id }
    } finally { source[Symbol.dispose]?.() }
  }
}
