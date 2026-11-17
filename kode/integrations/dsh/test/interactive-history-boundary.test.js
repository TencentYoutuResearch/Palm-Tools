import test from 'node:test'
import assert from 'node:assert/strict'
import {assertOrdinaryHandoffSource,assertOrdinaryHandoffIdentity} from '../src/native-handoff-contract.js'
import {INTERACTIVE_TEAM_RECORD,INTERACTIVE_TEAM_INPUT_RECORD,assertNoInteractiveHistoryCopy,assertInteractiveParentHistory} from '../src/native-interactive-team.js'
import {editBranchSeed,HistoryEditor,branchHistoryInput} from '../src/history-edit.js'
import {NativeAgentFactory,installNativeFactoryRouting} from '../src/native-agent-factory.js'
const log=[{seq:0,time:1,type:INTERACTIVE_TEAM_RECORD,ignorable:true,data:{version:1,binding:{binding_id:'bound'}}}]
test('live and cold interactive ordinary handoff refuse before discovery; ordinary unchanged',async()=>{
 assert.throws(()=>assertOrdinaryHandoffSource({binding:()=>({profile:{}})},'owned',{session:{snapshotEvents:()=>log}}),{code:'INTERACTIVE_TEAM_HANDOFF_REQUIRED'})
 let closes=0
 const bridge={service:name=>name==='sessionPersistence'?{open:async()=>({read:async()=>({events:log}),close:async()=>{closes++}})}:undefined}
 await assert.rejects(assertOrdinaryHandoffIdentity(bridge,'owned'),/cannot be copied/);assert.equal(closes,1)
 assert.doesNotThrow(()=>assertOrdinaryHandoffSource({binding:()=>({profile:{}})},'ordinary',{status:'idle',session:{snapshotEvents:()=>[]}}))
})
test('branch prefix and history replay cannot launder interactive records',async()=>{
 assert.throws(()=>editBranchSeed(log,0,{},{}),/cannot be copied/)
 assert.throws(()=>assertNoInteractiveHistoryCopy([{type:INTERACTIVE_TEAM_INPUT_RECORD}]),/cannot be copied/)
 await assert.rejects(branchHistoryInput({snapshotEvents:()=>log},{historyBranch:true},null,false),/cannot be copied/)
 assert.ok(editBranchSeed([],0,{sourceId:'ordinary'},{provider:'kode-agent-original',model:'fixture'}).length>0)
 let disposed=0,writes=0
 const editor=new HistoryEditor({get:name=>name==='sessionQuery'?{observeSession:async()=>({events:log,[Symbol.dispose](){disposed++}})}:name==='sessionPersistence'?{stat:()=>{writes++;throw Error('must not inspect destination')}}:name==='sessionController'?{}:undefined},{})
 await assert.rejects(editor.create({sessionId:'owned',seq:0,text:'replacement'},'12345678','fingerprint'),/cannot be copied/);assert.equal(disposed,1);assert.equal(writes,0)
})
test('explicit parent source is read-only checked and closed, with ordinary no-parent zero reads',async()=>{
 let reads=0,closed=0
 const ctx={agents:{get:()=>undefined},sessionPersistence:{open:async()=>{reads++;return {read:async()=>({events:log}),close:async()=>{closed++}}}}}
 await assertInteractiveParentHistory(ctx,{});assert.equal(reads,0)
 await assert.rejects(assertInteractiveParentHistory(ctx,{meta:{parentSession:'owned'}}),/cannot be copied/);assert.equal(reads,1);assert.equal(closed,1)
 const f=new NativeAgentFactory(ctx);await assert.rejects(f.importHistory('ordinary',log,'/tmp',{}),/cannot be copied/);assert.equal(reads,1)
})
test('generic factory router denies interactive seed before native or official destination',async()=>{
 let official=0,nativeCalls=0
 const upstream={createAgent:async()=>{official++;return {agent:{id:'ordinary'}}},resume:async()=>({})}
 const ctx={agents:{requireFactory:()=>({target:upstream}),get:()=>undefined},kodeAgents:{profiles:{bindings:{}}},sessionPersistence:{},on(){},agentPresets:{}}
 const native={createAgent:async()=>{nativeCalls++}}
 const dispose=installNativeFactoryRouting(ctx,native)
 await assert.rejects(upstream.createAgent({}, {sessionId:'copy',seed:log,agentOptions:{provider:'official-provider'}}),/cannot be copied/)
 assert.equal(official,0);assert.equal(nativeCalls,0)
 await upstream.createAgent({}, {sessionId:'ordinary',agentOptions:{provider:'official-provider'}});assert.equal(official,1)
 dispose()
})
