import test from 'node:test'
import assert from 'node:assert/strict'
import{waitForSessionService}from'../packages/transport/readiness.js'
test('session subscription waits for the Host read endpoint without replaying any mutation',async()=>{
 const calls=[],statuses=[404,503,200]
 assert.equal(await waitForSessionService(async(path,options)=>{calls.push({path,options});const status=statuses.shift();return{status,ok:status===200}},new AbortController().signal,{timeoutMs:500,retryMs:1}),true)
 assert.equal(calls.length,3);assert.ok(calls.every(call=>call.options.method==='GET'&&call.path==='/api/kode/project-hosts'))
})
test('auth failures remain visible to the carrier and startup cancellation releases its wait',async()=>{
 let calls=0
 assert.equal(await waitForSessionService(async()=>{calls++;return{status:401,ok:false}},new AbortController().signal),false);assert.equal(calls,1)
 const stop=new AbortController(),waiting=waitForSessionService(async()=>({status:503,ok:false}),stop.signal,{timeoutMs:5000,retryMs:2000})
 stop.abort(new Error('unloaded'));await assert.rejects(waiting,/unloaded/)
})
