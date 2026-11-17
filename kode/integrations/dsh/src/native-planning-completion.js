/** Narrow completion of the original reserved, setup-only planning identity.
 * Not a general Session adoption API; ordinary restore remains unchanged.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { profileRevision } from './agent-profiles.js'
import { appendFastPreference } from './model-fast.js'
const requests = new WeakMap()
export const PLANNING_COMPLETION_RECORD = 'plugin:kode/planning-creation-completed'
const reject = text => Object.assign(Error(text), { code: 'PLANNING_PARTIAL_NOT_PROVEN' })
export const planningCompletion = options => requests.get(options)
export async function completionAuthority(ctx, command, id) {
  const service = ctx.get('kodePlanningRuntime')
  if (typeof service?.completionAdmission !== 'function') throw reject('Planning completion authority unavailable')
  const admitted = await service.completionAdmission(id, structuredClone(command))
  if (!admitted || admitted.binding?.session_id !== id || admitted.binding?.mode !== 'interactive_planning' || admitted.request_id !== command.request_id || admitted.binding.draft_id !== command.draft_id) throw reject('Original planning request does not match')
  return structuredClone(admitted)
}
export function assertCompletionRuntime(ctx, admitted) {
  const id = admitted.binding.session_id, service = ctx.get('kodeAgents'), profiles = service?.profiles, adapter = service?.adapter
  const bound = profiles?.binding(id), profile = profiles?.list().find(p => p.id === admitted.profile_id)
  if (!bound || !profile || !isDeepStrictEqual(bound.profile, profile) || bound.revision !== profileRevision(profile)
    || !service.hasRuntime?.(profile.type) || admitted.selection.fast === true
    || bound.officialToolArchive || Object.keys(bound.officialCalls ?? {}).length || Object.keys(bound.officialTools ?? {}).length
    || bound.quotaFenceRevision || bound.remoteQuotaFences?.length || Object.keys(bound.usageOutbox ?? {}).length
    || admitted.selection.provider !== `kode-agent-${profile.id}` || profile.type === 'dsh'
    || Object.keys(bound).some(k => k.startsWith('managed') && bound[k] != null)
    || bound.threadId || bound.historySource || bound.historyBranch || bound.historyBootstrapped || bound.inFlight
    || !Array.isArray(bound.seenInputs) || bound.seenInputs.length || bound.stopBlocked
    || typeof adapter?.hasContinuation !== 'function' || adapter.hasContinuation(id) !== false || adapter.live?.has(id) || adapter.busy?.has(id)) throw reject('Planning partial has native execution or incompatible profile lineage')
  const live = ctx.get('agents')?.get(id)
  if (live && (live.status !== 'idle' || live.inbox.nextTurn.length || live.inbox.nextStep.length || live.activeInputs?.size)) throw reject('Planning partial has active or queued work')
  return profile
}
export function assertCompletionJournal(header, events, inherited, admitted, profile) {
  const binding = admitted.binding
  if (header.id !== binding.session_id || header.cwd !== binding.cwd || header.agentPreset !== 'kode-native' || header.parentSession !== undefined || header.parentSessionId !== undefined || header.isSeeded || header.origin !== undefined || (header.delegationDepth ?? 0) !== 0 || inherited !== 0) throw reject('Planning partial header is not the original fresh identity')
  const expected = ['permission/preset','sandbox/mode','approval/policy','plugin:kode/agent-binding']
  if (!Array.isArray(events) || events.length !== expected.length || events.some((e, i) => e.type !== expected[i] || e.seq !== i)) throw reject('Planning partial is not the exact setup-only journal')
  const recorded = events[3].data
  if (!recorded || Object.keys(recorded).sort().join(',') !== 'name,profileId,type,uiChannel' || recorded.profileId !== profile.id || recorded.type !== profile.type || recorded.name !== profile.name || typeof recorded.uiChannel !== 'string') throw reject('Planning partial profile marker changed')
  return createHash('sha256').update(JSON.stringify({ header, events, inherited })).digest('hex')
}
export async function planningCompletionOptions(ctx, command, id) {
  const admitted = await completionAuthority(ctx, command, id)
  assertCompletionRuntime(ctx, admitted)
  const options = { resumeSessionId: id, agentOptions: structuredClone(admitted.selection), setup: async (_ctx, driver) => {
    driver.selectModel(admitted.selection)
    if (admitted.selection.fast === false) appendFastPreference(driver.session, admitted.selection, false)
  } }
  requests.set(options, { command: structuredClone(command), admitted })
  return options
}
