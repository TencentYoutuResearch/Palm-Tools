import test from 'node:test'
import assert from 'node:assert/strict'
import {nativeCodexScopeThreadParams as build,verifyNativeCodexScopeThread as verify} from '../src/native-codex-scope-preflight.js'
const input=()=>({selection:{provider:'kode-agent-existing',model:'native-model',reasoningEffort:'high'},modelProvider:'original-provider',cwd:'/allowed',permissionProfileId:'owner-bound-profile',runtimeWorkspaceRoots:['/allowed'],approvalPolicy:'never',approvalsReviewer:'user',procedure:'Only the authorized input',tools:[{name:'lookup',description:'Granted lookup',parameters:{type:'object',properties:{}}}]})
const reply=c=>({thread:{id:'fresh-thread'},model:c.selection.model,reasoningEffort:c.selection.reasoningEffort,modelProvider:c.modelProvider,cwd:c.cwd,activePermissionProfile:{id:c.permissionProfileId,extends:null},runtimeWorkspaceRoots:[...c.runtimeWorkspaceRoots],approvalPolicy:c.approvalPolicy,approvalsReviewer:c.approvalsReviewer})
test('pure candidate uses original native provider, disables fallback and types dynamic functions',()=>{
 const c=input(),p=build(c)
 assert.equal(p.modelProvider,c.modelProvider);assert.equal(p.allowProviderModelFallback,false)
 assert.equal(p.permissions,c.permissionProfileId);assert.equal(p.dynamicTools[0].type,'function')
 assert.equal(p.config.model_reasoning_effort,'high');assert.equal(p.config['features.goals'],false)
 assert.equal(Object.hasOwn(p,'sandbox'),false);assert.equal(Object.hasOwn(p,'sandboxPolicy'),false)
 assert.equal(Object.hasOwn(p,'collaborationMode'),false)
 c.tools[0].parameters.properties.changed={};c.runtimeWorkspaceRoots.push('/other')
 assert.deepEqual(p.dynamicTools[0].inputSchema.properties,{});assert.deepEqual(p.runtimeWorkspaceRoots,['/allowed'])
 assert.ok(Object.isFrozen(p.dynamicTools[0].inputSchema))
})
test('exact metadata proves selection only, never expanded permissions or dispatch',()=>{
 const c=input(),e=verify(reply(c),c)
 assert.equal(e.selection_verified,true)
 for(const key of ['inference_verified','runtime_ready','dispatch_allowed','tool_scope_verified','permission_rules_verified'])assert.equal(e[key],false)
 assert.deepEqual(e.reasons,['permission_profile_effective_rules_unverified','ambient_startup_enforcement_unverified'])
 assert.ok(Object.isFrozen(e.reasons))
})
test('each model, provider, effort, cwd, profile, roots and approval mismatch rejects',()=>{
 for(const change of [r=>r.model='fallback',r=>r.modelProvider='other',r=>r.reasoningEffort='low',r=>delete r.reasoningEffort,
  r=>r.cwd='/other',r=>r.activePermissionProfile.id='other',r=>r.activePermissionProfile.extends='global',r=>delete r.activePermissionProfile,
  r=>r.runtimeWorkspaceRoots.push('/other'),r=>delete r.runtimeWorkspaceRoots,r=>r.approvalPolicy='on-request',r=>r.approvalsReviewer='auto_review',r=>r.thread.id='']){
  const c=input(),r=reply(c);change(r);assert.throws(()=>verify(r,c),{code:'NATIVE_CODEX_PREFLIGHT_REJECTED'})
 }
})
test('ACK and plugin disabled list cannot substitute for provenance',()=>{
 assert.throws(()=>verify({},input()))
 assert.throws(()=>verify({disabledPluginIds:['all']},input()))
 const c=input(),r=reply(c);r.disabledPluginIds=['all'];assert.equal(verify(r,c).tool_scope_verified,false)
})
test('explicit null effort is distinct from missing metadata or desired effort',()=>{
 const c=input();c.selection.reasoningEffort=null
 assert.equal(build(c).config.model_reasoning_effort,null);assert.equal(verify(reply(c),c).reasoningEffort,null)
 const r=reply(c);delete r.reasoningEffort;assert.throws(()=>verify(r,c))
 delete c.selection.reasoningEffort;assert.throws(()=>build(c))
})
test('ambiguous roots, implicit built-in profiles and profile inheritance reject',()=>{
 for(const change of [c=>c.cwd='relative',c=>c.cwd='/allowed/../other',c=>c.runtimeWorkspaceRoots=['/allowed','/allowed'],
 c=>c.runtimeWorkspaceRoots=['relative'],c=>c.permissionProfileId=':workspace',c=>c.profileExtends='global',c=>c.selection.model='default',
 c=>c.modelProvider='',c=>c.approvalPolicy='unknown',c=>c.approvalsReviewer='unknown']){
  const c=input();change(c);assert.throws(()=>build(c),{code:'NATIVE_CODEX_PREFLIGHT_REJECTED'})
 }
})
test('duplicate, namespace or non-object tool schemas reject',()=>{
 for(const change of [c=>c.tools.push(c.tools[0]),c=>c.tools[0].type='namespace',c=>c.tools[0].parameters={type:'string'},c=>c.tools[0].name='']){
 const c=input();change(c);assert.throws(()=>build(c),{code:'NATIVE_CODEX_PREFLIGHT_REJECTED'})}
})
test('unknown caller flags cannot overwrite Host candidate controls',()=>{
 const c=input();Object.assign(c,{supported:true,runtime_ready:true,sandbox:'danger-full-access',allowProviderModelFallback:true,config:{'features.goals':true},collaborationMode:{settings:{model:'other'}}})
 assert.equal(build(c).allowProviderModelFallback,false);assert.equal(build(c).sandbox,undefined)
 assert.equal(verify(reply(c),c).runtime_ready,false)
})
