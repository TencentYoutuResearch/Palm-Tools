import test from 'node:test'
import assert from 'node:assert/strict'
import {snapshotProviderRequest,verifyProviderRequest,scopedProviderLifetime} from '../src/scoped-provider-transport.js'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
test('strict content and transport separation',()=>{
  const expected={sessionId:'a',provider:'p',model:'m',messages:[{text:'A'}],toolHistory:[],tools:[]}
  const controller=new AbortController(),{tools,...raw}=expected
  const snapshot=snapshotProviderRequest({...raw,signal:controller.signal})
  raw.messages[0].text='B'
  const result=verifyProviderRequest(snapshot,{...expected,messages:[{text:'A'}]})
  assert.equal(result.signal,controller.signal);assert.ok(Object.isFrozen(result.messages[0]))
  for(const extra of [{context_scope:{}},{systemPrompt:'PRIVATE'},{signal:{}},{extraMessages:[]}]){
    assert.throws(()=>snapshotProviderRequest({...expected,...extra}))
  }
  for(const field of ['sessionId','messages','toolHistory','tools','model']){
    assert.throws(()=>verifyProviderRequest(snapshotProviderRequest({...expected,[field]:'PRIVATE'}),expected))
  }
  assert.throws(()=>verifyProviderRequest(snapshotProviderRequest(raw),{...expected,tools:[{name:'A'}]}))
})
for(const end of ['done','return','throw','provider-error','abort'])test(`stream lease survives deferred operations until ${end}`,async()=>{
  const pending=deferred(),controller=new AbortController();let releases=0,closed=0,fences=0
  const source={ [Symbol.asyncIterator](){return this},async next(){await pending.promise;if(end==='provider-error')throw Error('provider');return {done:end==='done',value:'A'}},async return(){closed++;return {done:true}} }
  const stream=await scopedProviderLifetime({invoke:()=>source,signal:controller.signal,release:()=>releases++,failed:()=>fences++})
  assert.equal(releases,0)
  const next=stream.next();await Promise.resolve()
  let ending
  if(end==='return')ending=stream.return()
  if(end==='throw')ending=assert.rejects(stream.throw(Error('consumer')),/consumer/)
  if(end==='abort')controller.abort(Error('cancelled'))
  assert.equal(releases,0)
  const outcome=['abort','provider-error'].includes(end)?assert.rejects(next,/cancelled|provider/):next
  pending.resolve();await outcome;await ending
  assert.equal(releases,1);assert.equal(fences,0)
  assert.equal(closed,end==='done'?0:1)
})
test('failed cancellation fences; pending provider cannot release early',async()=>{
  const pending=deferred(),controller=new AbortController();let releases=0,fences=0
  const result=scopedProviderLifetime({invoke:()=>pending.promise,signal:controller.signal,release:()=>releases++,failed:()=>fences++})
  controller.abort();assert.equal(releases,0)
  pending.resolve({[Symbol.asyncIterator](){return this},next(){},async return(){throw Error('cleanup')}})
  await assert.rejects(result,/cleanup/);assert.equal(releases,1);assert.equal(fences,1)
})
