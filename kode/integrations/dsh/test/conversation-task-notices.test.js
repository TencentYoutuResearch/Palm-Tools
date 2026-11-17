import test from 'node:test'
import assert from 'node:assert/strict'
import {validateTaskNotices,resolveTaskNotice,noticeLabel} from '../packages/collab/conversation-task-notices.js'
import {registerConversation} from '../src/conversation-route.js'
const scope={home_hub:'home',host_id:'home',workspace_id:'workspace',root_ref:'/fixture/project'}
const team={home_hub:'home',id:'team',conversation_id:'conversation',spec:{workspace_refs:[scope]}}
const row={task_id:'task-a',team_id:'team',scope,surface_id:'channel-a',channel_title:'Same name',thread_id:'thread-a',run_id:'run-a',run_revision:2,state:'running',question_count:1,completion_authorized:false,title:'Requirement A',title_truncated:false}
const page=(items=[row])=>({home_hub:'home',team_id:'team',conversation_id:'conversation',items,unavailable:false,next_cursor:null})
const task={id:row.task_id,team_id:team.id,scope,archive_surface_id:row.surface_id,thread_id:row.thread_id,work_run_id:row.run_id,archive_audience_revision:1}
const surface={id:row.surface_id,scope,kind:'channel',title:row.channel_title,team_ids:['team'],enabled:true,audience_revision:1}
test('task notice pages bind team, exact workspace, unique task identity and explicit pagination',()=>{
 assert.equal(validateTaskNotices(team,page()).items.length,1)
 assert.equal(validateTaskNotices(team,{...page([]),next_cursor:'task-z'}).next_cursor,'task-z')
 for(const bad of [page([row,row]),{...page(),home_hub:'other'},{...page(),team_id:'other'},{...page(),conversation_id:'other'},
   page([{...row,scope:{...scope,root_ref:'/fixture/other'}}]),page([{...row,scope:{...scope,workspace_id:'other'}}]),page([{...row,scope:{...scope,host_id:'other'}}]),
   {...page(),next_cursor:'bad/cursor'},page(Array.from({length:33},(_,n)=>({...row,task_id:'task-'+n})))])assert.throws(()=>validateTaskNotices(team,bad))
 assert.throws(()=>validateTaskNotices(team,{...page([]),next_cursor:'task-a'},'task-a'))
 assert.match(noticeLabel(row),/1 组问题/);assert.equal(noticeLabel({...row,question_count:0,state:'completed'}),'执行已结束，待核验')
})
test('task link rechecks the existing task guard twice and exact surface tuple with no Run read or writes',async()=>{
 const calls=[]
 const result=await resolveTaskNotice(team,row,{request:async(...args)=>{calls.push(args);return task},discussion:async(...args)=>{calls.push(args);return {items:[surface]}}})
 assert.deepEqual(result,{scope,surface,thread:row.thread_id});assert.equal(calls.length,3)
 assert.equal(calls[0][0],'/api/kode/collaboration?path=tasks%2Ftask-a');assert.equal(calls[2][0],calls[0][0]);assert.equal(calls[1][0],'surfaces')
 assert.equal(calls[1][2],undefined)
})
test('late task links, revoked guard and same-name wrong destinations never navigate',async()=>{
 for(const value of [{...task,id:'wrong'},{...task,team_id:'other'},{...task,thread_id:'wrong'},{...task,work_run_id:'wrong'},{...task,scope:{...scope,workspace_id:'other'}}])
  await assert.rejects(resolveTaskNotice(team,row,{request:async()=>value,discussion:async()=>{throw Error('must not read surface')}}))
 for(const value of [{...surface,id:'channel-b'},{...surface,team_ids:['team','other']},{...surface,scope:{...scope,root_ref:'/fixture/other'}},{...surface,enabled:false},{...surface,audience_revision:2}])
  await assert.rejects(resolveTaskNotice(team,row,{request:async()=>task,discussion:async()=>({items:[value]})}))
 let reads=0;await assert.rejects(resolveTaskNotice(team,row,{request:async()=>{if(++reads===2)throw Error('revoked');return task},discussion:async()=>({items:[surface]})}));assert.equal(reads,2)
 const controller=new AbortController();let release;const pending=resolveTaskNotice(team,row,{signal:controller.signal,request:()=>new Promise(resolve=>{release=resolve}),discussion:()=>{throw Error('late response must not continue')}})
 controller.abort();release(task);assert.equal(await pending,null)
})
test('Host notices route is owner-only GET with bounded exact query and no write forwarding',async()=>{
 let handler,kind='agent',status,body;const calls=[]
 registerConversation({webServer:{register:r=>{handler=r.handler}},connection:{admit:()=>({peer:{principal:{kind}}})}},{backendClient:{call:async(...args)=>{calls.push(args);return page()}}})
 const res={writeHead:value=>{status=value},end:value=>{body=JSON.parse(value)}}
 await handler({method:'GET',url:'/?conversation_id=conversation&view=task-notices'},res);assert.equal(status,403);assert.equal(calls.length,0)
 kind='owner';await handler({method:'GET',url:'/?conversation_id=conversation&view=task-notices'},res);assert.equal(status,200);assert.equal(body.team_id,'team')
 assert.deepEqual(calls[0],['/api/v1/messaging/conversations/conversation/task-notices'])
 await handler({method:'GET',url:'/?conversation_id=conversation&view=task-notices&after=task-z'},res)
 assert.deepEqual(calls[1],['/api/v1/messaging/conversations/conversation/task-notices?after=task-z'])
 for(const tail of ['&after=bad%2Fid','&after=a&after=b','&team_id=other','&request_id=r','&limit=999','&view=task-notices']){
  await handler({method:'GET',url:'/?conversation_id=conversation&view=task-notices'+tail},res);assert.equal(status,400)
 }
 assert.equal(calls.length,2)
})
