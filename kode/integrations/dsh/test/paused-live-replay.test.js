import test from 'node:test'
import assert from 'node:assert/strict'
import { pausedLiveReplay } from './support/paused-live-replay.js'
function fixture(){const events=[],failure=Object.assign(Error('stage failed'),{code:23});let state='waiting_resource';let closes=0;
 const hold=pausedLiveReplay({pauseAutomatic:async()=>events.push('pause-scans'),capture:async phase=>events.push(phase),readRun:async()=>({id:'run',state}),settleCancellation:async()=>{events.push('real-stop-chain');return{state:'waiting_cancellation_accounting'}},closeOwned:async()=>{closes++;events.push('dispose-host-hub')}})
 return{hold,events,failure,setState:value=>state=value,closes:()=>closes}}
test('failure hold stops automatic progression while preserving original Host ownership and exception',async()=>{
 const f=fixture();await f.hold.pause(f.failure)
 assert.equal(f.hold.phase,'held');assert.equal(f.hold.originalFailure,f.failure)
 assert.equal(f.closes(),0);assert.deepEqual(f.events,['before_manual_hold','pause-scans','manual_hold_ready'])
 assert.equal((await f.hold.status()).state,'waiting_resource');assert.equal(f.closes(),0)
 await f.hold.pause(Error('duplicate'));assert.equal(f.hold.originalFailure,f.failure)
})
test('held replay cannot advance ordinary work; cancellation requires an existing authoritative owner request',async()=>{
 const f=fixture();await f.hold.pause(f.failure)
 await assert.rejects(f.hold.reconcileCancellation(),/Owner cancellation/);assert.equal(f.events.includes('real-stop-chain'),false)
 f.setState('cancelling');assert.equal((await f.hold.reconcileCancellation()).state,'waiting_cancellation_accounting');assert.equal(f.events.filter(x=>x==='real-stop-chain').length,1)
 f.setState('cancelled');assert.equal((await f.hold.reconcileCancellation()).state,'cancelled');assert.equal(f.events.filter(x=>x==='real-stop-chain').length,1)
})
test('manual disposal runs once after evidence capture and original stage failure remains inspectable',async()=>{
 const f=fixture();await f.hold.pause(f.failure);await Promise.all([f.hold.close(),f.hold.close()])
 assert.equal(f.closes(),1);assert.equal(f.hold.phase,'closed');assert.equal(f.hold.originalFailure.code,23)
 assert.deepEqual(f.events.slice(-3),['before_manual_close','dispose-host-hub','after_manual_close'])
 await assert.rejects(f.hold.status(),/not safely held/)
})
test('failed pause cannot masquerade as held and evidence failure does not replace the pause error',async()=>{
 const pauseError=Error('scanner stop failed'),failure=Error('original')
 const hold=pausedLiveReplay({pauseAutomatic:async()=>{throw pauseError},capture:async()=>{throw Error('evidence')},readRun:async()=>({state:'running'}),settleCancellation:async()=>assert.fail('must not run'),closeOwned:async()=>{}})
 await assert.rejects(hold.pause(failure),error=>error===pauseError);assert.equal(hold.phase,'pause_unconfirmed');assert.equal(hold.originalFailure,failure)
 await assert.rejects(hold.reconcileCancellation(),/not safely held/);await hold.close()
})
