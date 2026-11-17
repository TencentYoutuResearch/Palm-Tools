/** Pure Codex 0.167.1 protocol helpers. These neither start a CLI nor admit inference.
 * Profile provenance is NOT proof of expanded filesystem rules or ambient isolation.
 */
import {isDeepStrictEqual} from 'node:util'
import {posix} from 'node:path'
import {assertNativeBuilderSelection} from './native-builder-execution.js'
const fail=message=>Object.assign(Error(message),{code:'NATIVE_CODEX_PREFLIGHT_REJECTED'})
const text=value=>typeof value==='string'&&value.length>0&&value.trim()===value
const absolute=value=>text(value)&&posix.isAbsolute(value)&&posix.normalize(value)===value
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
function contract(input){
  if(!plain(input)||!plain(input.selection)||!text(input.selection.model)||input.selection.model==='default'
    ||!(input.selection.reasoningEffort===null||text(input.selection.reasoningEffort))
    ||!text(input.modelProvider)||!absolute(input.cwd)||!text(input.permissionProfileId)
    ||input.permissionProfileId.startsWith(':')||!Array.isArray(input.runtimeWorkspaceRoots)
    ||input.runtimeWorkspaceRoots.some(root=>!absolute(root))
    ||new Set(input.runtimeWorkspaceRoots).size!==input.runtimeWorkspaceRoots.length
    ||!['never','on-request','untrusted'].includes(input.approvalPolicy)
    ||!['user','auto_review','guardian_subagent'].includes(input.approvalsReviewer))throw fail('Explicit frozen native selection and profile provenance required')
  // This candidate accepts only standalone Host-owned profiles. Inherited rules
  // need a separate, verified expansion contract, not just an extends name.
  if(input.profileExtends!==undefined&&input.profileExtends!==null)throw fail('Inherited permission profile rules are unverified')
  return input
}
export function nativeCodexScopeThreadParams(input){
  const c=contract(input)
  if(!text(c.procedure)||!Array.isArray(c.tools))throw fail('Explicit procedure and dynamic tools required')
  const names=new Set()
  const dynamicTools=c.tools.map(tool=>{
    if(!plain(tool)||!text(tool.name)||names.has(tool.name)||typeof tool.description!=='string'
      ||!plain(tool.parameters)||tool.parameters.type!=='object'
      ||tool.type!==undefined&&tool.type!=='function')throw fail('Typed function dynamic tool schema required')
    names.add(tool.name)
    return {type:'function',name:tool.name,description:tool.description,inputSchema:structuredClone(tool.parameters)}
  })
  return freeze({cwd:c.cwd,model:c.selection.model,modelProvider:c.modelProvider,
    allowProviderModelFallback:false,permissions:c.permissionProfileId,
    runtimeWorkspaceRoots:[...c.runtimeWorkspaceRoots],approvalPolicy:c.approvalPolicy,approvalsReviewer:c.approvalsReviewer,
    config:{model_reasoning_effort:c.selection.reasoningEffort,'features.goals':false},
    baseInstructions:c.procedure,developerInstructions:c.procedure,dynamicTools})
}
export function verifyNativeCodexScopeThread(response,input){
  const c=contract(input)
  if(!plain(response)||!text(response.thread?.id)||!Object.hasOwn(response,'reasoningEffort'))throw fail('Fresh thread selection metadata missing')
  try{assertNativeBuilderSelection(response,c.selection)}catch{throw fail('Exact native model or effort mismatch')}
  if(response.modelProvider!==c.modelProvider||response.cwd!==c.cwd
    ||response.activePermissionProfile?.id!==c.permissionProfileId
    ||response.activePermissionProfile.extends!==undefined&&response.activePermissionProfile.extends!==null
    ||!isDeepStrictEqual(response.runtimeWorkspaceRoots,c.runtimeWorkspaceRoots)
    ||response.approvalPolicy!==c.approvalPolicy||response.approvalsReviewer!==c.approvalsReviewer)throw fail('Native thread configuration provenance mismatch')
  return freeze({protocol:'codex',thread_id:response.thread.id,model:response.model,modelProvider:response.modelProvider,
    reasoningEffort:response.reasoningEffort,source:'codex_thread_start_metadata',selection_verified:true,
    evidence_scope:'selection_and_configuration_provenance_only',inference_verified:false,
    runtime_ready:false,dispatch_allowed:false,tool_scope_verified:false,permission_rules_verified:false,
    reasons:['permission_profile_effective_rules_unverified','ambient_startup_enforcement_unverified']})
}
