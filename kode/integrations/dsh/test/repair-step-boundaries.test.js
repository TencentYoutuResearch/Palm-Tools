import test from 'node:test'
import assert from 'node:assert/strict'
import { repairNativeStepBoundaries } from '../src/repair-step-boundaries.js'
const row=(type,data,surfaceOp)=>({type,data,...(surfaceOp?{surfaceOp}:{})})
const fixture=()=>[
 row('plugin:kode/native-event',{event:{method:'fixture'}}),row('turn/start',{turn:1}),row('step/start',{turn:1,step:1}),
 row('assistant/message',{turn:1,step:1,message:{content:[{type:'tool-call',id:'kode:parallel',name:'exec_command',arguments:'{}'}]}},'append'),
 row('tool/call',{turn:1,step:1,callId:'kode:parallel'}),row('step/end',{turn:1,step:1}),row('step/start',{turn:1,step:2}),
 row('assistant/message',{turn:1,step:2,message:{content:[{type:'text',text:'Intervening progress'}]}},'append'),
 row('tool/result',{turn:1,step:2,message:{toolCallId:'kode:parallel',content:[{type:'text',text:'Actual original output'}]}},'append'),row('step/end',{turn:1,step:2}),row('turn/end',{turn:1})
].map((event,seq)=>({...event,seq,time:seq}))
test('repair preserves sequence identities, actual outputs and original boundary evidence',()=>{
 const input=fixture(),before=structuredClone(input),{events,changes}=repairNativeStepBoundaries(input)
 assert.deepEqual(input,before);assert.equal(events.length,input.length);assert.deepEqual(events.map(e=>e.seq),input.map(e=>e.seq));assert.ok(changes.length)
 assert.equal(events[5].type,'plugin:kode/step-boundary-repair');assert.equal(events[5].data.originalType,'step/end')
 assert.equal(events[8].data.step,1);assert.deepEqual(events[8].data.message,input[8].data.message)
 assert.deepEqual(repairNativeStepBoundaries(events).changes,[])
})
test('missing outcomes cannot be repaired by guessing and active logs are refused',()=>{
 assert.throws(()=>repairNativeStepBoundaries(fixture().filter(e=>e.type!=='tool/result')),/missing operation outcome/)
 assert.throws(()=>repairNativeStepBoundaries(fixture().slice(0,5)),/active or incomplete/)
})

test('repaired files round-trip through the released persistence reader including its compressed framing', {skip:!process.env.KODE_TEST_DSH_NODE_MODULES}, async()=>{
 const {Context}=await import('@deepseek-ai/cordis'),{default:SessionStore,Session,appendPluginRecord}=await import('@deepseek-ai/dsh-session')
 const {mkdtemp,readdir,writeFile,rm}=await import('node:fs/promises'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{pathToFileURL}=await import('node:url')
 const {encodeHistoryArtifact}=await import('../src/native-history.js'),Jsonl=await import(pathToFileURL(join(process.env.KODE_TEST_DSH_NODE_MODULES,'@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')))
 const session=Session.create('repair-roundtrip'),source={kind:'model',provider:'fixture',model:'fixture'},callId='kode:parallel'
 appendPluginRecord(session,'plugin:kode/native-event',{event:{method:'fixture'}})
 session.append('turn/start',{turn:1});session.append('request/header',{header:{config:{provider:'fixture',model:'fixture'}},reason:'initial'});session.append('step/start',{turn:1,step:1})
 session.append('assistant/message',{turn:1,step:1,message:{id:'call',role:'assistant',source,content:[{type:'tool-call',id:callId,name:'exec_command',arguments:'{}'}]},stream:[]},{surfaceOp:'append'})
 session.append('tool/call',{turn:1,step:1,callId,name:'exec_command',arguments:'{}'})
 session.append('step/end',{turn:1,step:1});session.append('step/start',{turn:1,step:2})
 session.append('tool/result',{turn:1,step:2,message:{id:'result',role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:[{type:'text',text:'Preserved output'}],isError:false}},{surfaceOp:'append'})
 session.append('step/end',{turn:1,step:2});session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 const {events}=repairNativeStepBoundaries(session.snapshotEvents()),root=await mkdtemp(join(tmpdir(),'kode-log-repair-')),ctx=new Context();await ctx.plugin(SessionStore);const fiber=await ctx.plugin(Jsonl,{root})
 try{
  const handle=await ctx.sessionPersistence.create(session.header);await handle.flush();await handle.close()
  const bucket=(await readdir(root,{withFileTypes:true})).find(row=>row.isDirectory()).name
  await writeFile(join(root,bucket,session.id,'session.v4.jsonl.zstd'),encodeHistoryArtifact({type:'session',...session.header},events))
  assert.equal((await ctx.sessionPersistence.list())[0].header.id,session.id)
  const restored=await ctx.sessionPersistence.open(session.id,'read');try{const data=await restored.read();assert.equal(data.events.length,events.length);assert.equal(data.events.find(e=>e.type==='tool/result').data.message.content[0].text,'Preserved output')}finally{await restored.close()}
 }finally{await fiber.dispose();await rm(root,{recursive:true,force:true})}
})
