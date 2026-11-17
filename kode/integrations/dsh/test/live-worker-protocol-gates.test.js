/** Current formal Worker protocol boundaries; no model calls and no installed account/config reads. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProfile } from '../src/agent-profiles.js'
import { controlledBinding, managedCodexEnabled, managedClaudeEnabled, managedNativeEnabled } from '../src/managed-codex-profile.js'
import { CodexManagedDecision } from '../src/codex-managed-decision.js'

for(const [type,name,model] of [['codebuddy','CodeBuddy','hy4std'],['claude','tclaude','claude-hy4[1m]']]){
 test(`${name} ordinary native profile remains usable but cannot acquire formal managed Worker authority`,()=>{
  const ordinary=normalizeProfile({id:'fixture-'+type,name,type,executable:'/fixture/bin/'+name,defaultModel:model})
  assert.equal(ordinary.defaultModel,model)
  assert.equal(managedCodexEnabled(ordinary),false)
  assert.equal(managedClaudeEnabled(ordinary),false)
  assert.equal(managedNativeEnabled(ordinary),false)
  assert.equal(controlledBinding({profile:ordinary,managedAssignment:{id:'assignment'}}),false)
  assert.throws(()=>normalizeProfile({...ordinary,managedInference:{endpoint:'https://example.com/responses',roles:['worker']}}),type==='claude' ? /requires a pinned wrapper bootstrap/ : /requires a Codex or Claude protocol profile/)
  assert.throws(()=>new CodexManagedDecision({profile:ordinary,cwd:'/fixture/project',stateRoot:'/fixture/state',endpoint:'https://example.com/responses',model,effort:'low',admit:async()=>{throw Error('No admission permitted')}}),/configuration rejected/)
 })
}
test('a Codex managed profile still needs the explicit Worker role and one unambiguous binding',()=>{
 const profile=normalizeProfile({id:'fixture-codex',name:'Codex',type:'codex',defaultModel:'hy4-ioa',managedInference:{endpoint:'https://example.com/responses',roles:['coordinator'],reasoningEfforts:['low']}})
 assert.equal(controlledBinding({profile,managedAssignment:{id:'assignment'}}),false)
 assert.equal(controlledBinding({profile,managedCoordinator:{team_id:'team'}}),true)
 const worker=normalizeProfile({...profile,managedInference:{...profile.managedInference,roles:['worker']}})
 assert.equal(controlledBinding({profile:worker,managedAssignment:{id:'assignment'}}),true)
 assert.equal(controlledBinding({profile:worker,managedAssignment:{id:'assignment'},managedCoordinator:{team_id:'team'}}),false)
})

test('Claude authority requires an explicitly pinned wrapper and role, never just an inference endpoint',()=>{
 const ordinary=normalizeProfile({id:'fixture-claude',name:'Claude',type:'claude',defaultModel:'fixture-model'})
 const bootstrap={executable:'/fixture/bin/native-claude',pathVariable:'TCLAUDE_CLAUDE_PATH',provider:'fixture',home:'/fixture/home'}
 for(const managedInference of [
  {endpoint:'https://example.com/messages'},
  {bootstrap:{...bootstrap,home:undefined}},
  {bootstrap:{...bootstrap,pathVariable:'OTHER_ENGINE_PATH'}},
 ])assert.throws(()=>normalizeProfile({...ordinary,managedInference}),/pinned wrapper bootstrap/)
 assert.throws(()=>normalizeProfile({...ordinary,args:['--dangerously-skip-permissions'],managedInference:{bootstrap}}),/pinned wrapper bootstrap/)
 const managed=normalizeProfile({...ordinary,managedInference:{bootstrap,roles:['coordinator']}})
 assert.equal(managedClaudeEnabled(managed),true)
 assert.equal(managedCodexEnabled(managed),false)
 assert.equal(controlledBinding({profile:managed,managedAssignment:{id:'assignment'}}),false)
 assert.equal(controlledBinding({profile:managed,managedCoordinator:{team_id:'team'}}),true)
 const worker=normalizeProfile({...managed,managedInference:{bootstrap,roles:['worker']}})
 assert.equal(controlledBinding({profile:worker,managedAssignment:{id:'assignment'}}),true)
 assert.equal(controlledBinding({profile:worker,managedAssignment:{id:'assignment'},managedCoordinator:{team_id:'team'}}),false)
 assert.equal(controlledBinding({profile:ordinary,managedAssignment:{id:'assignment'}}),false)
})
