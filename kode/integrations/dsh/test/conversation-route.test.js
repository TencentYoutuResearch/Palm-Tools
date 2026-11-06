import test from 'node:test'
import assert from 'node:assert/strict'
import { registerConversation } from '../src/conversation-route.js'
test('conversation bridge accepts only owner text and reads receipts without session or model actions',async()=>{
 let route,kind='agent',status,result,fail=false;const calls=[]
 registerConversation({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind}}})}},
  {backendClient:{call:async(...args)=>{calls.push(args);if(fail)throw Error('private');return {state:'accepted',coordinator_delivery:'pending'}}}})
 const res={writeHead:s=>{status=s},end:b=>{result=JSON.parse(b)}}
 const request=body=>({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}})
 const body={conversation_id:'conversation',request_id:'request',content:'Implement this requirement'}
 await route.handler(request(body),res);assert.equal(status,403);assert.equal(calls.length,0)
 kind='owner'
 for(const injected of [{...body,role:'superagent'},{...body,session_id:'worker'},{...body,team_revision:99}]){
  await route.handler(request(injected),res);assert.equal(status,400);assert.equal(calls.length,0)
 }
 await route.handler(request(body),res);assert.equal(status,200);assert.equal(result.coordinator_delivery,'pending')
 assert.deepEqual(calls[0],['/api/v1/messaging/conversations/conversation/messages',{request_id:'request',content:body.content}])
 fail=true;await route.handler(request(body),res);assert.equal(status,409);assert.equal(result.retry,'same_request');assert.equal(calls.length,2)
 fail=false;await route.handler({method:'GET',url:'/?conversation_id=conversation&request_id=request'},res)
 assert.equal(status,200);assert.deepEqual(calls[2],['/api/v1/messaging/conversations/conversation/requests/request'])
 await route.handler({method:'GET',url:'/?conversation_id=conversation&after=10&limit=2'},res)
 assert.deepEqual(calls[3],['/api/v1/messaging/conversations/conversation/messages?after=10&limit=2'])
 await route.handler({method:'GET',url:'/?conversation_id=conversation&after=10&request_id=request'},res)
 assert.equal(status,400);assert.equal(calls.length,4)
 await route.handler(request({...body,prior_run_id:'prior'}),res)
 assert.equal(status,200);assert.equal(calls[4][1].prior_run_id,'prior')
 for(const prior_run_id of [null,'',{},'bad/id']) {
  await route.handler(request({...body,prior_run_id}),res);assert.equal(status,400)
 }
 assert.equal(calls.length,5)
})
