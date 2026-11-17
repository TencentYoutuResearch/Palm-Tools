import test from 'node:test'
import assert from 'node:assert/strict'
import {UsageOutbox} from '../src/usage-outbox.js'
import {turnUsage,zeroUsage} from '../src/native-usage.js'
function fixture(){
 const op={id:'operation',attempt:1,epoch:1},rows={s:{managedOperation:op}},receipts=new Map(),calls=[]
 const profiles={bindings:rows,binding:id=>structuredClone(rows[id]),async update(fn){return fn({bindings:rows})}}
 const client={async call(path,body){calls.push({path,body});if(path.includes('/budget?'))return {operation_id:op.id,attempt:1,reservation:{revision:1,finalized:false,request:{id:'hold',operation_id:op.id}},price:{id:'price',model:'fixture',model_policy:'requested_model'}}
 if(body){const result={estimated:true,price_id:'price',reservation:{request:{id:'hold'},revision:body.expected_revision+1}};receipts.set(body.event_id,{usage:structuredClone(body),result});return result}
 const result=receipts.get(path.split('/').at(-1));if(!result)throw Object.assign(Error('missing'),{status:404});return structuredClone(result)}}
 return {op,profiles,rows,calls,receipts,service:new UsageOutbox(client,profiles)}
}
test('same original outbox retains exact meter ID and confirms actual server receipt without rebilling',async()=>{
 const f=fixture();try{const key=await f.service.prepare('s',f.op,'fixture');await assert.rejects(f.service.confirmedReceipt('s',f.op),/not confirmed/)
 const event={...turnUsage(zeroUsage(),{input_tokens:10,cached_input_tokens:0,output_tokens:2,cache_write_input_tokens:0},{threadId:'thread',turnId:'turn',model:'fixture'}),turn_ended:true}
 await f.service.observe('s',key,event);await f.service.tick();const proof=await f.service.confirmedReceipt('s',f.op)
 assert.match(proof.usage_event_id,/^meter-/);assert.notEqual(proof.usage_event_id,event.event_id);assert.equal(f.calls.filter(c=>c.body).length,1)
 await f.service.confirmedReceipt('s',f.op);assert.equal(f.calls.filter(c=>c.body).length,1)
 f.receipts.get(proof.usage_event_id).usage.model='foreign';await assert.rejects(f.service.confirmedReceipt('s',f.op),/server receipt changed/)
 }finally{await f.service.close()}
})
test('missing historical acknowledged command never invents confirmation',async()=>{const f=fixture();try{await f.service.prepare('s',f.op,'fixture');await assert.rejects(f.service.confirmedReceipt('s',{...f.op,epoch:2}));assert.equal(f.calls.filter(c=>c.body).length,0)}finally{await f.service.close()}})

test('cached acknowledged result alone cannot confirm without matching server receipt',async()=>{
 const f=fixture();try{
  const key=await f.service.prepare('s',f.op,'fixture');
  const event={...turnUsage(zeroUsage(),{input_tokens:10,cached_input_tokens:0,output_tokens:2,cache_write_input_tokens:0},{threadId:'thread',turnId:'turn',model:'fixture'}),turn_ended:true};
  await f.service.observe('s',key,event);await f.service.tick();
  const saved=f.rows.s.usageOutbox[key];f.receipts.delete(saved.acknowledged_usage.event_id);
  await assert.rejects(f.service.confirmedReceipt('s',f.op),/missing/);
  assert.equal(f.calls.filter(c=>c.body).length,1);
 }finally{await f.service.close()}
})
