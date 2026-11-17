import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLiveEvidenceRecorder, liveFailureDetails } from './support/live-evidence.js'

const secret = 'DO_NOT_EXPORT_SECRET'
const operation = { id:'op', attempt:1, epoch:1, home_node:'home', credentials:secret }
const team = { id:'team', home_hub:'home', conversation_id:'dm' }
function fixture(directory, options={}) {
  const archiveHash='a'.repeat(64)
  const run={id:'run',home_hub:'home',team_id:'team',state:'completed',revision:9,completion_authorized:true,
    context_hash:archiveHash,authorization:{snapshot_hash:archiveHash,secret},
    context:{profile:{env:{TOKEN:secret}}},inputs:{prompt:secret},
    stages:[{stage_id:'review',state:'passed',assignment_id:'assignment',attempt:1,evidence:{outputs:{reviewed:12},prompt:secret},completion:{stage_passed:true,resources_released:true,at:1000}}],
    delivery:{run_id:'run',run_revision:9,context_hash:archiveHash,authorization_hash:archiveHash,basis:'frozen_policy_and_archived_evidence',at:1000,
      completion_authorized:true,original_workspace_modified:false,task_workspaces:{code:{root:secret}},outputs:{reviewed:12},artifacts:{artifact:{repository_binding:'code',sequence:11,archive_hash:archiveHash,bytes:11,contents:secret}}}}
  const profile={id:'profile',env:{TOKEN:secret},managedInference:{bootstrap:{secret}}}
  const profiles={bindings:{
    coordinator:{profile,managedCoordinator:{team_id:'team'},managedOperation:operation},
    worker:{profile,managedAssignment:{id:'assignment'},managedOperation:operation,operationClosed:false,
      assignmentOutputs:{outputs:{reviewed:{evidence_id:'evidence',sequence:12,body:secret}}},officialTools:{call:{tool:'kode_publish_output',status:'returned',reason:'tool_returned',home_reconciled:true,arguments:secret}},
      artifactOutbox:{e:{evidence:{id:'evidence',payload:{kind:'artifact',snapshot_hash:archiveHash,content:secret}},archive:{contents:secret},home_sequence:11,home_reconciled:true,home_archive_reconciled:true}}},
    foreign:{profile,managedCoordinator:{team_id:'foreign'},managedOperation:operation},
  }}
  const events=[
    {seq:1,time:100,ignorable:true,type:'plugin:kode/managed-cli-start',data:{call_id:'call',operation,configuration:{model:'hy4-ioa',reasoningEffort:'low',native_thread_id:'thread',modelProvider:'tencent',bootstrap:{endpoint:secret},apiKey:secret},native_process:{env:secret}}},
    {seq:2,time:200,type:'tool/call',data:{name:'kode_read_source',arguments:JSON.stringify({path:secret})}},
    {seq:3,time:300,ignorable:true,type:'plugin:kode/managed-cli-decision',data:{call_id:'call',operation,configuration:{model:'hy4-ioa',reasoningEffort:'low',native_thread_id:'thread'},usage:{input_tokens:30,output_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,secret},stop:{leader_exited:true,process_group_empty:true,signal_failures:[],env:secret},outcome:'completed',texts:[secret],failure_details:{phase:'response_stream',raw_error:secret,cancelled:false}}},
  ]
  let closes=0
  const ctx={sessionPersistence:{async open(session){assert.notEqual(session,'foreign');return {async read(){if(options.failSession)throw Error(secret);return {events}},async close(){closes++}}}}}
  const messages=[{id:'human',home_hub:'home',team_id:'team',conversation_id:'dm',sequence:1,created_at:900,actor:{kind:'human',id:'owner'},content:secret},
    {id:'reply',home_hub:'home',team_id:'team',conversation_id:'dm',sequence:2,created_at:1100,in_reply_to:'human',actor:{kind:'superagent',id:'super'},content:'Finished '+secret}]
  const paths=[]
  const call=async(path,body)=>{
    assert.equal(body,undefined,'evidence collection is read only');paths.push(path)
    if(options.failRead)throw Error(secret)
    if(path==='work-runs/active')return {items:[{id:'run',team_id:'team'}]}
    if(path==='work-runs/run')return options.foreignRun?{...run,team_id:'foreign'}:run
    if(path.startsWith('conversations/dm/messages?'))return {home_hub:'home',team_id:options.foreignMessages?'foreign':'team',conversation_id:'dm',items:messages,has_more:false}
    throw Error('Unexpected route '+path)
  }
  const diagnostics=[]
  const recorder=createLiveEvidenceRecorder({directory,team,profiles,ctx,call,diagnostic:line=>diagnostics.push(JSON.parse(line))})
  return {recorder,run,paths,profiles,diagnostics,closes:()=>closes}
}
async function scope(t) {const path=await mkdtemp(join(tmpdir(),'live-evidence-test-'));t.after(()=>rm(path,{recursive:true,force:true}));return path}
async function saved(result) {return JSON.parse(await readFile(join(result.directory,result.file),'utf8'))}

test('selective live checkpoint retains delivery/IM/usage/stop proof without prompt, profile env or tool payload leakage',async t=>{
 const root=await scope(t),f=fixture(root),result=await f.recorder.capture('before_cleanup',{run:f.run,error:Object.assign(Error(secret),{code:'ERR_ASSERTION'})})
 assert.equal(result.saved,true)
 const data=await saved(result),text=JSON.stringify(data)
 assert.equal(text.includes(secret),false)
 assert.equal(data.run_snapshot_source,'home_read')
 assert.equal(data.original_failure.code,'ERR_ASSERTION')
 assert.equal(data.run.delivery.artifacts[0].archive_hash,'a'.repeat(64))
 assert.equal(data.run.delivery.completion_authorized,true)
 assert.equal(data.conversation.complete,true)
 assert.equal(data.conversation.receipts[1].in_reply_to,'human')
 assert.equal(data.conversation.receipts[1].created_at,1100)
 assert.match(data.conversation.receipts[1].content_sha256,/^[a-f0-9]{64}$/)
 assert.deepEqual(data.sessions.map(s=>s.role),['coordinator','review'])
 assert.equal(data.sessions[1].records[1].usage.input_tokens,30)
 assert.equal(data.sessions[1].records[1].stop.process_group_empty,true)
 assert.equal(data.sessions[1].records[0].time,100)
 assert.match(data.sessions[1].tools[0].arguments_sha256,/^[a-f0-9]{64}$/)
 assert.equal(data.sessions[1].archives[0].home_archive_reconciled,true)
 assert.deepEqual(data.sessions[1].named_outputs,[{name:'reviewed',evidence_id:'evidence',sequence:12}])
 assert.equal(data.sessions[1].tool_states[0].status,'returned')
 assert.equal(f.closes(),2)
 assert.equal((await stat(result.directory)).mode&0o777,0o700)
 assert.equal((await stat(join(result.directory,result.file))).mode&0o777,0o600)
})
test('post-stop capture refreshes Home and durable binding status while preserving the earlier checkpoint',async t=>{
 const f=fixture(await scope(t)),first=await f.recorder.capture('home_completed',{run:f.run})
 f.profiles.bindings.worker.operationClosed=true
 f.profiles.bindings.worker.assignmentStop={state:'drained',observed_at:2000,request:{env:secret}}
 const second=await f.recorder.capture('after_host_stop')
 assert.notEqual(first.file,second.file)
 assert.equal((await saved(first)).sessions[1].operation_closed,false)
 assert.equal((await saved(second)).sessions[1].operation_closed,true)
 assert.equal((await saved(second)).sessions[1].assignment_stop.state,'drained')
 assert.equal((await readdir(first.directory)).length,2)
})
test('unavailable reads are bounded evidence gaps, not synthetic zero usage or missing execution proof',async t=>{
 const f=fixture(await scope(t),{failRead:true,failSession:true}),result=await f.recorder.capture('before_cleanup',{run:f.run})
 const data=await saved(result)
 assert.equal(data.run_snapshot_source,'supplied_checkpoint')
 assert.equal(data.conversation.complete,false)
 assert.equal(data.sessions.length,0)
 assert.ok(data.warnings.includes('run_unavailable'))
 assert.ok(data.warnings.includes('session_unavailable'))
 assert.equal(f.closes(),2)
 assert.equal(JSON.stringify(data).includes(secret),false)
})
test('foreign Home projection and conversation data cannot become this team evidence',async t=>{
 const f=fixture(await scope(t),{foreignRun:true,foreignMessages:true}),result=await f.recorder.capture('before_cleanup',{run:f.run})
 const data=await saved(result)
 assert.equal(data.run,null)
 assert.deepEqual(data.conversation.receipts,[])
 assert.equal(data.conversation.complete,false)
 assert.ok(data.warnings.includes('run_scope_mismatch'))
 assert.ok(data.warnings.includes('conversation_scope_mismatch'))
 assert.deepEqual(data.sessions.map(s=>s.role),['coordinator'])
})
test('failed evidence writes never replace the original pipeline exception',async t=>{
 const root=await scope(t),file=join(root,'not-a-directory');await writeFile(file,'existing')
 const f=fixture(file),original=Error('Original pipeline failure')
 let caught
 try{try{throw original}finally{const result=await f.recorder.capture('before_cleanup',{error:original});assert.equal(result.saved,false)}}catch(error){caught=error}
 assert.equal(caught,original)
 assert.equal(await readFile(file,'utf8'),'existing')
 assert.equal(createLiveEvidenceRecorder({directory:undefined}),null)
})

test('numeric DOMException timeout code is retained rather than normalized into an unknown failure', async t => {
 const f=fixture(await scope(t))
 const original=f.run
 const recorder=createLiveEvidenceRecorder({directory:await scope(t),team,profiles:f.profiles,
  call:async path=>path==='work-runs/run'?original:path==='work-runs/active'?{items:[original]}:{home_hub:'home',team_id:'team',conversation_id:'dm',items:[],has_more:false},
  ctx:{sessionPersistence:{async open(){return{async read(){return{events:[{type:'plugin:kode/managed-cli-decision',ignorable:true,seq:1,time:10,data:{failure_code:23,outcome:'failed',configuration:{model:'hy4-ioa'},stop:{leader_exited:true,process_group_empty:true,signal_failures:[]}}}]}},async close(){}}}}}})
 const result=await recorder.capture('before_cleanup',{run:original,error:{name:'TimeoutError',code:23}})
 const data=await saved(result)
 assert.equal(data.original_failure.name,'TimeoutError')
 assert.equal(data.original_failure.code,23)
 assert.equal(data.sessions[0].records[0].failure_code,23)
 assert.equal(data.sessions[0].records[0].outcome,'failed')
})

test('failure diagnostics export transport metadata but never raw request, headers or stderr',()=>{
 const result=liveFailureDetails({phase:'response_stream',transport_code:'ABORT_ERR',upstream_status:200,cancelled:true,
  upstream_complete:false,downstream_complete:false,stream_failure_side:'downstream',
  raw_error:secret,stderr:secret,headers:{Authorization:secret},endpoint:secret,request:{prompt:secret}})
 assert.equal(JSON.stringify(result).includes(secret),false)
 assert.equal(result.transport_code,'ABORT_ERR')
 assert.equal(result.cancelled,true)
 assert.equal(result.upstream_status,200)
})
