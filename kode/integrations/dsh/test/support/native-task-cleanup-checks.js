/** Explicit zero-provider cleanup regression, separate from native acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runNativeTask} from './native-task-clarification-runner.js'
import {cancelNativeTaskFailure,withNativeTaskCleanup} from './native-task-failure-cleanup.js'
test('original failure identity survives failed cleanup and evidence persistence',async()=>{
 const original=Error('original assertion'),diagnostics=[]
 const context={t:{diagnostic:v=>diagnostics.push(JSON.parse(v))},runService:{close:async()=>{}},team:{id:'team'},host:{execution:{},stop:new AbortController()},call:async()=>{throw Error('backend unavailable')}}
 await assert.rejects(withNativeTaskCleanup(context,async()=>{throw original}),error=>error===original)
 assert.equal(diagnostics[0].native_task_failure.original_error.message,'original assertion')
 assert.equal(diagnostics[0].native_task_failure.cleanup.state,'unconfirmed')
})
test('missing actual execution ownership cannot manufacture stopped/accounted receipt',async()=>{
 let cancelled=false,stopWrites=0
 const run=()=>({id:'run',team_id:'team',home_hub:'home',revision:1,state:cancelled?'cancelling':'waiting_resource',stages:[{assignment_id:'assignment'}],...(cancelled?{cancellation:{assignment_ids:['assignment']}}:{})})
 const assignment={id:'assignment',run_id:'run',creation:{state:'created'},worker:{node_id:'home',session_id:'worker'},resources:{state:'held'}}
 const call=async(path,body)=>{if(path.includes('teams/'))return {items:[{id:'run'}]};if(path==='budgets/budget')return {budget:{reserved:39,spent:1}};if(path.endsWith('/work-runs/run')||path==='work-runs/run'){if(body?.action==='request_cancel'){cancelled=true;return run()}if(body?.action==='finalize_cancel')throw Error('cancellation pending: stop');return run()}if(path.endsWith('/work-assignments/assignment')||path==='work-assignments/assignment')return assignment;stopWrites++;throw Error('Unexpected mutation')}
 const host={handles:new Map(),stop:new AbortController(),execution:{host:'home',client:{call},profiles:{binding:()=>({})}}}
 const result=await cancelNativeTaskFailure({host,runService:{close:async()=>{}},call,team:{id:'team'}})
 assert.equal(result.state,'unconfirmed');assert.equal(result.runs[0].steps[0].state,'cancel_unconfirmed');assert.equal(result.budget.reserved,39);assert.equal(stopWrites,0);assert.equal(result.runs[0].assignments[0].stop,null)
})
test('real Hub/Host controlled idle failure drains, settles, releases, preserves cause',{skip:!process.env.KODE_TEST_BACKEND_URL||!process.env.KODE_TEST_HOST_NODE},async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-cleanup-check-')),directory=join(root,'evidence')
 const env={...process.env,KODE_TEST_LIVE_TASK_CLARIFICATION:'1',KODE_TEST_LIVE_FREE_WRAPPER:'1',KODE_TEST_NATIVE_TASK_ZERO_PROVIDER_FAILURE:'idle',KODE_TEST_NATIVE_TASK_SETUP_ONLY:'0',KODE_TEST_HOST_NODE:process.env.KODE_TEST_HOST_NODE,KODE_TEST_MANAGED_CODEX_EXECUTABLE:'/usr/bin/true',KODE_TEST_MANAGED_CODEX_WRAPPER:'/usr/bin/true',KODE_TEST_WRAPPER_PROVIDER:'unused-cleanup',KODE_TEST_WRAPPER_HOME:join(root,'unused-home'),KODE_TEST_NATIVE_MODEL:'cleanup-model',KODE_TEST_LIVE_EVIDENCE_DIR:directory}
 const preflight=await runNativeTask({...env,KODE_TEST_NATIVE_TASK_SETUP_ONLY:'1',KODE_TEST_LIVE_EVIDENCE_DIR:join(root,'setup-only')})
 assert.equal(preflight.summary.dispatches,0);assert.equal(preflight.summary.provider_calls,0);assert.equal(preflight.summary.budget_reserved,0)
 await assert.rejects(runNativeTask(env),error=>error.message==='Injected controlled idle failure: zero provider calls'&&error.cleanup?.state==='confirmed')
 const evidence=JSON.parse(await readFile(join(directory,'failure-cleanup.json'),'utf8')),cleanup=evidence.cleanup
 assert.equal(cleanup.state,'confirmed');assert.equal(cleanup.budget.reserved,0);assert.equal(cleanup.budget.spent,1)
 assert.equal(cleanup.runs.length,1);const run=cleanup.runs[0]
 assert.equal(run.state,'cancelled');assert.equal(run.stop_confirmed,true);assert.equal(run.resources_released,true)
 assert.deepEqual(run.steps.map(s=>s.state),['cancellation_execution_drained','cancellation_accounted','cancelled'])
 assert.equal(run.assignments[0].accounting.reservation.finalized,true);assert.equal(run.assignments[0].accounting.reservation.held,0)
 t.diagnostic(JSON.stringify({controlled_cleanup:true,provider_calls:0,evidence:directory}))
})
