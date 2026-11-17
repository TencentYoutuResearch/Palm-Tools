import { createPlanningHandoff, planningRecordFor, pendingPlanningHandoff } from './builder-planning-handoff.js'
import { BUILDER_PLANNING_PROMPT_V2_VERSION } from './builder-planning-prompt-v2.js'
import { readBuilderPrompt } from './builder-settings.js'
/** Owner-managed draft navigation. No Team operation, credential or model tool. */
import { snapshotPlanningDraft, planningSnapshotFields } from './planning-draft-context.js'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BackendDocument } from './backend-state.js'
import { profileRoute } from './agent-profiles.js'
import { selectModelPlan } from './model-selection.js'
import { resolveDefaultSelection } from './model-alias.js'
import { validatePlanningBinding } from './native-planning-session.js'
import { createPrivatePlanningLocation, assertPrivatePlanningLocation } from './planning-private-directory.js'
// Reuse the existing owner-authorized session document. Hub deliberately does
// not expose arbitrary workbench document names, and normal native resume must
// not depend on a new, unsupported document route.
const documentKey = 'session-index'
const registryKey = 'builderPlanning'
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const keyOf = (home, draft) => createHash('sha256').update(JSON.stringify([home, draft])).digest('hex')
const fail = (code, message) => Object.assign(Error(message), { code })
const fields = ['draft_id', 'draft_revision', 'request_id', 'profile_id', 'model', 'reasoning_effort', 'workspace_id', 'complete_partial']
export function createBuilderPlanningSessions({ ctx, backendClient, home, service, bridge, readResources }) {
  let chain = Promise.resolve()
  const jobs = new Map()
  const registry = index => {
    if (!index || typeof index !== 'object' || Array.isArray(index)) throw fail('PLANNING_REGISTRY_INVALID', 'Session index requires repair')
    const value = index[registryKey]
    if (value === undefined) return { version: 1, sessions: {} }
    if (!value || value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) throw fail('PLANNING_REGISTRY_INVALID', 'Planning registry requires repair')
    return value
  }
  const read = async () => registry(await new BackendDocument(backendClient, documentKey).read() ?? {})
  const update = operation => {
    const task = chain.then(async () => {
      for (let n = 0; n < 4; n++) {
        const document = new BackendDocument(backendClient, documentKey)
        const index = await document.read() ?? { version: 1 }
        const state = registry(index)
        const result = operation(state)
        index[registryKey] = state
        // Preserve native_sessions, gui, creations, presentation and all other
        // index owners. A CAS retry rereads their latest changes before merging.
        try { await document.write(index); return structuredClone(result) }
        catch (error) { if (n === 3 || !/configuration changed/.test(error.message)) throw error }
      }
    })
    chain = task.catch(() => {}); return task
  }
  async function freezePlanningResources(binding, draft, previous) {
    if (typeof readResources !== 'function') {
      if (previous?.planning_prompt_version !== undefined) throw fail('PLANNING_CONTEXT_INVALID', 'Resource reader unavailable for versioned successor')
      return {}
    }
    return planningSnapshotFields({ planning_prompt_version: BUILDER_PLANNING_PROMPT_V2_VERSION,
      resources_snapshot: await readResources({ binding, draft }) }, home)
  }
  async function draftState(id) {
    if (!token(id)) throw fail('INVALID_REQUEST', 'Draft identity required')
    const path = `/api/v1/messaging/superagents/drafts/${encodeURIComponent(id)}`
    const [draft, selected] = await Promise.all([backendClient.call(path), backendClient.call(`${path}/selection`)])
    if (draft?.id !== id || draft.home_hub !== home || selected?.draft_id !== id || selected.home_hub !== home) throw fail('DRAFT_IDENTITY_CHANGED', 'Draft belongs to another home')
    if (draft.status !== 'draft') throw fail('DRAFT_UNAVAILABLE', 'Draft is no longer editable')
    if (selected.runtime_binding) throw fail('CONTROLLED_BUILDER_CONFLICT', 'Draft already has a controlled Builder operation; inspect it before opening a planning conversation')
    return { draft, selected }
  }
  async function currentWorkspace(binding, draft) {
    if (binding.location?.kind === 'private_planning') {
      await assertPrivatePlanningLocation(binding, service.profiles?.path)
      return
    }
    const workspace = ctx.get('workspaceRegistry')?.get(binding.workspace_id)
    if (!workspace || workspace.path !== binding.cwd || !draft.interview?.workspace_refs?.some(w => w.host_id === home && w.workspace_id === binding.workspace_id && w.root_ref === binding.cwd)) throw fail('PLANNING_WORKSPACE_CHANGED', 'Draft workspace changed; the existing conversation will not be rebound')
  }
  function response(record, disposition) {
    const { location, cwd, ...binding } = validatePlanningBinding(record.binding)
    return { ...binding, ...(location ? { location: { kind: location.kind } } : { cwd }), state: record.stage === 'ready' ? 'ready' : 'uncertain',
      disposition, initial_selection: structuredClone(record.selection), execution_authorized: false,
      ...(record.stage !== 'ready' && record.request_input ? { retry_request: structuredClone(record.request_input) } : {}) }
  }
  async function sessionAdmission(id, { mode } = {}) {
    const state = await read(), found = planningRecordFor(state, id)
    if (!found) return undefined
    const record = found.record, binding = validatePlanningBinding(record.binding)
    if (binding.home_hub !== home || found.kind === 'history' && mode === 'fresh' || !['fresh', 'restore'].includes(mode) || mode === 'fresh' && record.stage !== 'creating'
      || mode === 'restore' && record.stage !== 'ready') throw fail('PLANNING_RECONCILIATION_REQUIRED', 'Planning creation outcome requires inspection')
    const { draft } = await draftState(binding.draft_id); await currentWorkspace(binding, draft)
    if (mode === 'fresh' && draft.revision !== record.request_input?.draft_revision) throw fail('PLANNING_CONTEXT_CHANGED', 'Draft changed after reservation; creation requires reconciliation')
    return { binding, ...planningSnapshotFields(record, home), selection: structuredClone(record.selection), ...(record.builder_prompt ? { builder_prompt: structuredClone(record.builder_prompt) } : {}), ...(mode === 'fresh' ? { context: snapshotPlanningDraft(binding, draft, record) } : {}) }
  }
  async function inspect(id) {
    const { draft } = await draftState(id)
    const record = (await read()).sessions[keyOf(home, id)]
    if (!record) return { version: 1, mode: 'interactive_planning', home_hub: home, draft_id: id, state: 'not_created', execution_authorized: false }
    await currentWorkspace(validatePlanningBinding(record.binding), draft)
    return response(record, 'recovered')
  }
  async function open(input) {
    if (!input || Object.keys(input).some(k => !fields.includes(k)) || !token(input.draft_id) || !token(input.request_id)
      || !Number.isSafeInteger(input.draft_revision) || input.draft_revision < 1
      || ['profile_id', 'workspace_id'].some(k => input[k] !== undefined && !token(input[k]))
      || ['model', 'reasoning_effort'].some(k => input[k] !== undefined && (typeof input[k] !== 'string' || !input[k].trim() || input[k].length > 256 || input[k].includes('\0')))) throw fail('INVALID_REQUEST', 'Invalid planning request')
    if (input.complete_partial !== undefined && input.complete_partial !== true) throw fail('INVALID_REQUEST', 'Partial completion must be explicitly requested')
    input = structuredClone(input)
    const completePartial = input.complete_partial === true
    delete input.complete_partial
    const key = keyOf(home, input.draft_id), pending = jobs.get(key)
    if (pending) {
      if (pending.completePartial !== completePartial || !isDeepStrictEqual(pending.input, input)) throw fail('PLANNING_CREATION_IN_PROGRESS', 'A planning conversation is being created for this draft')
      return pending.task
    }
    const task = (async () => {
      const { draft, selected } = await draftState(input.draft_id)
      let prior = (await read()).sessions[key]
      if (prior) {
        const binding = validatePlanningBinding(prior.binding); await currentWorkspace(binding, draft)
        if (prior.stage !== 'ready') {
          if (prior.stage !== 'creating' || !isDeepStrictEqual(prior.request_input, input) || typeof bridge.proveExisting !== 'function') throw fail('PLANNING_RECONCILIATION_REQUIRED', 'Creation outcome is uncertain; recover the exact original request without creating a replacement')
          // Only the original fixed identity is inspected. The bridge must not
          // resolve/start a session or guess another conversation during proof.
          let proof
          if (completePartial) {
            if (typeof bridge.completePartial !== 'function') throw fail('PLANNING_RECONCILIATION_REQUIRED', 'Explicit partial completion is unavailable')
            proof = await bridge.completePartial({ binding, command: input })
          } else proof = await bridge.proveExisting({ binding, profile_id: prior.profile_id, selection: prior.selection })
          if (proof?.session_id !== binding.session_id || proof.cwd !== binding.cwd || proof.verified !== true) throw fail('PLANNING_RECONCILIATION_REQUIRED', 'Original planning session has insufficient recovery evidence')
          const expected = structuredClone(prior)
          prior = await update(state => {
            const row = state.sessions[key]
            if (!row || !['creating', 'ready'].includes(row.stage) || !isDeepStrictEqual({ ...row, stage: 'creating' }, expected)) throw fail('PLANNING_REGISTRY_CHANGED', 'Planning reservation changed during recovery')
            row.stage = 'ready'; return row
          })
        }
        if (input.workspace_id !== undefined && input.workspace_id !== binding.workspace_id
          || input.profile_id !== undefined && input.profile_id !== prior.profile_id
          || input.model !== undefined && input.model !== prior.selection.model
          || input.reasoning_effort !== undefined && input.reasoning_effort !== prior.selection.reasoningEffort) throw fail('PLANNING_ALREADY_BOUND', 'Open the original conversation to change its model; draft binding will not be replaced')
        const actual = await bridge.inspect(binding.session_id)
        if (actual.session_id !== binding.session_id || actual.cwd !== binding.cwd) throw fail('PLANNING_IDENTITY_CHANGED', 'Original planning session could not be verified')
        return response(prior, 'recovered')
      }
      if (completePartial) throw fail('PLANNING_PARTIAL_NOT_PROVEN', 'Partial completion cannot create a new reservation')
      if (draft.revision !== input.draft_revision) throw fail('DRAFT_REVISION_CHANGED', 'Draft changed; refresh before opening planning')
      const refs = draft.interview?.workspace_refs?.filter(w => w.host_id === home) ?? []
      const saved = selected.record?.selection
      // Explicit legacy workspace choices remain compatible. New planning
      // requests never inherit a saved project selection or the Host cwd.
      const ref = input.workspace_id === undefined ? undefined : refs.find(w => w.workspace_id === input.workspace_id)
      if (input.workspace_id !== undefined && !ref) throw fail('PLANNING_WORKSPACE_REQUIRED', 'Selected draft workspace is unavailable on this Host')
      await service.profiles.reload?.()
      const profileId = input.profile_id ?? saved?.profile_id ?? service.profiles.defaultProfileId
      const profile = (service.profiles.listAgents?.() ?? service.profiles.list()).find(p => p.id === profileId)
      if (!profile || profile.type === 'dsh' || !service.hasRuntime(profile.type)) throw fail('NATIVE_AGENT_UNAVAILABLE', 'Choose an installed native Agent in settings')
      const defaults = service.profiles.defaultModelFor?.(profile.id) ?? {}
      const reuseSaved = input.profile_id === undefined && saved?.profile_id === profile.id
      const model = input.model ?? (reuseSaved ? saved.model : undefined) ?? defaults.model
      const effort = input.reasoning_effort ?? (reuseSaved ? saved.effort ?? undefined : undefined) ?? defaults.reasoningEffort
      const models = await service.adapter.listModels(profileRoute(profile.id), profile, model)
      const planned = selectModelPlan(profile, models, { model, reasoningEffort: effort })
      const resolved = resolveDefaultSelection(models, { ...planned, ...(defaults.fast === undefined ? {} : { fast: defaults.fast }) }, planned.model)
      const selection = { ...selectModelPlan(profile, models, resolved), ...(resolved.fast === undefined ? {} : { fast: resolved.fast }) }
      const latest = await draftState(input.draft_id)
      if (latest.draft.revision !== draft.revision || !isDeepStrictEqual(latest.selected, selected)) throw fail('DRAFT_REVISION_CHANGED', 'Draft configuration changed during preparation')
      const sessionId = `session-${randomUUID()}`
      const location = ref ? { workspace_id: ref.workspace_id, cwd: ref.root_ref }
        : await createPrivatePlanningLocation({ profilesPath: service.profiles.path, home, draftId: input.draft_id, sessionId })
      const binding = validatePlanningBinding({ version: 1, mode: 'interactive_planning', home_hub: home,
        draft_id: input.draft_id, context_epoch: 1, session_id: sessionId, ...location })
      await currentWorkspace(binding, latest.draft)
      const builder_prompt = await readBuilderPrompt(service.profiles)
      const frozen = await freezePlanningResources(binding, latest.draft)
      const record = { binding, ...frozen, builder_prompt, profile_id: profile.id, selection, request_id: input.request_id, request_input: input, stage: 'creating' }
      await update(state => {
        if (state.sessions[key]) throw fail('PLANNING_CREATION_IN_PROGRESS', 'Another request already reserved this draft conversation')
        state.sessions[key] = record
      })
      const actual = await bridge.create({ session_id: binding.session_id, workspace_id: binding.workspace_id,
        profile_id: profile.id, selection, title: `Team planning: ${draft.interview.purpose.slice(0, 120)}` })
      if (actual.session_id !== binding.session_id || actual.cwd !== binding.cwd) throw fail('PLANNING_IDENTITY_CHANGED', 'Native creation changed identity; inspect the original session')
      const ready = await update(state => {
        const row = state.sessions[key]
        if (!row || !['creating', 'ready'].includes(row.stage) || !isDeepStrictEqual({ ...row, stage: 'creating' }, record)) throw fail('PLANNING_REGISTRY_CHANGED', 'Planning reservation changed')
        row.stage = 'ready'; return row
      })
      return response(ready, 'fresh')
    })()
    jobs.set(key, { input, task, completePartial })
    try { return await task } finally { if (jobs.get(key)?.task === task) jobs.delete(key) }
  }
  async function completionAdmission(id, command) {
    const state = await read(), records = Object.values(state.sessions).filter(row => row.binding?.session_id === id)
    if (records.length !== 1) throw fail('PLANNING_PARTIAL_NOT_PROVEN', 'Original reserved Session is not unique')
    const row = records[0], binding = validatePlanningBinding(row.binding)
    const { draft } = await draftState(binding.draft_id)
    if (row.stage !== 'creating' || binding.home_hub !== home || !isDeepStrictEqual(row.request_input, command) || row.request_id !== command.request_id || draft.revision !== command.draft_revision) throw fail('PLANNING_PARTIAL_NOT_PROVEN', 'Original partial creation authority changed')
    await currentWorkspace(binding, draft)
    return { binding, ...planningSnapshotFields(row, home), selection: structuredClone(row.selection), ...(row.builder_prompt ? { builder_prompt: structuredClone(row.builder_prompt) } : {}), profile_id: row.profile_id, request_id: row.request_id, context: snapshotPlanningDraft(binding, draft, row) }
  }
  function activeRecord(state, id) {
    const found = planningRecordFor(state, id)
    if (!found) throw fail('PLANNING_CONTEXT_MISSING', 'Unknown planning context')
    if (found.kind !== 'current') throw fail('PLANNING_SESSION_SUPERSEDED', 'This planning generation is read-only')
    if (pendingPlanningHandoff(state, id)) throw fail('PLANNING_HANDOFF_PENDING', 'Planning successor preparation is pending; no input was sent')
    const binding = validatePlanningBinding(found.record.binding)
    if (binding.home_hub !== home || found.record.stage !== 'ready') throw fail('PLANNING_CONTEXT_MISSING', 'Active planning identity is unavailable')
    return found.record
  }
  async function readContext(id) {
    const record = activeRecord(await read(), id), binding = validatePlanningBinding(record.binding)
    const { draft } = await draftState(binding.draft_id)
    await currentWorkspace(binding, draft)
    const context = snapshotPlanningDraft(binding, draft, record)
    // Restore permission for an archived journal is not input/candidate permission.
    // Linearize after asynchronous draft and location reads, including a pending
    // reservation that has not yet switched the current pointer.
    const latest = activeRecord(await read(), id)
    if (!isDeepStrictEqual(latest, record)) throw fail('PLANNING_SESSION_SUPERSEDED', 'Planning generation changed while reading')
    return context
  }
  const transition=createPlanningHandoff({service,home,read,update,draftState,currentWorkspace,bridge,response,keyOf,jobs,freezePlanningResources})
  return Object.freeze({ sessionAdmission, inspect, open, readContext, completionAdmission, handoffStatus:transition.status, prepareHandoff:transition.prepare, handoff:transition.handoff })
}
