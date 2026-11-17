import test from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {registerNativeScopedDelivery} from '../src/native-scoped-delivery-route.js'
async function call({principal='owner',body={session_id:'context-a',entry_id:'entry',request_id:'request'},result,error}={}){
 let handler,calls=0,status,payload
 registerNativeScopedDelivery({webServer:{register(route){assert.equal(route.path,'/api/kode/context-v2/deliver');handler=route.handler}},connection:{admit:()=>principal===null?{rejection:401}:{peer:{principal:{kind:principal}}}}},{async deliver(input){calls++;if(error)throw error;return result??{state:'published',message_id:'same-scope'}}})
 const req=Readable.from([JSON.stringify(body)]);req.method='POST';req.headers={'content-type':'application/json'}
 await handler(req,{writeHead(code){status=code},end(value){payload=JSON.parse(value)}})
 return {status,payload,calls}
}
test('only existing Host owner can invoke exact stored-source delivery',async()=>{
 for(const principal of [null,'session','viewer']){const r=await call({principal});assert.equal(r.status,principal===null?401:403);assert.equal(r.calls,0)}
 assert.equal((await call()).status,200)
})
test('model/path/grant/tool/credential and content fields cannot be supplied',async()=>{for(const field of ['model','path','grant','tools','token','content']){const r=await call({body:{session_id:'context-a',entry_id:'entry',request_id:'request',[field]:'forged'}});assert.equal(r.status,400);assert.equal(r.calls,0)}})
test('unsupported capability stays not_ready, unknown outcome requires reconciliation without replay',async()=>{
 const blocked=await call({error:Object.assign(Error('private detail'),{code:'native_scope_capability_unsupported'})});assert.equal(blocked.payload.state,'not_ready');assert.equal(blocked.payload.automatic_replay_allowed,false);assert.doesNotMatch(JSON.stringify(blocked),/private detail/)
 const unknown=await call({error:Error('lost receipt')});assert.equal(unknown.payload.state,'requires_reconciliation');assert.equal(unknown.payload.execution_confirmed,false)
})
