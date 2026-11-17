import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {registerCollaboration} from '../src/collaboration-route.js'
async function invoke({url='/api/kode/collaboration?path=surfaces',method='GET',principal='owner',body,fail,code}={}){let handler,called;registerCollaboration({connection:{admit:()=>principal?{peer:{principal:{kind:principal}}}:{rejection:401}},webServer:{register:r=>{handler=r.handler}}},{backendClient:{call:async(p,b)=>{called={p,b};if(fail)throw {status:fail,code};return {ok:true}}}});const req=Readable.from(body===undefined?[]:[JSON.stringify(body)]);Object.assign(req,{url,method,headers:{'content-type':'application/json'}});let status,result;await handler(req,{writeHead:s=>status=s,end:b=>result=JSON.parse(b)});return {status,result,called}}
test('owner facade denies session and unauthenticated callers',async()=>{assert.equal((await invoke({principal:'session'})).status,403);assert.equal((await invoke({principal:null})).status,401)})
test('owner facade never proxies arbitrary paths or credentials',async()=>{for(const path of ['../../tokens','surfaces/a/../../tasks','tasks/a/commands','surfaces/a/other'])assert.equal((await invoke({url:'/api/kode/collaboration?path='+encodeURIComponent(path)})).status,400);assert.equal((await invoke({url:'/api/kode/collaboration?path=surfaces&token=secret'})).status,400)})
test('scope query and message post map only to fixed collaboration endpoints',async()=>{const a=await invoke({url:'/api/kode/collaboration?path=surfaces&home_hub=home&host_id=host&workspace_id=w&root_ref=%2Ffixture'});assert.equal(a.status,200);assert.match(a.called.p,/collaboration\/surfaces\?home_hub=home/);const b=await invoke({url:'/api/kode/collaboration?path=surfaces/s/messages',method:'POST',body:{content:'test'}});assert.deepEqual(b.called,{p:'/api/v1/messaging/collaboration/surfaces/s/messages',b:{content:'test'}})})
test('backend rejection remains a rejection and never leaks backend token',async()=>{const r=await invoke({fail:403});assert.equal(r.status,403);assert.equal(r.result.retry,'same_request')})
test('task execution and cancellation remain owner-only bounded operations',async()=>{
 for(const [suffix,method]of[['execution','GET'],['execution','POST'],['execution/cancel','POST']]){
  const url='/api/kode/collaboration?path=tasks/task-1/'+suffix,body=method==='POST'?{request_id:'request'}:undefined
  const result=await invoke({url,method,body});assert.equal(result.status,200);assert.equal(result.called.p,'/api/v1/messaging/collaboration/tasks/task-1/'+suffix)
  const session=await invoke({url,method,body,principal:'session'});assert.equal(session.status,403);assert.equal(session.called,undefined)
 }
 for(const path of ['tasks/task-1/execution/anything','tasks/task-1/execution/cancel/extra','tasks/task-1/execution/../../tokens'])assert.equal((await invoke({url:'/api/kode/collaboration?path='+encodeURIComponent(path),method:'POST',body:{}})).status,400)
})

test('unsupported active task amendments are explicit refusals, never retry advice',async()=>{const r=await invoke({url:'/api/kode/collaboration?path=tasks/t/commands',method:'POST',body:{action:'supplement'},fail:409,code:'task_mutation_requires_reauthorization'});assert.equal(r.status,409);assert.equal(r.result.retry,'unsupported');assert.equal(r.result.code,'task_mutation_requires_reauthorization');assert.match(r.result.error,/暂不支持/);})

test('explicit clarification answers preserve exact payload and owner boundary',async()=>{const body={request_id:'answer-1',source_surface_id:'archive',thread_id:'thread',run_id:'run',assignment_id:'assignment',question_request_id:'question',content:'Only this question'},url='/api/kode/collaboration?path=tasks/task-1/clarification-answers';const r=await invoke({url,method:'POST',body});assert.equal(r.status,200);assert.deepEqual(r.called,{p:'/api/v1/messaging/collaboration/tasks/task-1/clarification-answers',b:body});assert.equal((await invoke({url,method:'POST',body,principal:'session'})).status,403);const failed=await invoke({url,method:'POST',body,fail:409});assert.equal(failed.status,409);assert.equal(failed.result.retry,'same_request');assert.equal((await invoke({url,method:'GET'})).status,400)})

test('stored interactive message remains HTTP 200 when native dispatch is unavailable or fails',async()=>{
 for(const runtime of [undefined,"disposed",{open:async()=>{throw Error('private backend failure')},deliver:async()=>{throw Error('must not run')}}]){
  let handler;const selection={team_id:'team',team_revision:1,participant_id:'coordinator',target_id:'target',workspace_id:'workspace',audience_revision:1},input={request_id:'send',content:'Hello',interactive_selection:selection};
  registerCollaboration({connection:{admit:()=>({peer:{principal:{kind:'owner'}}})},webServer:{register:r=>{handler=r.handler}}},{get interactiveRuntime(){if(runtime==="disposed")throw Error("Disposed context");return runtime},backendClient:{call:async(_path,body)=>({id:'source',thread_id:'source',surface_id:'surface',actor:{kind:'human',id:'local_owner'},content:body.content,interactive_selection:body.interactive_selection,newly_stored:true})}})
  const req=Readable.from([JSON.stringify(input)]);Object.assign(req,{url:'/api/kode/collaboration?path=surfaces/surface/messages',method:'POST',headers:{'content-type':'application/json'}});let status,result;
  await handler(req,{writeHead:s=>status=s,end:b=>result=JSON.parse(b)});assert.equal(status,200);assert.equal(result.id,'source');assert.equal(result.interactive_delivery.automatic_replay_allowed,false);assert.equal(result.interactive_delivery.state,runtime&&runtime!=="disposed"?'uncertain':'not_ready');assert.equal(JSON.stringify(result).includes('private backend failure'),false)
 }
})
