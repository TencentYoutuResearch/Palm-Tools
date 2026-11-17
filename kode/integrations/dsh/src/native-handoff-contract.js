import {nativeInteractiveTeamBinding,INTERACTIVE_TEAM_RECORD,assertNoInteractiveHistoryCopy} from './native-interactive-team.js'
import { nativePlanningBinding, NATIVE_PLANNING_RECORD } from './native-planning-session.js'
/** The existing runtime mailbox prepares native handoffs. No registry or grant is created. */
import { isDeepStrictEqual } from 'node:util'
import { profileRevision, profileRoute } from './agent-profiles.js'
import { resolveDefaultSelection } from './model-alias.js'
import { SUPPORTED_AGENT_TYPES } from './native-session.js'
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const fail = (message, code) => Object.assign(Error(message), { code, status: 409 })
export function normalizeHandoffSelection(value) {
  if (value === undefined || value === null) return undefined
  if (!object(value) || Object.keys(value).some(key => !['model', 'reasoningEffort', 'fast'].includes(key))) throw Error('Invalid native handoff selection')
  for (const key of ['model', 'reasoningEffort']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 256 || /[\x00-\x1f\x7f]/.test(value[key]))) throw Error('Invalid native handoff selection')
  if (value.fast !== undefined && typeof value.fast !== 'boolean') throw Error('Invalid native handoff Fast selection')
  return structuredClone(value)
}
export function assertOrdinaryHandoffSource(profiles, sessionId, agent, row) {
  const binding = profiles.binding(sessionId), header = agent?.session?.header
  if(nativeInteractiveTeamBinding(agent)||agent?.session?.snapshotEvents?.().some(e=>e.type===INTERACTIVE_TEAM_RECORD))throw fail('Interactive Team cannot use ordinary handoff.','INTERACTIVE_TEAM_HANDOFF_REQUIRED')
  if (nativePlanningBinding(agent) || agent?.session?.snapshotEvents?.().some(event => event.type === NATIVE_PLANNING_RECORD)) throw fail('规划会话必须通过草案身份继任交接。', 'PLANNING_HANDOFF_REQUIRED')
  const controlled = binding && ['managedOperation', 'managedAssignment', 'managedCoordinator', 'managedBuilder', 'context_scope'].some(key => binding[key] != null)
    || binding?.contextIsolation === 'scoped_v2' || header?.context_scope || row?.context_scope
    || /^(?:builder-context-|context-)[a-f0-9]{64}$/.test(sessionId)
    || agent?.session?.snapshotEvents?.().some(event => ['plugin:kode/scoped-builder-journal', 'plugin:kode/scoped-coordinator-journal'].includes(event.type))
  if (controlled) throw fail('受控 SuperAgent 需要身份继任交接，不能使用普通会话交接。', 'MANAGED_HANDOFF_REQUIRED')
  if (!binding?.profile) throw fail('无法确认来源会话的原生身份，交接尚未开始。', 'HANDOFF_SOURCE_UNCONFIRMED')
  if (agent && agent.status !== 'idle' || row?.running === true || row?.busy === true || row?.status === 'running' || row?.status === 'busy') throw fail('请等待当前会话停止运行后再交接。', 'HANDOFF_SOURCE_BUSY')
  return binding
}
export async function assertOrdinaryHandoffIdentity(bridge,sessionId) {
  if(await bridge.service('kodePlanningRuntime')?.handoffStatus?.(sessionId))throw fail('规划会话必须通过草案身份继任交接。','PLANNING_HANDOFF_REQUIRED')
  const persistence=bridge.service('sessionPersistence')
  if(persistence){let handle;try{handle=await persistence.open(sessionId,'read');const {events}=await handle.read();assertNoInteractiveHistoryCopy(events);if(events.some(e=>e.type===NATIVE_PLANNING_RECORD))throw fail('规划身份不可脱离草案。','PLANNING_HANDOFF_REQUIRED')}finally{await handle?.close()}}
}
const getProfile = (runtime, profileId) => {
  const profile = runtime.profiles.list().find(row => row.id === profileId)
  if (!profile || !SUPPORTED_AGENT_TYPES.includes(profile.type) || !runtime.hasRuntime(profile.type)) throw Error('Native handoff Agent unavailable on this Host')
  return profile
}
export async function prepareNativeHandoff(bridge, payload) {
  if (!object(payload) || Object.keys(payload).some(key => !['profile_id', 'selection', 'source_session_id'].includes(key)) || !id(payload.profile_id) || payload.source_session_id !== undefined && !id(payload.source_session_id)) throw Error('Invalid native handoff preparation')
  const runtime = bridge.service('kodeAgents')
  await runtime.profiles.reload?.()
  if (payload.source_session_id) {
    await assertOrdinaryHandoffIdentity(bridge,payload.source_session_id)
    const row = (await bridge.service('sessionController').list({})).items.find(row => row.sessionId === payload.source_session_id)
    if (!row) throw Error('Native handoff source is unavailable')
    assertOrdinaryHandoffSource(runtime.profiles, payload.source_session_id, bridge.service('agents')?.get(payload.source_session_id), row)
  }
  const profile = getProfile(runtime, payload.profile_id), revision = profileRevision(profile)
  const requested = normalizeHandoffSelection(payload.selection)
  const preference = requested ?? runtime.profiles.defaultModelFor?.(profile.id)
  const models = (await runtime.adapter.listModels(profileRoute(profile.id), profile, preference?.model ?? profile.defaultModel))
    .filter(model => !profile.allowedModels || profile.allowedModels.includes(model.id))
  const selection = resolveDefaultSelection(models, preference, profile.defaultModel)
  if (profile.allowedModels && !profile.allowedModels.includes(selection.model)) throw Error('Native handoff model is outside its configured scope')
  if (profileRevision(getProfile(runtime, profile.id)) !== revision) throw Error('Native handoff Agent changed during preparation')
  return { profile_id: profile.id, profile_revision: revision, selection }
}
export async function validateFrozenNativeHandoff(bridge, payload, profile) {
  if (!/^[a-f0-9]{64}$/.test(payload.profile_revision ?? '') || payload.profile_revision !== profileRevision(profile)) throw Error('Native handoff Agent revision changed')
  const requested = normalizeHandoffSelection(payload.selection)
  if (!requested?.model) throw Error('Native handoff requires its frozen model selection')
  if (payload.handoff_source_session_id) {
    await assertOrdinaryHandoffIdentity(bridge,payload.handoff_source_session_id)
    const row = (await bridge.service('sessionController').list({})).items.find(row => row.sessionId === payload.handoff_source_session_id)
    if (!row) throw Error('Native handoff source is unavailable')
    assertOrdinaryHandoffSource(bridge.service('kodeAgents').profiles, payload.handoff_source_session_id, bridge.service('agents')?.get(payload.handoff_source_session_id), row)
  }
  const runtime = bridge.service('kodeAgents')
  const models = (await runtime.adapter.listModels(profileRoute(profile.id), profile, requested.model)).filter(model => !profile.allowedModels || profile.allowedModels.includes(model.id))
  const selection = resolveDefaultSelection(models, requested)
  if (!isDeepStrictEqual(selection, requested)) throw Error('Native handoff model capabilities changed; frozen selection cannot be replaced')
  if (profileRevision(getProfile(runtime, profile.id)) !== payload.profile_revision) throw Error('Native handoff Agent changed during validation')
  return { models, selection }
}
