/** Read only an explicitly supplied retained disposable Hub; never connect a model or read a token file. */
import assert from 'node:assert/strict'
import { liveFailureDetails } from './support/live-evidence.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, realpath, writeFile, stat } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
const exec=promisify(execFile),root=await realpath(process.argv[2]),output=process.argv[3]
assert.ok(basename(root).startsWith('kode-hub-fixture-'),'only an explicit disposable fixture is supported')
const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'))
assert.equal(config.node_id,'official-coordinator')
// Immutable SQLite reads are safe only for a stopped, checkpointed fixture. Refuse an extant WAL.
assert.equal(await stat(join(root,'ledger.sqlite-wal')).then(row=>row.size, error=>{if(error.code==='ENOENT')return 0;throw error}),0,'stop the fixture Hub and checkpoint its WAL before offline audit')
const python=`
import sqlite3,json,sys,time
from pathlib import Path
root=Path(sys.argv[1]); c=sqlite3.connect('file:'+str(root/'ledger.sqlite')+'?mode=ro&immutable=1',uri=True); now=int(time.time()*1000)
def bodies(table):return [json.loads(row[0]) for row in c.execute('select body from '+table)]
def pick(o,keys):return {k:o.get(k)for k in keys}
runs=[{**pick(r,['id','team_id','state','waiting_reason','revision','completion_authorized']), 'has_delivery':r.get('delivery')is not None,'owner_cancel_recorded':r.get('cancellation')is not None,'cancel_stop_confirmed':r.get('cancellation',{}).get('stop_confirmed')if r.get('cancellation')else None,'cancel_resources_released':r.get('cancellation',{}).get('resources_released')if r.get('cancellation')else None,'stages':[pick(s,['stage_id','assignment_id','state','attempt'])for s in r['stages']]}for r in bodies('work_runs')]
ops=[{**pick(r,['id','state','attempt','epoch','revision','lease_until']),'lease_expired_at_audit':isinstance(r.get('lease_until'),int)and r['lease_until']<now}for r in bodies('operations')]
assignments=[{**pick(a,['id','run_id','stage_id','state','revision']),'resources_state':a.get('resources',{}).get('state'),'has_accounting_receipt':a.get('accounting')is not None,'has_stop_receipt':a.get('stop')is not None}for a in bodies('work_assignments')]
calls=[{'call_id':r['request'].get('call_id'),'operation_id':r['request'].get('operation_id'),'provider':r['request'].get('provider'),'requested_model':r['request'].get('model'),'state':r['state'],'accounting_status':r.get('accounting_status'),'metered':r.get('metered'),'last_kind':r.get('last',{}).get('kind'),'last_reason':r.get('last',{}).get('reason')}for r in bodies('official_calls')]
budgets=[pick(b,['id','limit','spent','reserved','starts_at','ends_at','unit'])for b in bodies('budgets')]
reservations=[{**pick(r,['revision','charged','held','charge_basis','finalized']),'id':r['request'].get('id'),'operation_id':r['request'].get('operation_id'),'amount':r['request'].get('amount')}for r in bodies('budget_reservations')]
holds=[dict(zip(['assignment_id','account_id','state'],r))for r in c.execute('select assignment_id,account_id,state from assignment_resource_holds')]
messages=[]
# The fixture's conversation receipts remain in the retained database. Export metadata, never body text.
for t in ['conversation_messages']:
 if c.execute('select 1 from sqlite_master where name=?',(t,)).fetchone():
  cols=[x[1]for x in c.execute('pragma table_info('+t+')')]
  if 'body'in cols:
   for r in bodies(t):messages.append({**pick(r,['id','conversation_id','sequence','created_at','in_reply_to','state']), 'actor_kind':r.get('actor',{}).get('kind')})
print(json.dumps({'captured_at':now,'runs':runs,'operations':ops,'assignments':assignments,'model_calls':calls,'budgets':budgets,'reservations':reservations,'resource_holds':holds,'message_receipts':messages}))
`
const ledger=JSON.parse((await exec('/usr/bin/python3',['-c',python,root])).stdout)
const profiles=JSON.parse(await readFile(join(root,'profiles.json'),'utf8')),sessions=[]
for(const directory of await readdir(join(root,'sessions')))for(const id of await readdir(join(root,'sessions',directory))){
 const binding=profiles.bindings[id]
 if(!binding?.managedAssignment&&!binding?.managedCoordinator)continue
 const events=zstdDecompressSync(await readFile(join(root,'sessions',directory,id,'session.v4.jsonl.zstd'))).toString().trim().split('\n').map(x=>JSON.parse(x))
 const records=events.filter(e=>e.type==='plugin:kode/managed-cli-decision').map(e=>({call_id:e.data.call_id,time:e.time,model:e.data.configuration?.model,effort:e.data.configuration?.reasoningEffort,
  outcome:e.data.outcome,failure_code:e.data.failure_code,usage:e.data.usage??null,stop:e.data.stop?{leader_exited:e.data.stop.leader_exited,process_group_empty:e.data.stop.process_group_empty,signal_failure_count:e.data.stop.signal_failures.length}:null,
  failure_details:liveFailureDetails(e.data.failure_details)}))
 sessions.push({session_id:id,role:binding.managedCoordinator?'controlled_coordinator':'real_implementation_worker',assignment_id:binding.managedAssignment?.id??null,
  operation_closed:binding.operationClosed??null,has_assignment_stop:binding.assignmentStop!=null,tool_names:events.filter(e=>e.type==='tool/call').map(e=>e.data.name),decisions:records})
}
const nativeCalls=ledger.model_calls.filter(c=>c.provider==='kode-workflow-native-worker'),worker=sessions.find(s=>s.role==='real_implementation_worker')
const budget=ledger.budgets[0]
const currentSource=await readFile(join(root,'project','kode/integrations/dsh/src/model-alias.js'))
const snapshot={schema_version:1,scope:'offline_read_only_audit_of_retained_temporary_replay',root,node:config.node_id,termination:ledger.runs.some(r=>r.owner_cancel_recorded)?'native_timeout_then_host_disposal_then_actual_ui_owner_cancel_request_only':'single_decision_timeout_then_fixture_host_disposal_not_owner_cancellation',ledger,sessions,
 assertions:{reported_charges_equal_budget_spent:ledger.reservations.reduce((s,r)=>s+r.charged,0)===budget.spent,
  retained_holds_equal_budget_reserved:ledger.reservations.reduce((s,r)=>s+r.held,0)===budget.reserved,
  internal_budget_not_overreserved:budget.spent+budget.reserved<=budget.limit,
  unknown_real_call_retained:nativeCalls.some(c=>c.accounting_status==='usage_unresolved'&&c.metered===null),
  completed_native_decisions_have_stop_proof:worker.decisions.every(d=>d.stop?.leader_exited&&d.stop.process_group_empty&&d.stop.signal_failure_count===0),
  no_host_write_tool_called:!worker.tool_names.includes('kode_write_source'),
  no_home_delivery:ledger.runs.every(r=>!r.has_delivery&&!r.completion_authorized),
  owner_cancel_does_not_forge_drain_or_release:ledger.runs.every(r=>!r.owner_cancel_recorded||(r.cancel_stop_confirmed!==true&&r.cancel_resources_released!==true)),
  unknown_reservation_not_released:ledger.reservations.some(r=>r.operation_id===nativeCalls.at(-1).operation_id&&!r.finalized&&r.held>0),
 },source:{original_module_sha256:createHash('sha256').update(currentSource).digest('hex'),default_selection_export_present:currentSource.includes(Buffer.from('export function resolveDefaultSelection'))},
 boundary:{business_repositories_modified:false,business_teams_touched:false,additional_model_requests:0,provider_cost_status:'unconfirmed',full_pipeline_passed:false}}
assert.ok(Object.values(snapshot.assertions).every(Boolean),'audit invariant failed; inspect the retained source data')
if(output)await writeFile(resolve(output),JSON.stringify(snapshot,null,2)+'\n',{mode:0o600})
process.stdout.write(JSON.stringify({audit_assertions:snapshot.assertions,native_requests:nativeCalls.length,usage_unresolved:nativeCalls.filter(c=>c.metered===null).length,run_state:ledger.runs[0]?.state,output:output??null})+'\n')
