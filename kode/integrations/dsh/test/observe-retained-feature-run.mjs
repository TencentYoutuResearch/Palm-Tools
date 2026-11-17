/** Online, read-only observer for one explicitly named disposable run. Never reads token files or prints source/tool payloads. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, realpath, mkdir, writeFile, rename } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
const exec=promisify(execFile),root=await realpath(process.argv[2]),output=resolve(process.argv[3])
assert.ok(basename(root).startsWith('kode-hub-fixture-'))
const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'))
assert.ok(config.node_id.startsWith('retained-')||config.node_id==='official-coordinator')
const python=`
import sqlite3,json,sys,time
from pathlib import Path
c=sqlite3.connect('file:'+str(Path(sys.argv[1])/'ledger.sqlite')+'?mode=ro',uri=True,timeout=2)
c.execute('pragma query_only=ON');c.execute('BEGIN');at=int(time.time()*1000)
def pick(o,keys):return{k:o.get(k)for k in keys}
def rows(t):
 if not c.execute('select 1 from sqlite_master where type="table"and name=?',(t,)).fetchone():return[]
 return[json.loads(r[0])for r in c.execute('select body from '+t)]
def usage(o):return pick(o,['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens'])if isinstance(o,dict)else None
runs=[{**pick(r,['id','team_id','state','waiting_reason','revision','created_at','updated_at','completion_authorized']),'has_delivery':r.get('delivery')is not None,'owner_cancel_recorded':r.get('cancellation')is not None,'cancel_stop_confirmed':(r.get('cancellation')or{}).get('stop_confirmed'),'cancel_resources_released':(r.get('cancellation')or{}).get('resources_released'),'stages':[pick(s,['stage_id','assignment_id','state','attempt'])for s in r.get('stages',[])]}for r in rows('work_runs')]
calls=[{**pick(r,['state','started_at','accounting_status']),'call_id':r['request'].get('call_id'),'operation_id':r['request'].get('operation_id'),'provider':r['request'].get('provider'),'requested_model':r['request'].get('model'),'last_kind':(r.get('last')or{}).get('kind'),'last_reason':(r.get('last')or{}).get('reason'),'last_usage':usage((r.get('last')or{}).get('usage')),'metered':r.get('metered')}for r in rows('official_calls')]
ops=[{**pick(r,['id','state','attempt','epoch','revision','lease_until']),'lease_valid_at_observation':isinstance(r.get('lease_until'),int)and r['lease_until']>at}for r in rows('operations')]
assignments=[{**pick(r,['id','run_id','stage_id','state','revision']),'resource_state':(r.get('resources')or{}).get('state'),'has_stop_receipt':r.get('stop')is not None,'stop_receipt_state':((r.get('stop')or{}).get('receipt')or{}).get('state'),'has_accounting_receipt':r.get('accounting')is not None,'worker':pick(r.get('worker')or{},['node_id','session_id']),'creation':pick(r.get('creation')or{},['state','at','session_id','completion_authorized']),'admission':pick(r.get('admission')or{},['kind','at','inference_verified']),'dispatch_state':(r.get('dispatch')or{}).get('state'),'mandate_recorded':r.get('mandate')is not None,'mandate_message_id':((r.get('mandate')or{}).get('receipt')or{}).get('message_id')}for r in rows('work_assignments')]
budgets=[pick(r,['id','unit','limit','spent','reserved','ends_at'])for r in rows('budgets')]
receipts=[{**pick(r,['id','conversation_id','sequence','created_at','in_reply_to','state']),'actor_kind':r.get('actor',{}).get('kind')}for r in rows('conversation_messages')]
c.commit();c.close();print(json.dumps({'captured_at':at,'runs':runs,'model_calls':calls,'operations':ops,'assignments':assignments,'budgets':budgets,'message_receipts':receipts}))
`
const ledger=JSON.parse((await exec('/usr/bin/python3',['-c',python,root],{maxBuffer:2*1024*1024})).stdout)
const now=Date.now(),sessions=[],warnings=[],pids=new Set()
const select=(o,keys)=>Object.fromEntries(keys.map(k=>[k,o?.[k]??null]))
const usage=o=>o?select(o,['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens']):null
for(const directory of await readdir(join(root,'sessions'))){for(const id of await readdir(join(root,'sessions',directory))){
 try{
  const events=zstdDecompressSync(await readFile(join(root,'sessions',directory,id,'session.v4.jsonl.zstd'))).toString().trim().split('\n').map(JSON.parse)
  const starts=new Map(),decisions=[],tools=[]
  for(const e of events){
   if(e.type==='plugin:kode/managed-cli-start'){
    const d=e.data;starts.set(d.call_id,{call_id:d.call_id,at:e.time,pid:d.native_process?.pid??null,model:d.configuration?.model??null,model_provider:d.configuration?.modelProvider??null,effort:d.configuration?.reasoningEffort??null})
   }else if(e.type==='plugin:kode/managed-cli-decision'){
    const d=e.data,start=starts.get(d.call_id);decisions.push({...select(d,['call_id','outcome','failure_code','terminal']),started_at:start?.at??null,ended_at:e.time,start_record_to_end_ms:start?e.time-start.at:null,model:d.configuration?.model??null,model_provider:d.configuration?.modelProvider??null,effort:d.configuration?.reasoningEffort??null,usage:usage(d.usage),stop:d.stop?{...select(d.stop,['spawned','leader_exited','process_group_empty']),signal_failure_count:d.stop.signal_failures?.length??null}:null,failure_details:d.failure_details?select(d.failure_details,['phase','transport_code','upstream_status','stream_failure_side','upstream_complete','downstream_complete','cancelled']):null});starts.delete(d.call_id)
   }else if(e.type==='tool/call')tools.push({at:e.time,name:e.data.name,call_id:e.data.id??null})
  }
  const active=[...starts.values()].map(s=>({...s,elapsed_since_start_record_ms:now-s.at}));for(const s of active)if(Number.isSafeInteger(s.pid))pids.add(s.pid)
  const failures=decisions.filter(d=>d.outcome==='failed')
  sessions.push({session_id:id,event_count:events.length,last_event_at:events.at(-1)?.time??null,native_decisions:decisions,active_native_start_records:active,tool_calls:tools,last_tool_at:tools.at(-1)?.at??null,recorded_native_failure_count:failures.length})
 }catch{warnings.push({session_id:id,reason:'session_snapshot_temporarily_unreadable_no_zero_assumption'})}
}}
let processes=[]
if(pids.size){try{const result=await exec('/bin/ps',['-p',[...pids].join(','),'-o','pid=,etime=,stat=,comm=']);processes=result.stdout.trim().split('\n').filter(Boolean).map(line=>{const m=line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);return m?{pid:Number(m[1]),elapsed:m[2],state:m[3],executable_basename:basename(m[4])}:null}).filter(Boolean)}catch(error){warnings.push({reason:'native_pid_inspection_unavailable_or_process_exited_since_snapshot',code:typeof error.code==='number'?error.code:null})}}
const previous=await readFile(output,'utf8').then(JSON.parse,()=>null)
const nativeFinished=sessions.reduce((n,s)=>n+s.native_decisions.length,0),toolCount=sessions.reduce((n,s)=>n+s.tool_calls.length,0),recordedFailures=sessions.reduce((n,s)=>n+s.recorded_native_failure_count,0)
const summary={native_started_unmatched:sessions.reduce((n,s)=>n+s.active_native_start_records.length,0),native_finished:nativeFinished,tool_calls:toolCount,recorded_native_failures:recordedFailures}
const comparison=previous?.scope==='online_read_only_retained_feature_observer'?{previous_captured_at:previous.captured_at,finished_decisions_delta:nativeFinished-previous.summary.native_finished,tool_calls_delta:toolCount-previous.summary.tool_calls}:null
const report={scope:'online_read_only_retained_feature_observer',captured_at:now,root,node:config.node_id,ledger,sessions,native_process_observations:processes,summary,comparison,warnings,
 interpretation:{task_state_alone_proves_timeout_or_deadlock:false,current_observation_has_recorded_native_failure:recordedFailures>0,unfinished_start_record_proves_only_pending_or_unflushed_completion:true,upstream_provider_fault_established:false,observe_again_before_classifying_inactivity:true,sqlite_and_session_snapshots_are_not_atomic_with_each_other:true},privacy:{token_files_read:false,source_content_exported:false,tool_arguments_exported:false,credentials_exported:false},actions:{model_requests:0,signals_sent:0,hub_or_host_started:false,operator_session_modified:false}}
await mkdir(dirname(output),{recursive:true,mode:0o700});const temporary=output+'.tmp';await writeFile(temporary,JSON.stringify(report,null,2)+'\n',{mode:0o600});await rename(temporary,output)
process.stdout.write(JSON.stringify({output,run_states:ledger.runs.map(r=>r.state),summary,comparison,warnings:warnings.length})+'\n')
