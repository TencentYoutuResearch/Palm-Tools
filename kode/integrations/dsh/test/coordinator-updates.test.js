import test from 'node:test'
import assert from 'node:assert/strict'
import { CoordinatorUpdates } from '../src/coordinator-updates.js'
test('Coordinator notice discovery survives lost reply and continues beyond a blocked page',async()=>{
 let queued=false,writes=0
 const runtime={client:{call:async(path,body)=>{
  if(!body){if(path.endsWith('?after=blocked'))return {items:queued?[]:[{run_id:'ready',revision:2}],next_cursor:null};return {items:[{run_id:'blocked',revision:1}],next_cursor:'blocked'}}
  if(path.includes('/blocked/'))throw Error('control unavailable')
  writes++;queued=true;throw Error('committed response lost')
 }}}
 const first=new CoordinatorUpdates(runtime,{intervalMs:100})
 assert.deepEqual((await first.scan()).map(r=>r.state),['pending'])
 await Promise.all([first.scan(),first.scan()]);assert.equal(writes,1)
 await first.close()
 const restored=new CoordinatorUpdates(runtime,{intervalMs:100})
 await restored.scan();assert.deepEqual(await restored.scan(),[]);assert.equal(writes,1)
 await restored.close();await assert.rejects(restored.scan(),/closed/)
})
test('Coordinator notice discovery rejects oversized or looping pages without writes',async()=>{
 let page={items:Array.from({length:33},(_,i)=>({run_id:`run-${i}`,revision:1})),next_cursor:null}
 const runtime={client:{call:async(_path,body)=>{assert.equal(body,undefined);return page}}}
 const service=new CoordinatorUpdates(runtime,{intervalMs:100})
 await assert.rejects(service.scan(),/Invalid/)
 page={items:[],next_cursor:'same'};await service.scan();await assert.rejects(service.scan(),/Invalid/)
 await service.close()
})
