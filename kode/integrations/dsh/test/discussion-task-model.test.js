import test from 'node:test'
import assert from 'node:assert/strict'
import {taskDraftKey,taskActionKey,createTaskJournal,prepareTaskReview,validateCreatedTask,tasksForThread,validateExecution,executionBindings,prepareExecution,validateExecutionReceipt,taskError} from '../packages/collab/discussion-task-model.js'
const scope={home_hub:'home',host_id:'host',workspace_id:'project',root_ref:'/fixture'},surface={id:'dm',scope,revision:3,enabled:true,team_ids:['team']},archive={...surface,id:'channel',kind:'channel',title:'Development'},team={id:'team',home_hub:'home',revision:2,spec:{name:'Team'}},root={id:'root',thread_id:'root',surface_id:'dm',scope,kind:'discussion',actor:{kind:'human',id:'local_owner'}}
const review=()=>prepareTaskReview({scope,surface,archive,team,root,summary:'Approved scope'})
const task={id:'task',scope,revision:1,context_id:'context',thread_id:'task-root',team_id:'team',team_revision:2,summary:'Approved scope',state:'recorded',origin_surface_id:'dm',origin_message_id:'root',archive_surface_id:'channel'}
const preview={task_id:'task',task_revision:1,context_sha256:'a'.repeat(64),context:{task_id:'task',context_id:'context',team_id:'team',summary:task.summary,scope},execution_authorized:false,automatic_coordinator_dispatch:false,work_run:null}
const binding={id:'local',project:{config:{spec:{repositories:{code:{workspace:{host_id:'host',workspace_id:'project',root_ref:'/fixture'}}}}}},workflow:{pack:{inputs:['request'],stages:[{id:'inspect',execution:{network:false,capabilities:['read']}}]}},delivery_policy:{config:{spec:{targets:[{kind:'local'}]}}}}
const activation={active:true,authority_valid:true,home_hub:'home',team_id:'team',team_revision:2,revision:4,snapshot:{bindings:[binding]}}
const storage=()=>{const map=new Map();return{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)}}
test('explicit summary approval freezes exact audience, revision and hash, never source transcript',async()=>{
 const r=await review();assert.equal(r.input.summary,'Approved scope');assert.match(r.input.publication.summary_sha256,/^[a-f0-9]{64}$/);assert.equal(r.input.publication.destination_id,'channel');assert.equal(r.input.origin_revision,3)
 assert.equal('content'in r.input,false)
 for(const changed of [{...root,actor:{kind:'superagent',id:'agent'}},{...root,actor:{kind:'human',id:'other'}},{...root,kind:'task_root'},{...root,thread_id:'different'},{...root,scope:{...scope,root_ref:'/other'}}])await assert.rejects(prepareTaskReview({scope,surface,archive,team,root:changed,summary:'Please execute'}))
 await assert.rejects(prepareTaskReview({scope,surface,archive:{...archive,scope:{...scope,workspace_id:'other'}},team,root,summary:'scope'}))
 const changed=await prepareTaskReview({scope,surface,archive,team,root,summary:'Different scope'});assert.notEqual(r.hash,changed.hash)
 assert.equal(validateCreatedTask({...task,...r.input},r).id,'task');assert.throws(()=>validateCreatedTask({...task,...r.input,summary:'different'},r))
})
test('scope and thread journals isolate edits, pending exact retries, reload and cancellations',async()=>{
 const store=storage(),a=createTaskJournal(store,taskDraftKey(scope,'dm','a')),b=createTaskJournal(store,taskDraftKey(scope,'dm','b'))
 a.edit({summary:'A'});b.edit({summary:'B'});assert.equal(a.read().summary,'A');assert.equal(b.read().summary,'B')
 assert.notEqual(taskDraftKey(scope,'dm','a'),taskDraftKey({...scope,root_ref:'/other'},'dm','a'))
 assert.notEqual(taskActionKey(scope,'a','cancel'),taskActionKey(scope,'b','cancel'))
 const r=await review();assert.deepEqual(a.prepare(r),r);assert.deepEqual(a.prepare(await review()),r);assert.throws(()=>a.edit({summary:'overwrite'}))
 const reload=createTaskJournal(store,taskDraftKey(scope,'dm','a'));assert.deepEqual(reload.read().pending,r)
 assert.throws(()=>reload.accept({...r,input:{...r.input,request_id:'different'}},task));reload.accept(r,task);assert.equal(reload.read().receipt.id,'task');assert.equal(reload.read().pending,null)
 assert.equal(b.read().summary,'B');assert.throws(()=>reload.prepare(r))
})
test('thread directory and execution preview reject mixed task, run, scope and version',()=>{
 assert.deepEqual(tasksForThread({surface_id:'dm',items:[task,{...task,id:'other',origin_message_id:'different'}]},scope,'dm','root').map(t=>t.id),['task'])
 assert.equal(validateExecution(preview,task,scope),preview)
 for(const changed of [{...preview,task_id:'other'},{...preview,task_revision:2},{...preview,work_run:{id:'unbound'}},{...preview,context:{...preview.context,scope:{...scope,home_hub:'other'}}},{...preview,execution_authorized:true}])assert.throws(()=>validateExecution(changed,task,scope))
 assert.throws(()=>tasksForThread({surface_id:'other',items:[task]},scope,'dm','root'))
})
test('only current explicitly selected local bindings can prepare execution',()=>{
 assert.deepEqual(executionBindings(activation,task),[binding]);const input=prepareExecution(task,preview,activation,'local');assert.equal(input.activation_revision,4);assert.equal(input.context_sha256,preview.context_sha256)
 assert.throws(()=>prepareExecution({...task,work_run_id:'existing'},preview,activation,'local'));assert.throws(()=>prepareExecution(task,preview,{...activation,authority_valid:false},'local'));assert.throws(()=>prepareExecution(task,preview,{...activation,team_revision:3},'local'));assert.throws(()=>prepareExecution(task,preview,activation,'different'))
 for(const bad of [{...binding,delivery_policy:{config:{spec:{targets:[{kind:'external'}]}}}},{...binding,workflow:{pack:{inputs:['request'],stages:[{execution:{network:true,capabilities:['read']}}]}}}])assert.deepEqual(executionBindings({...activation,snapshot:{bindings:[bad]}},task),[])
 const receipt={task_id:task.id,work_run_id:'run',context_sha256:input.context_sha256,completion_authorized:false};assert.equal(validateExecutionReceipt(receipt,task,input),receipt);assert.throws(()=>validateExecutionReceipt({...receipt,task_id:'other'},task,input));assert.throws(()=>validateExecutionReceipt({...receipt,completion_authorized:true},task,input))
 assert.match(taskError({status:403}),/权限已失效/);assert.match(taskError({status:409}),/版本、受众或团队授权/)
})
