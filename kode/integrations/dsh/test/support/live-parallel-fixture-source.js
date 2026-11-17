/** Narrow, asserted seams into the established real-inbox fixture; no provider invocation here. */
import assert from 'node:assert/strict'
export function liveParallelFixtureSource(original){
 let source=original
 const replace=(from,to)=>{assert.equal(source.split(from).length,2,'Expected exactly one fixture seam: '+from.slice(0,100));source=source.replace(from,to)}
 replace("import { liveTeamPipeline } from './support/live-team-pipeline.js'","import { liveParallelTeamPipeline as liveTeamPipeline, parallelFailure } from './support/live-parallel-team-pipeline.js'")
 replace("timeout:slowScenario?900000:90000","timeout:Infinity")
 replace("if(require('node:fs').readFileSync('implemented.txt','utf8')!=='implemented')process.exit(3);process.stdout.write('verified')","const actual=require('node:fs').readFileSync('implemented.txt','utf8');if(!['REQ-A: avatar','REQ-B: models'].includes(actual))process.exit(3);process.stdout.write('verified '+actual)")
 replace("max_active_assignments:1,max_active_runs:2","max_active_assignments:2,max_active_runs:2")
 replace("if(!ownerSetup){\n   await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})\n   await call('assignment-capacities',{account_id:'account',expected_revision:0,max_active_assignments:1})","if(!ownerSetup){\n   await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})\n   await call('assignment-capacities',{account_id:'account',expected_revision:0,max_active_assignments:2})")
 // Intake still traverses the native Coordinator inbox. Only Worker scheduling starts after both intakes.
 replace("else if(!transferScenario)runService.start()","else if(!transferScenario&&!liveCoordinatorScenario)runService.start()")
 // Startup response-loss expectations must disappear together with their injector.
 replace("   await assert.rejects(startHttp(startCommand),/start was not confirmed/)\n   assert.equal(calls,0);assert.equal(profiles.binding(coordinatorId),undefined)\n   assert.equal((await call('budgets/budget')).budget.reserved,followupScenario?80:40)\n   assert.equal((await call('sessions')).sessions.some(s=>s.address.session_id===coordinatorId),false)","   assert.equal(calls,0) // no input, no model decision before normal confirmed startup")
 // Do not mix deliberate response-loss chaos with this isolation acceptance.
 replace("let lostPublication=false,publicationWrites=0,lostWorkflow=false,workflowWrites=0,lostStart=false,transferWrites=0,lostTransfer=false,lostRecovery=false","let lostPublication=true,publicationWrites=0,lostWorkflow=true,workflowWrites=0,lostStart=true,transferWrites=0,lostTransfer=true,lostRecovery=true")
 replace("}catch(error){fixtureFailure=error;throw error}finally{","}catch(error){fixtureFailure=error;t.diagnostic(JSON.stringify({live_parallel_failure:parallelFailure(error)}));throw error}finally{")
 // All existing stop/drain cleanup remains. Preserve this disposable Hub DB and sessions for inspection.
 replace("await hub.close()}}", "await hub.stop();t.diagnostic(JSON.stringify({live_parallel_retained_hub:{root:hub.root,node:hub.node,scope:'private_disposable_test_only',business_teams_touched:false}}))}}")
 return source
}
