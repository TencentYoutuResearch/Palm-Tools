import test from 'node:test'
import assert from 'node:assert/strict'
import { projectBuilderConversation,registerBuilderConversation } from '../src/builder-conversation.js'
test('Builder conversation pagination preserves Unicode replies and excludes internal content',()=>{
  const reply='😀'.repeat(9000)+'done'
  const events=[{seq:0,type:'tool/result',data:{content:[{type:'text',text:'internal output'}]}},
    {seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'question'}]}},
    {seq:2,type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'private reasoning'},{type:'tool-call',name:'private tool'},{type:'text',text:reply}]}}}]
  let cursor={seq:0,offset:0};const messages=[]
  for(let n=0;n<5;n++){
    const page=projectBuilderConversation(events,cursor);messages.push(...page.messages);cursor=page.cursor
    if(!page.has_more)break
  }
  assert.equal(messages.filter(m=>m.role==='assistant').map(m=>m.text).join(''),reply)
  assert.equal(messages.filter(m=>m.role==='user').map(m=>m.text).join(''),'question')
  assert.deepEqual(cursor,{seq:3,offset:0})
  assert.doesNotMatch(JSON.stringify(messages),/internal output|private reasoning|private tool/)
  assert.throws(()=>projectBuilderConversation(events,{seq:2,offset:10000}),/cursor/)
  assert.throws(()=>projectBuilderConversation(events,{seq:-1,offset:0}),/cursor/)
  assert.throws(()=>projectBuilderConversation([],{seq:2,offset:4}),/cursor/)
})
test('Builder conversation excludes official runtime snapshots and unclassified synthetic user events',()=>{
 const events=['runtime-context','tool-registry',undefined,'human'].map((kind,seq)=>({seq,type:'user/message',data:{...(kind?{source:{kind}}:{}),content:[{type:'text',text:kind==='human'?'Owner message':'internal runtime checkout and file policy'}]}}))
 const page=projectBuilderConversation(events)
 assert.deepEqual(page.messages,[{seq:3,offset:0,role:'user',text:'Owner message',continued:false}])
 assert.deepEqual(page.cursor,{seq:4,offset:0})
})
test('Builder conversation route denies Agent reads and never accepts execution commands',async()=>{
  let route,status,kind='agent',reads=0
  registerBuilderConversation({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind}}})}},{backendClient:{call:()=>{reads++;throw new Error('should not read')}}})
  const res={writeHead:s=>{status=s},end:()=>{}}
  await route.handler({method:'GET',url:'/api/kode/builder/conversation?operation_id=op'},res);assert.equal(status,403)
  kind='owner'
  await route.handler({method:'POST',url:'/api/kode/builder/conversation'},res);assert.equal(status,405)
  await route.handler({method:'GET',url:'/api/kode/builder/conversation?operation_id=op&seq=-1'},res);assert.equal(status,409)
  assert.equal(reads,0)
})
