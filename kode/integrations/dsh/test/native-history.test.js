import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHistorySeed,renumberNativeTurns,encodeHistoryArtifact } from '../src/native-history.js'
import { Session,KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
const selection={provider:'kode-agent-example',model:'example-model'}
const time=Date.parse('2026-01-01T00:00:00Z')
const timeline=[{kind:'turn_start',time},{kind:'text',role:'user',text:'Check cwd',time:time+1000},{kind:'text',role:'agent',text:'Checking.',time:time+2000},{kind:'tool_call',call_id:'one',name:'exec_command',arguments:{cmd:'pwd'},time:time+3000},{kind:'tool_call',call_id:'two',name:'exec_command',arguments:{cmd:'git status'},time:time+4000},{kind:'tool_result',call_id:'two',text:'clean',time:time+5000},{kind:'tool_result',call_id:'one',text:'/srv/project',time:time+6000},{kind:'text',role:'agent',text:'All done.',time:time+40000},{kind:'turn_end',reason:'completed',time:time+45000}]
test('historical seed preserves original duration and native tool lifecycles without inference',()=>{
 const events=buildHistorySeed({timeline},selection)
 assert.equal(events.find(e=>e.type==='turn/end').time-events.find(e=>e.type==='turn/start').time,45000)
 assert.equal(events.filter(e=>e.type==='tool/call').length,2);assert.equal(events.filter(e=>e.type==='tool/result').length,2)
 assert.equal(events.find(e=>e.type==='tool/call').data.arguments,'{"cmd":"pwd"}')
 assert.ok(events.every(e=>!e.data.interrupted));assert.equal(events.at(-1).data.reason.kind,'completed')
 assert.doesNotThrow(()=>Session.create('history-fixture',events))
})
test('real interruption stays aborted and a mid-tool window does not invent orphan results',()=>{
 const events=buildHistorySeed({timeline:[{kind:'tool_result',call_id:'outside-window',text:'omitted',time},...timeline.slice(0,4),{kind:'turn_end',reason:'aborted',time:time+10000}]},selection)
 assert.equal(events.at(-1).data.reason.kind,'aborted')
 assert.equal(events.filter(e=>e.type==='tool/result').length,1)
 assert.match(events.find(e=>e.type==='tool/result').data.message.content[0].text,/未记录/)
 assert.doesNotThrow(()=>Session.create('interrupted-history',events))
})
test('turn repair follows log order and preserves all message IDs, times and seq references',()=>{
 const events=[{type:'turn/start',seq:0,time,data:{turn:1}},{type:'turn/end',seq:1,time:time+1,data:{turn:1}},{type:'turn/start',seq:2,time:time+90000,data:{turn:1}},{type:'assistant/message',seq:3,time:time+100000,data:{turn:1,step:1,message:{id:'original-id'}}}]
 const repaired=renumberNativeTurns(events)
 assert.deepEqual(repaired.map(e=>e.data.turn),[1,1,2,2]);assert.equal(repaired[3].data.message.id,'original-id');assert.equal(repaired[3].seq,3);assert.equal(repaired[3].time,time+100000);assert.equal(events[3].data.turn,1)
})
test('history including parallel native tools satisfies the released reader relationships',{skip:!process.env.KODE_TEST_DSH_NODE_MODULES},async()=>{
 const {assertReleasedV4Relationships}=await import(pathToFileURL(join(process.env.KODE_TEST_DSH_NODE_MODULES,'@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')))
 const events=buildHistorySeed({timeline},selection),session=Session.create('released-history',events)
 assert.doesNotThrow(()=>assertReleasedV4Relationships({header:session.header,inheritedEventCount:0,events},KNOWN_SESSION_EVENT_TYPES))
})
test('repaired artifacts are discoverable and readable by the actual released persistence backend',{skip:!process.env.KODE_TEST_DSH_NODE_MODULES},async()=>{
 const Jsonl=await import(pathToFileURL(join(process.env.KODE_TEST_DSH_NODE_MODULES,'@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')))
 const root=await mkdtemp(join(tmpdir(),'kode-history-artifact-')),ctx=new Context()
 await ctx.plugin(SessionStore)
 const id='history-file-fixture',events=buildHistorySeed({timeline},selection),session=Session.create(id,events)
 const fiber=await ctx.plugin(Jsonl,{root})
 try{
  const created=await ctx.sessionPersistence.create(session.header);await created.flush();await created.close()
  const buckets=(await readdir(root,{withFileTypes:true})).filter(row=>row.isDirectory())
  const path=join(root,buckets[0].name,id)
  await writeFile(join(path,'session.v4.jsonl.zstd'),encodeHistoryArtifact({type:'session',...session.header},events))
  const listed=await ctx.sessionPersistence.list();assert.equal(listed[0].header.id,id)
  const handle=await ctx.sessionPersistence.open(id,'read')
  try{const stored=await handle.read();assert.equal(stored.events.length,events.length);assert.equal(stored.events[0].time,time)}finally{await handle.close()}
 }finally{await fiber.dispose();await rm(root,{recursive:true,force:true})}
})
