import test from 'node:test'
import assert from 'node:assert/strict'
import {ownerWorkerDirectory} from '../src/owner-worker-directory.js'
import {hostDirectory} from '../src/workspace-directory.js'
import {ProjectHosts} from '../src/project-hosts.js'
import {runtimeDirectory} from '../src/runtime-directory.js'
import {discussionProcessTarget,sessionProcessTarget,validateProcessTargetRun,readProcessReturn} from '../packages/collab/process-target.js'
import {createCollabViewState} from '../packages/collab/view-state.js'
import {requestCollabRead} from '../packages/collab/data.js'
const scope={home_hub:'home',host_id:'home',workspace_id:'project',root_ref:'/fixture/project'}
function fixture(){
 const operation={id:'operation',home_node:'home',attempt:1,epoch:1},profile={id:'profile',type:'dsh',name:'Worker'}
 const bindings={worker:{profile,managedAssignment:{id:'assignment'},managedOperation:operation},remote:{profile,managedAssignment:{id:'remote-assignment'},managedOperation:{...operation,home_node:'remote'}},coordinator:{profile,managedCoordinator:{team_id:'team'},managedOperation:operation}}
 const rows=Object.keys(bindings).map(sessionId=>({sessionId,blank:false,cwd:'/unrelated/derived-worktree',projections:{values:{title:sessionId}}}))
 const workspace={id:scope.workspace_id,path:scope.root_ref,sessionIds:[]}
 const assignment={id:'assignment',team_id:'team',run_id:'run',stage_id:'inspect',worker:{node_id:'home',session_id:'worker'},context_hash:'a'.repeat(64),dispatch:{command:{command_id:'assignment',session_id:'worker',operation}}}
 const run={id:'run',team_id:'team',home_hub:'home',context_hash:assignment.context_hash,context:{binding:{workflow:{pack:{stages:[{id:'inspect',execution:{repository_binding:'code'}}]}},project:{config:{spec:{repositories:{code:{workspace:scope}}}}}}}}
 const calls=[],client={async call(path){calls.push(path);if(path.includes('/work-assignments/'))return assignment;if(path.includes('/work-runs/'))return run;if(path.endsWith('/catalog'))return {tabs:[],endpoints:[]};if(path.endsWith('/node'))return {node_id:'home'};return {revision:1,value:path.endsWith('/workspaces')?{global:{archivedSessionIds:[],pinnedSessionIds:[]}}:{native_sessions:[]}}}}
 const services={kodeAgents:{profiles:{binding:id=>bindings[id]}},sessionController:{list:async()=>({items:rows}),resolveAgent(){throw Error('must not activate')}},workspaceRegistry:{list:()=>[workspace],archivedSessionIds:[]}}
 const ctx={get:key=>services[key]},directory={nodeId:'home',workspaces:[workspace],archivedSessionIds:[]}
 return {ctx,client,directory,assignment,run,bindings,calls,workspace}
}
test('owner Worker projection proves immutable assignment and registered origin, never cwd; default/mobile remain hidden',async()=>{
 const f=fixture(),before=JSON.stringify(f.workspace),rows=await ownerWorkerDirectory(f.ctx,f.client,f.directory)
 assert.equal(rows.length,1);assert.equal(rows[0].id,'worker');assert.deepEqual(rows[0].scope,scope)
 assert.equal(f.calls.length,2,'remote and coordinator are skipped without probing');assert.equal(JSON.stringify(f.workspace),before)
 const normal=await hostDirectory(f.ctx,{backendClient:f.client});assert.equal(normal.ownerManagedSessions,undefined);assert.deepEqual(normal.sessions,[])
 assert.deepEqual(await runtimeDirectory(f.ctx,f.client,(await f.ctx.get('sessionController').list()).items),[])
 assert.doesNotMatch(JSON.stringify(rows),/transcript|content|token|credential/)
})
test('changed Home/Host/assignment/operation/root and unavailable metadata fail closed',async()=>{
 for(const change of [f=>f.assignment.team_id='other',f=>delete f.assignment.team_id,f=>f.assignment.team_id=null,f=>f.run.team_id='other',f=>delete f.run.team_id,f=>f.assignment.worker.node_id='other',f=>f.assignment.worker.session_id='other',f=>f.assignment.id='other',f=>f.assignment.dispatch.command.operation={id:'other'},f=>f.run.id='other',f=>f.run.home_hub='other',f=>f.run.context_hash='other',f=>f.run.context.binding.project.config.spec.repositories.code.workspace={...scope,root_ref:'/fixture/project/child'},f=>f.run.context.binding.project.config.spec.repositories.code.workspace={...scope,host_id:'remote'},f=>f.directory.archivedSessionIds=['worker'],f=>f.client.call=async()=>{throw Error('unavailable')}]){
  const f=fixture();change(f);assert.deepEqual(await ownerWorkerDirectory(f.ctx,f.client,f.directory),[])
 }
})
test('discussion target and focused details bind full task/run/scope; transient targets never restore',()=>{
 const task={id:'task',team_id:'team',context_id:'context',work_run_id:'run',scope},team={id:'team',home_hub:'home',spec:{workspace_refs:[scope]}}
 const target=discussionProcessTarget(scope,task,team),run={id:'run',team_id:'team',home_hub:'home',collaboration:{task_id:'task',context_id:'context',scope}}
 assert.equal(validateProcessTargetRun(run,target),run)
 for(const patch of [{id:'other'},{team_id:'other'},{home_hub:'other'},{collaboration:{...run.collaboration,task_id:'other'}},{collaboration:{...run.collaboration,scope:{...scope,root_ref:'/other'}}}])assert.throws(()=>validateProcessTargetRun({...run,...patch},target))
 assert.throws(()=>discussionProcessTarget({...scope,workspace_id:'other'},task,team))
 const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},view=createCollabViewState({storage})
 view.selectWorkspace(scope);view.selectSuperagent('super',{teamId:'team',homeHub:'home'});view.openProcess(target)
 assert.equal(view.getSnapshot().processTarget.runId,'run');assert.equal(createCollabViewState({storage}).getSnapshot().processTarget,null)
 view.selectWorkspace({...scope,workspace_id:'other'});assert.equal(view.getSnapshot().processTarget,null)
})

test('only local owner ProjectHosts UI adds Worker metadata; remote/current and Host directory outputs do not',async()=>{
 const f=fixture(),manager=new ProjectHosts(f.ctx,{backendClient:f.client})
 const owner=await manager.directory('local');assert.equal(owner.hosts[0].ownerManagedSessions.length,1);assert.equal(owner.hosts[0].ownerManagedCandidateLimit,100)
 const remote=await manager.directory('remote');assert.equal(remote.hosts[0].ownerManagedSessions,undefined);assert.equal(remote.hosts[0].ownerManagedCandidateLimit,undefined)
 assert.equal((await hostDirectory(f.ctx,{backendClient:f.client})).ownerManagedSessions,undefined)
 assert.deepEqual(owner.hosts[0].sessions,[]);assert.deepEqual(owner.hosts[0].hiddenSessionIds,['worker','remote','coordinator'])
})

test('existing run return targets require the exact local workspace and never infer a discussion task',()=>{
 const f=fixture(),team={id:'team',home_hub:'home',spec:{workspace_refs:[scope]}},target=sessionProcessTarget(scope,f.run,team)
 assert.equal(target.taskId,undefined);assert.equal(validateProcessTargetRun(f.run,target),f.run)
 const view=createCollabViewState();view.selectWorkspace(scope);view.selectSuperagent('super',{teamId:'team',homeHub:'home'});view.openProcess(target)
 assert.equal(view.getSnapshot().processTarget.runId,'run')
 assert.throws(()=>sessionProcessTarget({...scope,host_id:'remote'},f.run,team))
 assert.throws(()=>sessionProcessTarget(scope,f.run,{...team,id:'other'}))
 assert.throws(()=>validateProcessTargetRun(f.run,{...target,scope:{...scope,root_ref:scope.root_ref+'/child'}}))
 assert.throws(()=>validateProcessTargetRun({...f.run,team_id:'other'},target))
 assert.throws(()=>validateProcessTargetRun(f.run,{...target,taskId:'partial'}))
})

test('discussion return reads the original task audience before Run; 403/404 and changed identity stop there',async()=>{
 const f=fixture(),team={id:'team',home_hub:'home',spec:{workspace_refs:[scope]}},task={id:'task',team_id:'team',context_id:'context',work_run_id:'run',scope}
 const target=discussionProcessTarget(scope,task,team),run={...f.run,collaboration:{task_id:'task',context_id:'context',scope}}
 const calls=[],request=async path=>{calls.push(path);return path.includes('/collaboration?')?task:run}
 assert.deepEqual(await readProcessReturn(target,request),target)
 assert.match(calls[0],/path=tasks%2Ftask/);assert.equal(calls.length,2)
 for(const change of [403,404,{id:'other'},{team_id:'other'},{context_id:'other'},{work_run_id:'other'},{scope:{...scope,root_ref:'/other'}}]){
  const denied=[]
  await assert.rejects(readProcessReturn(target,async path=>{denied.push(path);if(typeof change==='number')throw Error(String(change));return {...task,...change}}))
  assert.equal(denied.length,1);assert.match(denied[0],/collaboration\?/)
 }
 const generic=sessionProcessTarget(scope,{id:'run',team_id:'team',home_hub:'home'},team);calls.length=0
 assert.deepEqual(await readProcessReturn(generic,request),target)
 assert.match(calls[0],/work-run\?/);assert.match(calls[1],/collaboration\?/)
 calls.length=0
 assert.deepEqual(await readProcessReturn(generic,async path=>{calls.push(path);return f.run}),generic)
 assert.equal(calls.length,1,'legacy non-discussion runs retain the existing read path')
})

test('shared abortable GET helper allows only the exact task lookup, not task commands or other collaboration paths',async()=>{
 const calls=[],fetcher=async(path,options)=>{calls.push({path,options});return {ok:true,json:async()=>({id:'task:one'})}}
 await requestCollabRead('/api/kode/collaboration?'+new URLSearchParams({path:'tasks/task:one'}),{fetcher})
 assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.redirect,'error')
 for(const path of ['/api/kode/collaboration?path=tasks%2Ftask%2Fcommands','/api/kode/collaboration?path=surfaces','/api/kode/collaboration?path=tasks%2Ftask&action=cancel'])await assert.rejects(requestCollabRead(path,{fetcher}),/Unsupported/)
 assert.equal(calls.length,1)
})
