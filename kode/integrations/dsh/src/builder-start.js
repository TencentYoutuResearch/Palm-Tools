/** Trusted owner-side Builder start; Hub and official dispatch each retain their durable receipts. */
import { OFFICIAL_BUILDER_TOOLS } from './official-builder-tools.js'
import { isDeepStrictEqual } from 'node:util'
import { initializeBuilderInterview } from './builder-initialize.js'

export async function startBuilder(host, input) {
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
  if (!input || Object.keys(input).some(k=>!['command_id','team_id','provider','start','selection_revision'].includes(k))
      || !id(input.command_id) || typeof input.team_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(input.team_id)
      || typeof input.provider !== 'string' || !input.provider || input.provider.length > 4096 || input.provider.includes('\0')
      || !input.start?.operation || Object.hasOwn(input.start, 'selection_ref')
      || (input.selection_revision !== undefined && (!Number.isSafeInteger(input.selection_revision) || input.selection_revision < 1))) throw new Error('Invalid Builder start command')
  input=structuredClone(input)
  host.stop.signal.throwIfAborted()
  const key=JSON.stringify([input.start.operation.worker?.session_id,input.command_id])
  const pending=host.builderStarts.get(key)
  if(pending){
    if(!isDeepStrictEqual(pending.input,input))throw new Error('Builder pending start identity conflict')
    return pending.task
  }
  const task=performBuilderStart(host,input)
  host.builderStarts.set(key,{input,task})
  try{return await task}finally{if(host.builderStarts.get(key)?.task===task)host.builderStarts.delete(key)}
}
async function performBuilderStart(host,input){
  const runtime=host.execution
  const interview=await initializeBuilderInterview(runtime.client,input.start,host.stop.signal)
  const start={...input.start,draft_revision:interview.revision, ...(input.selection_revision === undefined ? {} : { selection_ref: { revision: input.selection_revision, draft_revision: input.start.draft_revision, provider: input.provider } })}
  const result=await runtime.client.call('/api/v1/messaging/superagents/builder-starts',start,host.stop.signal)
  const op=result.bundle.operation, selection=op.selection_policy
  const command={command_id:input.command_id,session_id:op.worker.session_id,
    operation:{id:op.id,attempt:op.attempt,epoch:op.epoch},profile_revision:selection.profile_revision,
    provider:input.provider,model:selection.model,effort:selection.effort ?? null,
    cwd:input.start.operation.grant_scope.target.root,tools:[...OFFICIAL_BUILDER_TOOLS],
    builder:{draft_id:input.start.draft_id,team_id:input.team_id}}
  // An old creation receipt is authoritative even after the operation advanced.
  // Do not prepare/claim/resume again when replaying it; dispatch verifies its fingerprint.
  if (host.dispatches.get(op.worker.session_id,input.command_id)) return host.dispatches.dispatch(command)
  const prepared=await host.prepareBuilder({command_id:input.command_id,team_id:input.team_id,provider:input.provider,
    operation_id:op.id,operation_revision:op.revision,draft_id:input.start.draft_id,draft_revision:interview.revision,
    profile_id:input.start.operation.resource.profile})
  return host.dispatches.dispatch(prepared)
}
