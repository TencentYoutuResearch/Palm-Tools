import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectExecutable, readBuilderRuntimeDiscovery } from '../src/builder-runtime-discovery.js'
import { profileRevision } from '../src/agent-profiles.js'
function fixture() {
 const profile={id:'worker',type:'codex',name:'Worker',executable:process.execPath,allowedModels:['hy4'],env:{PRIVATE_TOKEN:'secret-value'},args:['private-arg'],managedInference:{roles:['worker'],endpoint:'https://private.example/responses'}}
 const builder={id:'builder',type:'dsh',name:'Builder'}
 const binding={profile:builder,managedBuilder:{draft_id:'d'},managedOperation:{id:'op'}}
 const draft={home_hub:'host',status:'draft',interview:{proposed_team:{execution_targets:[{host_id:'host',executor_profile_id:'worker',executor_profile_revision:profileRevision(profile)}]}}}
 const runtime={host:'host',profiles:{binding:()=>binding,get:id=>{assert.equal(id,'worker');return profile}}}
 return {profile,binding,draft,runtime,agent:{id:'session'}}
}
test('executable inspection does not run it and handles missing/relative paths',async()=>{
 assert.equal((await inspectExecutable(process.execPath)).status,'present')
 assert.equal((await inspectExecutable('definitely-absent-kode-cli', '/usr/bin')).status,'not_found')
 assert.equal((await inspectExecutable('./codex')).status,'unknown')
 assert.equal((await inspectExecutable('abc\0def')).status,'unknown')
})
test('scoped configuration is evidence, not live model authentication or inference',async()=>{
 const f=fixture();const result=await readBuilderRuntimeDiscovery(f.runtime,f.agent,f.draft,'worker')
 assert.equal(result.cli.status,'present');assert.equal(result.cli.trust_verified,false)
 assert.deepEqual(result.catalog.models,['hy4']);assert.equal(result.catalog.live_directory_checked,false)
 assert.equal(result.catalog.source,'owner_profile_configuration');assert.deepEqual(result.managed_roles,['worker'])
 assert.equal(result.authentication.status,'unknown');assert.equal(result.inference.status,'not_tested');assert.equal(result.eligible_for_execution,false)
 assert.doesNotMatch(JSON.stringify(result),/secret-value|PRIVATE_TOKEN|private-arg|private.example|\/Users\//)
})
test('unselected and remote candidate profiles cannot be inspected',async()=>{
 const f=fixture();await assert.rejects(readBuilderRuntimeDiscovery(f.runtime,f.agent,f.draft,'foreign'),/scope/)
 f.draft.interview.proposed_team.execution_targets[0].host_id='remote'
 await assert.rejects(readBuilderRuntimeDiscovery(f.runtime,f.agent,f.draft,'worker'),/scope/)
})
test('stale pinned profile and closed operation fail closed',async()=>{
 const f=fixture();f.profile.allowedModels=['changed']
 await assert.rejects(readBuilderRuntimeDiscovery(f.runtime,f.agent,f.draft,'worker'),/revision/)
 f.binding.operationClosed=true
 await assert.rejects(readBuilderRuntimeDiscovery(f.runtime,f.agent,f.draft,'builder'),/unavailable/)
})
test('non-Codex ordinary CLI has no managed roles',async()=>{
 const f=fixture();f.profile.type='claude';delete f.profile.managedInference;delete f.draft.interview.proposed_team.execution_targets[0].executor_profile_revision
 const result=await readBuilderRuntimeDiscovery(f.runtime,f.agent,f.draft,'worker');assert.deepEqual(result.managed_roles,[])
})
test('current Builder profile is permitted without candidate inventory',async()=>{
 const f=fixture();delete f.draft.interview.proposed_team
 const result=await readBuilderRuntimeDiscovery(f.runtime,f.agent,f.draft,'builder');assert.equal(result.cli.status,'not_applicable')
})
test('wrapper engine presence is separate from CLI presence',async()=>{
 const f=fixture();f.profile.managedInference.bootstrap={executable:'/no/such/engine',pathVariable:'CODEX_PATH'};delete f.draft.interview.proposed_team.execution_targets[0].executor_profile_revision
 const result=await readBuilderRuntimeDiscovery(f.runtime,f.agent,f.draft,'worker');assert.equal(result.cli.status,'present');assert.equal(result.bootstrap_engine.status,'not_found')
})
