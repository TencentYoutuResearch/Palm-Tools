/** Read-only observations of children owned by native Agents. */
import { z } from 'zod'

export function subagentStatus(value) {
  const status = typeof value === 'string' ? value : value?.state ?? value?.status
  if (['running', 'pendingInit', 'in_progress', 'inProgress', 'working'].includes(status)) return 'running'
  if (['completed', 'done'].includes(status)) return 'completed'
  if (['failed', 'errored', 'error'].includes(status)) return 'failed'
  if (['cancelled', 'killed', 'stopped', 'interrupted', 'shutdown'].includes(status)) return 'cancelled'
  if (status === 'idle') return 'idle'
  if (['notFound', 'disconnected'].includes(status)) return 'disconnected'
  return 'unknown'
}
export function acpSubagents(update) {
  if (update.sessionUpdate === 'subagent_spawned') return [{ id: update.subagentSessionId, name: update.name, task: update.task ?? update.prompt, status: 'running' }]
  if (update.sessionUpdate === 'subagent_state_update') return [{ id: update.subagentSessionId, status: subagentStatus(update.state) }]
  if (update.sessionUpdate === 'subagent_update') return [{ id: update.sessionId, name: update.title, task: update.description, ...(update.state ? { status: subagentStatus(update.state) } : {}) }]
  const team = update._meta?.['codebuddy.ai/teamUpdate']
  return (Array.isArray(team?.members) ? team.members : []).map(member => ({ id: member.sessionId ?? member.taskId ?? `member:${member.name}`, member: member.name, name: member.name, task: member.description, status: subagentStatus(member.status), model: member.model }))
}
export function codexSubagents(item) {
  if (item?.type !== 'collabAgentToolCall') return []
  return [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])].map(id => {
    const state = item.agentsStates?.[id]
    return { id, ...(item.tool === 'spawnAgent' ? { task: item.prompt, model: item.model } : {}),
      ...(state ? { status: subagentStatus(state.status), text: state.message } : item.tool === 'spawnAgent' ? { status: 'running' } : {}) }
  })
}
export function nativeSubagentRecord(update) {
  if (typeof update.id !== 'string' || !update.id || update.id.length > 512) return
  const record = { id: update.id }
  const limits = { name: 200, task: 4096, model: 200, status: 32, text: 32768, delta: 32768 }
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof update[key] === 'string') record[key] = update[key].slice(0, limit)
  }
  return record
}
const childSchema = z.object({ id: z.string(), name: z.string().optional(), task: z.string().optional(), model: z.string().optional(), status: z.string(), output: z.string() })
const stateSchema = z.record(z.string(), childSchema)
export function foldNativeSubagent(state, update) {
  const previous = state[update.id] ?? { id: update.id, status: 'unknown', output: '' }
  const next = { ...previous }
  for (const [key, limit] of [['name', 200], ['task', 4096], ['model', 200], ['status', 32]]) {
    if (typeof update[key] === 'string' && update[key]) next[key] = update[key].slice(0, limit)
  }
  if (typeof update.text === 'string') next.output = update.text.slice(-32768)
  if (typeof update.delta === 'string') next.output = (next.output + update.delta).slice(-32768)
  const entries = Object.entries({ ...state, [update.id]: next }).slice(-256)
  return Object.fromEntries(entries)
}
export const nativeSubagentsProjection = {
  key: 'kodeNativeSubagents', stateVersion: 1, stateSchema, init: () => ({}),
  apply: (state, event) => event.type === 'plugin:kode/subagent-update' ? foldNativeSubagent(state, event.data) : state,
  wire: { viewSchema: stateSchema, view: state => state },
}
