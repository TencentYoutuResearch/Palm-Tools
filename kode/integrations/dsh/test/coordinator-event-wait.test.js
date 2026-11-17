import test from 'node:test'
import assert from 'node:assert/strict'
import { mountCoordinatorEventWait } from '../src/coordinator-event-wait.js'
function fixture() {
 let listener, concluded=0,disposed=false
 const agent={session:{}},ctx={on(name,fn){assert.equal(name,'session/event');listener=fn;return()=>{disposed=true}}}
 const wait=mountCoordinatorEventWait(ctx,agent)
 listener(agent.session,{type:'assistant/message',data:{message:{content:[{type:'tool-call',id:'call',name:'kode_coordinator_workflow_status'}]}}})
 return {wait, execution:{callId:'call',concludeTurn(){concluded++}}, count:()=>concluded, disposed:()=>disposed,
  event:(type,foreign=false)=>{listener(foreign?{}:agent.session,{type,data:{source:{kind:'human'}}});listener(agent.session,{type:'assistant/message',data:{message:{content:[{type:'tool-call',id:'call',name:'kode_coordinator_workflow_status'}]}}})}}
}
const status=(extra={})=>({id:'r1',state:'waiting_resource',revision:1,worker_clarifications:{count:0,next_cursor:null},...extra})
test('same-turn polling concludes official result without discarding current status, even revision changes',()=>{
 const f=fixture(),r=status()
 assert.equal(f.wait.observe(r,f.execution).observation_control.action,'publish_useful_progress_then_end_turn')
 assert.equal(f.count(),0)
 const latest=status({revision:2})
 const result=f.wait.observe(latest,f.execution)
 assert.equal(result.revision,2);assert.equal(f.count(),1)
 assert.equal(result.observation_control.grants_execution,false)
 assert.deepEqual(r,status())
})
test('consumed WorkRun or human input resets observation; unrelated/context events do not',()=>{
 const f=fixture()
 f.wait.observe(status(),f.execution)
 f.event('user/message',true);f.event('context/message')
 f.wait.observe(status(),f.execution);assert.equal(f.count(),1)
 f.event('user/message');f.wait.observe(status(),f.execution);assert.equal(f.count(),1)
 f.event('turn/start');f.wait.observe(status(),f.execution);assert.equal(f.count(),1)
 f.wait.dispose();assert.equal(f.disposed(),true)
})
test('never concludes actionable questions, pagination, acceptance, accounting, cancellation or terminal observation',()=>{
 for(const extra of [{worker_clarification:{request_id:'q'}},{worker_clarifications:{count:2,next_cursor:'1:1'}},{human_acceptance:{state:'pending'}},{execution_accounting:{blocked:true}},{cancellation:{state:'pending'}},{intervention:{reason:'pause'}},...['completed','failed','cancelled','waiting_user','paused'].map(state=>({state}))]) {
  const f=fixture();f.wait.observe(status(),f.execution)
  f.wait.observe(status(extra),f.execution);assert.equal(f.count(),0,JSON.stringify(extra))
 }
})
test('switching runs breaks consecutive observation streak',()=>{
 const f=fixture();f.wait.observe(status(),f.execution);f.wait.observe(status({id:'r2'}),f.execution);assert.equal(f.count(),0)
 f.wait.observe(status(),f.execution);assert.equal(f.count(),0)
})

test('runtime context logged as user/message never resets the observation bound',()=>{
 let listener;const agent={session:{}};let ended=0
 const wait=mountCoordinatorEventWait({on:(_n,fn)=>{listener=fn;return()=>{}}},agent)
 const execution={callId:'call',concludeTurn:()=>ended++}
 const step=()=>listener(agent.session,{type:'assistant/message',data:{message:{content:[{type:'tool-call',id:'call',name:'kode_coordinator_workflow_status'}]}}})
 step()
 wait.observe(status(),execution)
 listener(agent.session,{type:'user/message',data:{source:{kind:'runtime-context'},id:'runtime-context'}})
 wait.observe(status(),execution);assert.equal(ended,1)
 listener(agent.session,{type:'user/message',data:{source:{kind:'plugin'},id:'kode-message-123'}})
 step();wait.observe(status(),execution);assert.equal(ended,1)
})

test('direct source=user input and failed final tool result reset streak; wrong call id never concludes',()=>{
 let listener;const agent={session:{}};let ended=0
 const wait=mountCoordinatorEventWait({on:(_n,fn)=>{listener=fn;return()=>{}}},agent)
 const emit=e=>listener(agent.session,e)
 const step=()=>emit({type:'assistant/message',data:{message:{content:[{type:'tool-call',id:'call',name:'kode_coordinator_workflow_status'}]}}})
 const execution={callId:'call',concludeTurn:()=>ended++}
 step();wait.observe(status(),execution)
 emit({type:'user/message',data:{source:{kind:'user'},id:'human-steer'}})
 step();wait.observe(status(),execution);assert.equal(ended,0)
 emit({type:'tool/result',data:{message:{isError:true}}})
 step();wait.observe(status(),execution);assert.equal(ended,0)
 step();wait.observe(status(),{...execution,callId:'wrong'});assert.equal(ended,0)
 step();wait.observe(status(),execution);assert.equal(ended,0)
})
