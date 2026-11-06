import test from 'node:test'
import assert from 'node:assert/strict'
import { closeBuilder } from '../src/builder-close.js'
const input={operation_id:'creation',command:{request_id:'close',attempt:1,epoch:1,price_id:'price',settlement:'internal_price'}}
function setup(){
 const op={id:'creation',attempt:1,epoch:1,revision:3,state:'active',worker:{session_id:'builder'}},intent={draft_id:'draft',request:input.command}
 let pending=0,finish=0,dispose=0,settle=0,loseReport=false,loseSettlement=false
 const handles=new Map()
 const binding={managedOperation:{id:'creation',attempt:1,epoch:1},managedBuilder:{draft_id:'draft'}}
 const accounting={reservation:{finalized:true,held:0},provider_cost_status:'unconfirmed'}
 const host={handles,execution:{profiles:{binding:()=>binding,patchBinding:async()=>{}},client:{call:async(path,body)=>{
  if(path.endsWith('/builder-close'))return structuredClone(body?intent:{intent,operation:op,pending_inputs:pending})
  if(path.endsWith('/builder-accounting')){settle++;assert.equal(body.expected_revision,4);if(loseSettlement){loseSettlement=false;throw Error('lost settlement reply')}return accounting}
  return structuredClone(op)
 }}}}
 handles.set('builder',{agent:{whenIdle:async()=>{}},run:{finish:async()=>{finish++;op.state='reported';op.revision=4;if(loseReport){loseReport=false;throw Error('lost report reply')}}},dispose:async()=>{dispose++;handles.delete('builder')}})
 return {host,op,binding,setPending:n=>pending=n,loseReport:()=>loseReport=true,loseSettlement:()=>loseSettlement=true,counts:()=>({finish,dispose,settle})}
}
test('closing preserves pending input and never creates a replacement for a missing runtime',async()=>{
 const f=setup();f.setPending(1)
 assert.equal((await closeBuilder(f.host,input)).reason,'pending_inputs')
 assert.deepEqual(f.counts(),{finish:0,dispose:0,settle:0})
 f.setPending(0);f.host.handles.clear()
 await assert.rejects(closeBuilder(f.host,input),/no execution was resumed/)
 assert.deepEqual(f.counts(),{finish:0,dispose:0,settle:0})
})
test('lost report and settlement replies recover without repeating execution or disposal',async()=>{
 const f=setup();f.loseReport()
 await assert.rejects(closeBuilder(f.host,input),/lost report/)
 assert.deepEqual(f.counts(),{finish:1,dispose:0,settle:0})
 f.loseSettlement();await assert.rejects(closeBuilder(f.host,input),/lost settlement/)
 assert.deepEqual(f.counts(),{finish:1,dispose:1,settle:1})
 const [a,b]=await Promise.all([closeBuilder(f.host,input),closeBuilder(f.host,input)])
 assert.equal(a.state,'closed');assert.deepEqual(b,a);assert.equal(a.execution_resumed,false)
 assert.deepEqual(f.counts(),{finish:1,dispose:1,settle:2})
})
test('reported Hub state never authorizes disposing a foreign local handle',async()=>{
 const f=setup();f.op.state='reported';f.binding.managedOperation.id='foreign'
 await assert.rejects(closeBuilder(f.host,input),/identity mismatch/)
 assert.deepEqual(f.counts(),{finish:0,dispose:0,settle:0})
})
