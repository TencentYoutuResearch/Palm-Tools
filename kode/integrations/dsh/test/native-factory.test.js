import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { assistantStreamFirstTokenTime, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import * as factoryPlugin from '../src/native-agent-factory.js'
import {buildHistorySeed} from '../src/native-history.js'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { mountNativeCommands } from '../src/native-commands.js'
import { pendingShellContext } from '../src/native-shell.js'
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function host(adapter) {
  const ctx = new Context(), stored = new Map(), writers = new Map()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(ProjectionRegistry)
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('agentPresets', { register: async () => () => {} })
  ctx.provide('kodeAgents', { adapter })
  const makeHandle = (row, write) => {
    const handle = { header: row.header, inheritedEventCount: 0,
      read: async () => ({ events: [...row.events] }),
      append: async events => { assert.equal(events[0]?.seq ?? row.events.length, row.events.length); row.events.push(...events) },
      flush: async () => {}, close: async () => { if (writers.get(row.header.id) === handle) writers.delete(row.header.id) },
    }
    if (write) { if (writers.has(row.header.id)) throw new Error('already owned'); writers.set(row.header.id, handle) }
    return handle
  }
  ctx.provide('sessionPersistence', {
    create: async header => { if (stored.has(header.id)) throw new Error('already exists'); const row = { header, events: [] }; stored.set(header.id, row); return makeHandle(row, true) },
    open: async (id, access) => { if (!stored.has(id)) throw new Error('not found'); return makeHandle(stored.get(id), access === 'write') },
  })
  ctx.on('session/event', (session, event) => { const row = stored.get(session.id); if (row && writers.has(session.id)) { assert.equal(event.seq, row.events.length); row.events.push(event) } })
  ctx.on('session/flush', async () => {})
  const fiber = await ctx.plugin(factoryPlugin)
  return { ctx, stored, writers, fiber }
}
const message = (id, text) => ({ id, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text }] })
const options = { sessionId: 'session-native-check', agentOptions: { provider: 'kode-agent-fixture', model: 'fixture' }, meta: { cwd: '/tmp' } }

test('native factory persists actual Agent turns without assembling a dsh system prompt and resumes once', async () => {
  const inputs = []
  const h = await host({ async *stream(request) { inputs.push(request.messages.map(m => m.id)); yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Native reply' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native reply' } }; yield { type: 'finish', reason: { kind: 'stop' } } }, closeSession: async () => {} })
  let prompts = 0, scopedToolReads = 0
  h.ctx.tools.schemas = scope => { assert.equal(scope.id, options.sessionId); scopedToolReads++; return [] }
  h.ctx.on('system-prompt/assemble', () => { prompts++; throw new Error('Native Agent must own its prompt') })
  const first = await h.ctx.agents.create(options)
  first.agent.followup(message('one', 'hello')); await first.agent.whenIdle()
  const log = h.stored.get(options.sessionId).events
  assert.ok(log.some(e => e.type === 'assistant/message' && e.data.message.content.some(c => c.text === 'Native reply')))
  const answer = log.find(e => e.type === 'assistant/message')
  assert.equal(typeof assistantStreamFirstTokenTime(answer.data.stream), 'number')
  assert.ok(expandAssistantStream(answer.data.stream).some(row => row.chunk.type === 'text-delta'))
  assert.ok(log.some(e => e.type === 'turn/end' && e.data.reason.kind === 'completed'))
  assert.equal(prompts, 0)
  assert.equal(scopedToolReads, 1)
  assert.ok(!log.some(e => e.type === 'system/message' || e.type === 'developer/message'))
  await first.dispose()
  assert.equal(h.writers.size, 0)
  const second = await h.ctx.agents.resume({ resumeSessionId: options.sessionId, agentOptions: options.agentOptions })
  second.agent.followup(message('two', 'again')); await second.agent.whenIdle()
  assert.deepEqual(inputs, [['one'], ['two']])
  await h.fiber.dispose()
  assert.equal(h.ctx.agents.list().length, 0)
  assert.equal(h.ctx.sessions.list().length, 0)
  assert.equal(h.writers.size, 0)
})

test('a driver attached before historical import allocates fresh monotone turn numbers',async()=>{
  const h=await host({async *stream(){yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'New answer'};yield{type:'block-end',index:0,block:{type:'text',text:'New answer'}};yield{type:'finish',reason:{kind:'stop'}}},closeSession:async()=>{}})
  const handle=await h.ctx.agents.create(options),session=handle.agent.session
  for(let turn=1;turn<=3;turn++){
    session.append('turn/start',{turn});session.append('step/start',{turn,step:1})
    session.append('user/message',message(`historical-${turn}`,'Old request'),{surfaceOp:'append'})
    session.append('assistant/message',{turn,step:1,message:{id:`answer-${turn}`,role:'assistant',source:{kind:'model',...options.agentOptions},content:[{type:'text',text:'Old answer'}]},stream:[]},{surfaceOp:'append'})
    session.append('step/end',{turn,step:1});session.append('turn/end',{turn,reason:{kind:'completed'}})
  }
  handle.agent.followup(message('new-request','Continue'));await handle.agent.whenIdle()
  assert.deepEqual(h.stored.get(options.sessionId).events.filter(e=>e.type==='turn/start').map(e=>e.data.turn),[1,2,3,4])
  assert.equal(h.stored.get(options.sessionId).events.at(-1).data.reason.kind,'completed')
  await h.fiber.dispose()
})

test('native model selection is session-local and does not persist or reload global defaults',async()=>{
  const models=[],globalDefault={provider:'kode-agent-fixture',model:'fixture'}
  const h=await host({async *stream(request){models.push(request.model);yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'Done'};yield{type:'block-end',index:0,block:{type:'text',text:'Done'}};yield{type:'finish',reason:{kind:'stop'}}},closeSession:async()=>{}})
  h.ctx.provide('agentDefaultModel',{currentSelection:()=>globalDefault,saveSelection:async()=>{throw new Error('Global default must remain unchanged')}})
  const handle=await h.ctx.agents.create(options)
  const selected=handle.agent.selectModel({provider:'kode-agent-fixture',model:'another-model'})
  assert.equal(selected.selected.model,'another-model');assert.equal(globalDefault.model,'fixture')
  handle.agent.followup(message('model-test','Hello'));await handle.agent.whenIdle()
  assert.deepEqual(models,['another-model']);assert.ok(h.stored.get(options.sessionId).events.some(event=>event.type==='model/selection'&&event.data.model==='another-model'))
  await h.fiber.dispose()
})

test('! commands use the shipped workspace shell without inference and persist context for the next native prompt',async()=>{
  const root=await mkdtemp(join(tmpdir(),'kode-human-shell-')),log=join(root,'wire.jsonl')
  const h=await host({closeSession:async()=>{}})
  const processes=await h.ctx.plugin(Subprocess),shell=await h.ctx.plugin(LocalBashExecutor)
  const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'fixture',name:'Fixture',type:'codex',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))],env:{KODE_FIXTURE_RPC_LOG:log}}])
  const adapter=new AgentRuntimeAdapter(h.ctx,profiles,{recordNative:()=>{}})
  Object.assign(h.ctx.kodeAgents,{profiles,adapter,recordBinding:()=>{}})
  try{
    const handle=await h.ctx.agents.create({...options,meta:{cwd:root}}),agent=handle.agent
    agent.followup(message('user-shell','!pwd'));await agent.whenIdle()
    const rows=h.stored.get(options.sessionId).events
    assert.equal(rows.findLast(row=>row.type==='turn/end').data.reason.kind,'completed')
    assert.ok(rows.find(row=>row.type==='tool/result').data.message.content[0].text.includes(await realpath(root)))
    assert.equal(adapter.live.size,0,'! must not start a native model process')
    assert.equal(pendingShellContext(agent.session).length,1)
    agent.followup(message('followup','Summarize that result'));await agent.whenIdle()
    const wire=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse),turns=wire.filter(row=>row.method==='turn/start')
    assert.equal(turns.length,1);assert.match(turns[0].params.input[0].text,/用户在工作区[\s\S]*执行了终端命令：[\s\S]*pwd/)
    assert.equal(turns[0].params.input.at(-1).text,'Summarize that result');assert.equal(pendingShellContext(agent.session).length,0)
  }finally{await h.fiber.dispose();await adapter.close();await shell.dispose();await processes.dispose();await rm(root,{recursive:true,force:true})}
})

test('native slash definitions shadow harness commands only for their Agent and unload with it',async()=>{
  const received=[],h=await host({async *stream(request){received.push(request);yield{type:'finish',reason:{kind:'stop'}}},closeSession:async()=>{}})
  const commands=await h.ctx.plugin(CommandRuntime)
  const global=h.ctx.commands.register({name:'compact',description:'Harness compaction',handler:()=>({kind:'success',text:'global'})})
  const {agent}=await h.ctx.agents.create(options)
  const service={commandOwners:new Map(),adapter:{capabilities:async()=>({commands:[{name:'compact',description:'Native compact'},{name:'team:review',description:'Project skill',input:{hint:'task'}}],modes:[]}),listModels:async()=>[{id:'next-model',name:'Friendly model'}]}}
  try{
    await mountNativeCommands(agent,service,{id:'fixture',name:'Company Codex',type:'codex',executable:'codex',args:[],env:{}})
    assert.equal(h.ctx.commands.list(agent).find(row=>row.name==='compact').description,'Native compact')
    const selected=await h.ctx.commands.execute(agent,'/model Friendly model',[],new AbortController().signal)
    assert.equal(selected.result.kind,'success');assert.equal(agent.options.model,'next-model')
    await h.ctx.commands.execute(agent,'/team-review inspect',[],new AbortController().signal);await agent.whenIdle()
    assert.equal(received[0].messages[0].content[0].text,'/team:review inspect')
    const other={id:'other'};assert.equal(h.ctx.commands.list(other).find(row=>row.name==='compact').description,'Harness compaction')
    await h.fiber.dispose();assert.equal(h.ctx.commands.list(agent).find(row=>row.name==='compact').description,'Harness compaction')
  }finally{await h.fiber.dispose();global();await commands.dispose()}
})

test('history import is seeded with native timestamps before its driver is published',async()=>{
  const h=await host({async *stream(){yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'New answer'};yield{type:'block-end',index:0,block:{type:'text',text:'New answer'}};yield{type:'finish',reason:{kind:'stop'}}},closeSession:async()=>{}})
  const time=Date.parse('2026-01-01T00:00:00Z'),seed=buildHistorySeed({timeline:[{kind:'turn_start',time},{kind:'text',role:'user',text:'Old question',time:time+1000},{kind:'text',role:'agent',text:'Old answer',time:time+20000},{kind:'turn_end',reason:'completed',time:time+30000}]},options.agentOptions)
  await h.ctx.kodeNativeFactory.importHistory(options.sessionId,seed,'/tmp',options.agentOptions)
  const agent=h.ctx.agents.get(options.sessionId);agent.followup(message('next','Continue'));await agent.whenIdle()
  const rows=h.stored.get(options.sessionId).events
  assert.equal(rows.find(e=>e.type==='turn/end').time-rows.find(e=>e.type==='turn/start').time,30000)
  assert.deepEqual(rows.filter(e=>e.type==='turn/start').map(e=>e.data.turn),[1,2])
  await h.fiber.dispose()
})

test('unplugging a native runtime cancels and drains a live Agent before releasing storage', async () => {
  let started, ended = false
  const running = new Promise(resolve => { started = resolve })
  const h = await host({ async *stream({ signal }) { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); ended = true; signal.throwIfAborted() }, closeSession: async () => {} })
  const handle = await h.ctx.agents.create(options)
  handle.agent.followup(message('cancel', 'work')); await running
  await h.fiber.dispose()
  assert.equal(ended, true)
  assert.equal(h.writers.size, 0)
  assert.equal(h.ctx.agents.list().length, 0)
  assert.equal(h.stored.get(options.sessionId).events.at(-1).data.reason.kind, 'aborted')
})
