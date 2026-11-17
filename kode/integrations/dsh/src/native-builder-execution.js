/** Trusted NativeBuilder admission boundary, not another provider or catalog.
 * Native Codex currently has no verified protocol for excluding ambient read,
 * command/web tools and instructions. Do not turn read-only into a grant claim.
 */
import {isDeepStrictEqual} from 'node:util'
import {validateBuilderAuthority} from './builder-context-scope.js'
const fail=message=>Object.assign(Error(message),{code:'NATIVE_BUILDER_REJECTED'})
export const unsupportedNativeBuilder=()=>Object.assign(Error('Native Builder requires verified CLI ambient-context and built-in-tool isolation; protocol enforcement is not available'),{code:'NATIVE_BUILDER_ENFORCEMENT_UNSUPPORTED'})
export async function admitNativeBuilderTurn(service,{agent,admission,selection,messages,tools,signal,options={},binding}){
  if(!service||!admission)throw fail('Trusted native factory admission required')
  const authority=validateBuilderAuthority(admission.authority)
  if(authority.session_id!==agent.id||agent.session?.id!==agent.id
    ||!isDeepStrictEqual(admission.selection,selection)||agent.session.header.cwd!==admission.cwd
    ||binding?.threadId||binding?.historySource||binding?.historyBootstrapped||binding?.inFlight
    ||options.nativeContinuation||options.fast!==undefined||options.fastTier!==undefined
    ||!Array.isArray(messages)||messages.length!==1||messages[0].role!=='user'
    ||!messages[0].id||!Array.isArray(messages[0].content)||messages[0].content.some(p=>p.type!=='text')
    ||!Array.isArray(tools)||typeof service.assertSession!=='function'||typeof service.admitTurn!=='function')throw fail('Native Builder input, selection or lineage mismatch')
  signal?.throwIfAborted()
  await service.assertSession(agent,{authority})
  const handle=await service.admitTurn({agent,selection:structuredClone(selection),messages:structuredClone(messages),tools:structuredClone(tools),signal})
  if(!handle||typeof handle.assertActive!=='function'||typeof handle.executeTool!=='function'||typeof handle.close!=='function')throw fail('Trusted NativeBuilder turn owner required')
  try{
    await handle.assertActive()
    // Deliberately stop before CLI initialization/credential access, lease or
    // thread creation. A callback/boolean cannot prove CLI-level enforcement.
    throw unsupportedNativeBuilder()
  }finally{await handle.close()}
}

/** Pure candidate bootstrap contract for protocol review/tests. Not dispatchable
 * until Codex has verified enforcement, even if these settings are acknowledged. */
export function nativeBuilderThreadParams({cwd,selection,procedure,tools}){
  if(typeof cwd!=='string'||!cwd.startsWith('/')||typeof selection?.model!=='string'||!selection.model||selection.model==='default'
    ||typeof procedure!=='string'||!procedure||!Array.isArray(tools))throw fail('Explicit native Builder bootstrap required')
  return {cwd,model:selection.model,
    sandbox:'read-only',approvalPolicy:'never',config:{'features.goals':false,...(selection.reasoningEffort?{model_reasoning_effort:selection.reasoningEffort}:{})},baseInstructions:procedure,developerInstructions:procedure,
    dynamicTools:structuredClone(tools.map(t=>({name:t.name,description:t.description,inputSchema:t.parameters})))}
}
export function assertNativeBuilderSelection(response,selection){
  if(response?.model!==selection.model||(response?.reasoningEffort??null)!==(selection.reasoningEffort??null))throw fail('Native CLI did not prove exact model/effort')
}
