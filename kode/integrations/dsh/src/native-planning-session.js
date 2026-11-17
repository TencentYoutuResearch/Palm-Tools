/** Draft navigation metadata for an ordinary, fresh native conversation.
 * This is not Team execution authority. Only the owner-side durable registry
 * can admit it; browser metadata and profile roles never establish the marker.
 */
import { planningCompletion, completionAuthority, assertCompletionRuntime, assertCompletionJournal, PLANNING_COMPLETION_RECORD } from './native-planning-completion.js'
import { PLANNING_CONTEXT_RECORD, PLANNING_TURN_CONTEXT_RECORD, validatePlanningContext, planningSnapshotFields, persistedPlanningContext, planningTurnContext } from './planning-draft-context.js'
import { symbols } from '@deepseek-ai/cordis'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute } from 'node:path'
import { BUILDER_PROMPT_RECORD, validateBuilderPrompt, assertBuilderPromptJournal } from './builder-settings.js'
const bindings = new WeakMap()
const prompts = new WeakMap()
const promptVersions = new WeakMap()
const actual = agent => agent?.[symbols.original] ?? agent
export const NATIVE_PLANNING_RECORD = 'plugin:kode/interactive-planning'
export const nativePlanningBinding = agent => bindings.get(actual(agent))
export const nativePlanningPromptVersion = agent => promptVersions.get(actual(agent))
export const nativePlanningPrompt = agent => prompts.get(actual(agent))
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const fail = message => Object.assign(Error(message), { code: 'NATIVE_PLANNING_REJECTED' })
export function validatePlanningBinding(value) {
  const privateLocation = value?.location !== undefined
  const keys = ['version', 'mode', 'home_hub', 'draft_id', 'context_epoch', 'session_id', 'workspace_id', 'cwd', ...(privateLocation ? ['location'] : [])]
  if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k))
    || value.version !== 1 || value.mode !== 'interactive_planning'
    || !['home_hub', 'draft_id'].every(k => token(value[k]))
    || (privateLocation ? value.workspace_id !== null : !token(value.workspace_id))
    || !/^session-[a-f0-9-]{36}$/.test(value.session_id)
    || !Number.isSafeInteger(value.context_epoch) || value.context_epoch < 1
    || typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || value.cwd.includes('\0')) throw fail('Invalid trusted planning binding')
  if (privateLocation && (!value.location || Object.keys(value.location).sort().join(',') !== 'device,inode,kind'
    || value.location.kind !== 'private_planning' || typeof value.location.device !== 'string' || typeof value.location.inode !== 'string'
    || !/^[0-9]+$/.test(value.location.device) || !/^[1-9][0-9]*$/.test(value.location.inode))) throw fail('Invalid private planning directory identity')
  const binding = structuredClone(value)
  if (privateLocation) Object.freeze(binding.location)
  return Object.freeze(binding)
}
export async function prepareNativePlanningSession(ctx, options, restore) {
  const id = options.resumeSessionId ?? options.sessionId
  const service = ctx.get('kodePlanningRuntime')
  const completion = planningCompletion(options)
  const admission = completion ? await completionAuthority(ctx, completion.command, id) : await service?.sessionAdmission(id, { mode: restore ? 'restore' : 'fresh' })
  if (completion && !isDeepStrictEqual(admission, completion.admitted)) throw fail('Planning completion authority changed')
  if (!admission) return undefined
  const binding = validatePlanningBinding(admission.binding)
  const prompt = admission.builder_prompt === undefined ? undefined : validateBuilderPrompt(admission.builder_prompt)
  if (binding.session_id !== id || options.seed !== undefined || options.inheritedEventCount !== undefined
    || options.parentAgent !== undefined || options.meta?.parentSessionId !== undefined || options.meta?.parentSession !== undefined || options.meta?.isSeeded) throw fail('Planning requires its own fresh conversation')
  const frozen = planningSnapshotFields(admission, binding.home_hub)
  let prefix
  return {
    completion: Boolean(completion),
    async verifyStored(header, events, inherited) {
      if (!completion || !isDeepStrictEqual(await completionAuthority(ctx, completion.command, id), admission)) throw fail('Planning completion authority changed under writer')
      prefix = assertCompletionJournal(header, events, inherited, admission, assertCompletionRuntime(ctx, admission))
    },
    async check(agent) {
      if (!completion || !isDeepStrictEqual(await completionAuthority(ctx, completion.command, id), admission)) throw fail('Planning completion authority changed before publication')
      assertCompletionRuntime(ctx, admission)
      if (bindings.get(actual(agent)) !== binding) throw fail('Planning completion native owner changed')
    },
    binding, selection: structuredClone(admission.selection),
    bind(session) {
      if (session.id !== id || session.header.cwd !== binding.cwd || session.header.parentSessionId || session.header.parentSession) throw fail('Planning session workspace or parent changed')
      const events = session.snapshotEvents(), marks = events.filter(e => e.type === NATIVE_PLANNING_RECORD)
      if (completion) {
        // The installed Session constructor appends this one local restore boundary.
        // The persisted input was proven to contain exactly four setup events.
        if (events.length !== 5 || session.firstLiveSeq !== 4 || session.firstLifecycleSeq !== 4
          || events[4].seq !== 4 || events[4].type !== 'session/end-seed' || !isDeepStrictEqual(events[4].data, {})) throw fail('Unexpected planning restore suffix')
        const expected = assertCompletionJournal(session.header, events.slice(0, 4), session.inheritedEventCount ?? 0, admission, assertCompletionRuntime(ctx, admission))
        if (!prefix || expected !== prefix) throw fail('Planning partial changed after writer admission')
        const context = validatePlanningContext(admission.context, binding)
        appendPluginRecord(session, PLANNING_COMPLETION_RECORD, { version: 1, request_id: admission.request_id, session_id: id, draft_id: binding.draft_id, home_hub: binding.home_hub, prefix_sha256: prefix })
        appendPluginRecord(session, NATIVE_PLANNING_RECORD, binding)
        appendPluginRecord(session, PLANNING_CONTEXT_RECORD, context)
      } else if (restore) {
        if (marks.length !== 1 || !isDeepStrictEqual(marks[0].data, binding)) throw fail('Planning journal binding changed or missing')
      } else {
        if (events.length || marks.length) throw fail('Cannot adopt existing history as a draft conversation')
        const context = validatePlanningContext(admission.context, binding)
        appendPluginRecord(session, NATIVE_PLANNING_RECORD, binding)
        appendPluginRecord(session, PLANNING_CONTEXT_RECORD, context)
      }
      if (!restore || completion) {
        if (prompt) appendPluginRecord(session, BUILDER_PROMPT_RECORD, prompt)
      }
      const context = persistedPlanningContext(session.snapshotEvents(), binding)
      if (!isDeepStrictEqual(planningSnapshotFields(context.data, binding.home_hub), frozen)) throw fail('Planning journal prompt version or resources changed')
      assertBuilderPromptJournal(session.snapshotEvents(), prompt)
    },
    attach(agent) { if (frozen.planning_prompt_version) promptVersions.set(actual(agent), frozen.planning_prompt_version); bindings.set(actual(agent), binding); if (prompt) prompts.set(actual(agent), prompt) },
    close(agent) { if (agent) { promptVersions.delete(actual(agent)); bindings.delete(actual(agent)); prompts.delete(actual(agent)) } },
  }
}
export function assertPlanningJournalAdmission(session, admitted) {
  const marks = session.snapshotEvents().filter(e => e.type === NATIVE_PLANNING_RECORD)
  if (!admitted && marks.length) throw fail('Planning registry unavailable; refusing ordinary-session fallback')
  if (admitted && (marks.length !== 1 || !isDeepStrictEqual(marks[0].data, admitted.binding))) throw fail('Planning journal binding changed or missing')
}

/** Check before claiming a queued message so stale input remains pending. */
export async function checkNativePlanningContext(agent) {
  const binding = nativePlanningBinding(agent)
  if (!binding) return null
  const snapshot = persistedPlanningContext(agent.session.snapshotEvents(), binding)
  const service = agent.ctx.get('kodePlanningRuntime')
  if (typeof service?.readContext !== 'function') throw Object.assign(Error('Planning draft context reader unavailable'), { code: 'PLANNING_CONTEXT_MISSING' })
  const current = validatePlanningContext(await service.readContext(agent.id), binding)
  if (!isDeepStrictEqual(current, snapshot)) throw Object.assign(Error('Draft revision changed; explicitly reconfirm context. Existing input and conversation were not rebound.'), { code: 'PLANNING_CONTEXT_CHANGED' })
  return snapshot
}
export async function recordNativePlanningTurn(agent, snapshot, turn, messages) {
  if (!snapshot) return
  const binding = nativePlanningBinding(agent)
  if (!binding || !isDeepStrictEqual(persistedPlanningContext(agent.session.snapshotEvents(), binding), snapshot) || !messages.length) throw fail('Planning turn context changed')
  appendPluginRecord(agent.session, PLANNING_TURN_CONTEXT_RECORD, { version: 1, session_id: agent.id, turn,
    draft_revision: snapshot.draft_revision, sha256: snapshot.sha256, input_ids: messages.map(message => message.id) })
  if (await agent.ctx.sessions.flush(agent.session) !== true) throw fail('Planning turn context was not durably saved')
}
export async function assertNativePlanningTurnContext(agent, messages) {
  const binding = nativePlanningBinding(agent)
  if (!binding) return null
  const current = await checkNativePlanningContext(agent)
  const { snapshot, record } = planningTurnContext(agent.session.snapshotEvents(), binding, agent.turn)
  if (!isDeepStrictEqual(current, snapshot) || messages && !isDeepStrictEqual(record.input_ids, messages.map(message => message.id))) throw fail('Planning turn context does not match this input')
  return snapshot
}
