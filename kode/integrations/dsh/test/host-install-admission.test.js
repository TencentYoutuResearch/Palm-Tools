import test from 'node:test'
import assert from 'node:assert/strict'
import {ordinaryHostInstall,requiresDedicatedHostAdmission} from '../src/host-install-admission.js'
import {NATIVE_PLANNING_RECORD} from '../src/native-planning-session.js'
import {SCOPED_COORDINATOR_JOURNAL_RECORD} from '../src/scoped-coordinator-journal.js'
const agent=(id,records=[])=>({id,isKodeNativeAgent:true,session:{snapshotEvents:()=>records}})
for(const [label,value] of [
 ['interactive journal',agent('interactive',[{type:'plugin:kode/interactive-team'}])],
 ['scope journal',agent('restoring',[{type:SCOPED_COORDINATOR_JOURNAL_RECORD}])],
 ['reserved scope awaiting trusted factory',agent(`context-${'a'.repeat(64)}`)],
 ['planning journal',agent('planning',[{type:NATIVE_PLANNING_RECORD}])],
])test(`${label} cannot enter ordinary token/memory/interop/pump installer`,async()=>{
 let calls=0;assert.equal(requiresDedicatedHostAdmission(value),true)
 await ordinaryHostInstall(value,()=>{calls++;throw Error('Must not register')})
 assert.equal(calls,0)
})
test('ordinary native and legacy sessions retain existing installer result and errors',async()=>{
 for(const value of [agent('ordinary-native'),agent('legacy-coordinator')]){
  let calls=0;assert.equal(requiresDedicatedHostAdmission(value),false)
  assert.equal(await ordinaryHostInstall(value,async()=>{calls++;return 'installed'}),'installed');assert.equal(calls,1)
  assert.throws(()=>ordinaryHostInstall(value,()=>{throw Error('original failure')}),/original failure/)
 }
})
