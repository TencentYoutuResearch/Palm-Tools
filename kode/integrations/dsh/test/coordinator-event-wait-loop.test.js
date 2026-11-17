/** Real shipped dsh scheduler and ToolRuntime; controlled inference, no model cost. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { mountCoordinatorEventWait } from '../src/coordinator-event-wait.js'
const req=createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const {default:Tools}=await import(req.resolve('@deepseek-ai/dsh-tools'))
const {default:SystemPrompt}=await import(req.resolve('@deepseek-ai/dsh-system-prompt'))
const message=id=>({id,role:'user',source:{kind:'human'},content:[{type:'text',text:id}]})
const notice=()=>({id:'kode-message-notice',role:'user',source:{kind:'user',form:'kode-coordinator-run-update',runId:'run',revision:2,sourceMessageId:'request',teamId:'team',conversationId:'conversation'},content:[{type:'text',text:'Hub workflow event'}]})
for(const race of [false,true,'steer'])test(`official scheduler stops polling and retains wake input (race=${race})`,async()=>{
 const ctx=new Context();let handle,wait,calls=0;const events=[],errors=[]
 try{
  await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false});await ctx.plugin(Tools);await ctx.plugin(LlmRuntime);await ctx.plugin(AgentLoop)
  ctx.on('session/event',(_s,e)=>events.push(e));ctx.on('agent/error',e=>errors.push(e.error.message))
  class Fixture extends LlmAdapter{async *stream(){
   calls++;assert.ok(calls<=4,'busy poll must be bounded')
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'block-end',index:0,block:{type:'tool-call',id:`c${calls}`,name:'kode_coordinator_workflow_status',arguments:'{}'}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
  }}
  ctx.llm.registerAdapter(['fixture'],new Fixture())
  ctx.tools.register({name:'kode_coordinator_workflow_status',description:'status',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:(_a,execution)=>{
   const result=wait.observe({id:'run',state:'waiting_resource',worker_clarifications:{count:0,next_cursor:null}},execution)
   // A durable delivery routed while this success is finalizing must not vanish.
   if(race&&calls===2)handle.agent[race==='steer'?'steer':'followup'](notice())
   return result
  }})
  handle=await ctx.agentLoop.createAgent(ctx,{sessionId:`wait-${race}`,agentOptions:{provider:'fixture',model:'fixture'},meta:{cwd:'/tmp'},setup:(scope,agent)=>{wait=mountCoordinatorEventWait(scope,agent)}})
  handle.agent.followup(message('request'));await handle.agent.whenIdle()
  if(!race){assert.equal(calls,2);handle.agent.followup(notice());await handle.agent.whenIdle()}
  assert.equal(calls,4);assert.deepEqual(errors,[])
  assert.equal(events.filter(e=>e.type==='user/message'&&e.data.id==='kode-message-notice').length,1)
  assert.equal(events.filter(e=>e.type==='turn/end').length,race==='steer'?1:2)
  assert.equal(events.filter(e=>e.type==='tool/result').length,4)
 }finally{wait?.dispose();await handle?.dispose();await ctx.fiber.dispose()}
})

for (const scenario of ['mixed-batch','other-tool','different-run','input-reread','state-change']) test(`official loop processes important observation after ${scenario}`,async()=>{
 const ctx=new Context();let handle,wait,calls=0;const errors=[],seen=[]
 const quiet={state:'waiting_resource',worker_clarifications:{count:0,next_cursor:null}}
 try {
  await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false});await ctx.plugin(Tools);await ctx.plugin(LlmRuntime);await ctx.plugin(AgentLoop)
  ctx.on('agent/error',e=>errors.push(e.error.message))
  const status=(id,args={})=>({name:'kode_coordinator_workflow_status',arguments:JSON.stringify({run_id:id,...args})})
  class Fixture extends LlmAdapter {async *stream(options){
   calls++;seen.push(JSON.stringify(options.messages));assert.ok(calls<=4)
   let planned
   if(calls===1)planned=[status('A',scenario==='input-reread'?{omit_inputs:true}:{})]
   else if(calls===2)planned=scenario==='mixed-batch'?[status('A'),status('B')]:scenario==='other-tool'?[status('A'),{name:'other',arguments:'{}'}]:scenario==='different-run'?[status('B')]:[status('A',scenario==='input-reread'?{omit_inputs:false}:{})]
   else if(calls===3&&scenario==='different-run')planned=[status('A')]
   else {
    assert.match(seen.at(-1),/IMPORTANT/,'model must process new result before completing')
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'processed IMPORTANT result'}}
    yield {type:'finish',reason:{kind:'stop'}};return
   }
   for(const [index,p] of planned.entries()) {yield {type:'block-start',index,blockType:'tool-call'};yield {type:'block-end',index,block:{type:'tool-call',id:`c${calls}-${index}`,...p}}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
  }}
  ctx.llm.registerAdapter(['fixture'],new Fixture())
  const output={schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}
  ctx.tools.register({name:'kode_coordinator_workflow_status',description:'status',parameters:{type:'object',properties:{run_id:{type:'string'},omit_inputs:{type:'boolean'}},required:['run_id']},output,execute:(args,execution)=>{
   const result={id:args.run_id,...quiet}
   if(args.run_id==='B')Object.assign(result,{state:'waiting_user',worker_clarification:{question:'IMPORTANT question'}})
   if(scenario==='input-reread'&&args.omit_inputs===false)result.inputs={request:'IMPORTANT full original input'}
   if(scenario==='state-change'&&calls===2)result.waiting_reason='IMPORTANT new resource blocker'
   return wait.observe(result,execution)
  }})
  ctx.tools.register({name:'other',description:'other',parameters:{type:'object',properties:{}},output,execute:()=>({note:'IMPORTANT other result'})})
  handle=await ctx.agentLoop.createAgent(ctx,{sessionId:scenario,agentOptions:{provider:'fixture',model:'fixture'},meta:{cwd:'/tmp'},setup:(scope,agent)=>{wait=mountCoordinatorEventWait(scope,agent)}})
  handle.agent.followup(message('request'));await handle.agent.whenIdle()
  assert.equal(calls,scenario==='different-run'?4:3);assert.deepEqual(errors,[])
 } finally {wait?.dispose();await handle?.dispose();await ctx.fiber.dispose()}
})
