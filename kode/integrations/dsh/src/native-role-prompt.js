/** Host-only frozen role configuration, never a native permission grant. */
import { isDeepStrictEqual } from 'node:util'
import { validateRolePromptSnapshot, rolePromptInstructions } from './team-role-prompts.js'
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { BUILDER_PLANNING_PROMPT_V2, BUILDER_PLANNING_PROMPT_V2_VERSION } from './builder-planning-prompt-v2.js'
import { BUILDER_PLANNING_PROMPT, BUILDER_PLANNING_PROMPT_VERSION } from './builder-planning-prompt.js'
import { builderPromptInstructions } from './builder-settings.js'
export const NATIVE_ROLE_PROMPT_RECORD = 'plugin:kode/native-role-prompt'
export function createNativeRolePromptResolver({session,resolve,flush,validateIdentity}) {
  return async ({mode}) => {
    const value = await resolve({mode})
    const snapshot = value == null ? null : validateRolePromptSnapshot(value)
    await validateIdentity(snapshot)
    const records = Session.prototype.snapshotEvents.call(session).filter(e=>e.type===NATIVE_ROLE_PROMPT_RECORD)
    const legacyNull = records.length === 0 && mode !== 'fresh' && snapshot === null
    if (records.length > 1 || records.length === 0 && mode !== 'fresh' && !legacyNull) throw new Error('Missing or duplicate persisted role prompt snapshot')
    if (records.length) {
      if (!isDeepStrictEqual(records[0].data,{version:1,session_id:session.id,snapshot})) throw new Error('Persisted role prompt changed; new context epoch required')
    } else if (!legacyNull) appendPluginRecord(session,NATIVE_ROLE_PROMPT_RECORD,{version:1,session_id:session.id,snapshot})
    if (!legacyNull && await flush() !== true) throw new Error('Role prompt snapshot not durable')
    const latestValue=await resolve({mode:'check'})
    const latest=latestValue==null?null:validateRolePromptSnapshot(latestValue)
    await validateIdentity(latest)
    if(!isDeepStrictEqual(latest,snapshot))throw new Error('Role prompt changed during persistence')
    return snapshot
  }
}
export async function openNativeRolePrompt(handlers, mode) {
  if (!handlers.resolveRolePrompt) return null
  const value = await handlers.resolveRolePrompt({ mode })
  return value == null ? null : validateRolePromptSnapshot(value)
}
export async function checkNativeRolePrompt(handlers, accepted) {
  if (!isDeepStrictEqual(await openNativeRolePrompt(handlers, 'check'), accepted)) throw new Error('Role prompt changed; a new authorized context epoch is required')
}
export function planningPromptInstructions(version) {
  if (version === undefined || version === BUILDER_PLANNING_PROMPT_VERSION) return BUILDER_PLANNING_PROMPT
  if (version === BUILDER_PLANNING_PROMPT_V2_VERSION) return BUILDER_PLANNING_PROMPT_V2
  throw new Error('Unknown frozen planning prompt version')
}
export const nativeRoleInstructions = (value, handlers = {}) => [handlers.nativePlanning ? planningPromptInstructions(handlers.planningPromptVersion) : '', handlers.nativePlanning && handlers.builderPrompt ? builderPromptInstructions(handlers.builderPrompt) : '', value === null ? '' : rolePromptInstructions(value)].filter(Boolean).join('\n\n')
