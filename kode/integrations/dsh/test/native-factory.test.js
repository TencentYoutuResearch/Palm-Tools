import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { assistantStreamFirstTokenTime, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import * as factoryPlugin from '../src/native-agent-factory.js'
import { installNativeStartupBarrier } from '../src/native-startup.js'
import {buildHistorySeed} from '../src/native-history.js'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { mountNativeCommands } from '../src/native-commands.js'
import { pendingShellContext } from '../src/native-shell.js'
import { installQueueSteering } from '../src/queue-steering.js'
import { AcpTurnCancelledError } from '../src/acp-session.js'
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function load(ctx, plugin, ...args) {
  const fiber = await ctx.plugin(plugin, ...args)
  await fiber.await?.()
  return fiber
}
async function host(adapter, official = false, requests = false) {
  const ctx = new Context(), stored = new Map(), writers = new Map()
  await load(ctx,SessionStore); await load(ctx,AgentRegistry); await load(ctx,ProjectionRegistry)
  ctx.provide('tools', { schemas: () => [], resolve: async () => ({ tools: [], schemas: [], dispose() {} }) })
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
  if (official) {
    if (requests) { await load(ctx,LlmRuntime); await load(ctx,SystemPrompt) }
    else { ctx.provide('llm', {}); ctx.provide('systemPrompt', { variable: () => () => {} }) }
    await load(ctx,AgentLoop, { agents: [], maxParallelToolCalls: 10 })
  } else {
    ctx.agents.setFactory({ createAgent() { throw new Error('official create') }, resume() { throw new Error('official resume') } })
    ctx.provide('agentLoop', {})
  }
  const fiber = await load(ctx,factoryPlugin)
  return { ctx, stored, writers, fiber }
}
const message = (id, text) => ({ id, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text }] })
const options = { sessionId: 'session-native-check', agentOptions: { provider: 'kode-agent-fixture', model: 'fixture' }, meta: { cwd: '/tmp' } }

for (const cancelled of [true, false]) test(`native cancellation ${cancelled ? 'interrupts quietly' : 'does not hide genuine failures'} and preserves partial output`, async () => {
  let runs = 0
  const h = await host({
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Partial answer' }
      if (++runs === 1) throw cancelled ? new AcpTurnCancelledError() : new Error('ACP transport failed')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Partial answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    closeSession: async () => {},
  })
  const errors = []
  h.ctx.on('agent/error', payload => errors.push(payload.error))
  try {
    const { agent } = await h.ctx.agents.create(options)
    agent.followup(message('initial', 'Task')); await agent.whenIdle()
    const events = h.stored.get(agent.id).events
    assert.equal(events.at(-1).data.reason.kind, cancelled ? 'interrupted' : 'error')
    assert.equal(errors.length, cancelled ? 0 : 1)
    const answer = events.find(event => event.type === 'assistant/message')
    assert.equal(answer.data.interrupted, true)
    assert.equal(answer.data.message.content[0].text, 'Partial answer')
    assert.equal(agent.status, 'idle')
    agent.followup(message('followup', 'Continue')); await agent.whenIdle()
    assert.equal(events.at(-1).data.reason.kind, 'completed')
    assert.equal(runs, 2)
  } finally { await h.fiber.dispose() }
})

for (const local of [false, true]) test(`CodeBuddy ${local ? 'user stop' : 'ACP cancelled response'} settles tools without a turn error and restores for followup`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-acp-cancelled-')), wire = join(root, 'wire.jsonl')
  const h = await host({ closeSession: async () => {} }, true)
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'CodeBuddy fixture', type: 'codebuddy', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))], env: { KODE_ACP_FIXTURE_LOG: wire } }])
  const adapter = new AgentRuntimeAdapter(h.ctx, profiles, { recordNative() {} })
  Object.assign(h.ctx.kodeAgents, { profiles, adapter, recordBinding() {} })
  const errors = []
  h.ctx.on('agent/error', payload => errors.push(payload.error))
  try {
    const { agent } = await h.ctx.agents.create({ ...options, agentOptions: { ...options.agentOptions, model: 'fixture-fast' }, meta: { cwd: root } })
    agent.followup(message('initial', 'WAIT_TOOL'))
    const events = h.stored.get(agent.id).events
    for (let i = 0; i < 200 && !events.some(event => event.type === 'tool/call'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(events.some(event => event.type === 'tool/call'))
    const runtime = adapter.live.get(agent.id), threadId = runtime.threadId
    if (local) agent.cancel({ kind: 'user' })
    else await runtime.connection.agent.notify('session/cancel', { sessionId: threadId })
    await agent.whenIdle()
    assert.equal(events.at(-1).data.reason.kind, local ? 'aborted' : 'interrupted')
    assert.equal(errors.length, 0)
    assert.equal(events.filter(event => event.type === 'tool/result').length, 1)
    assert.equal(events.find(event => event.type === 'tool/result').data.message.isError, true)
    assert.equal(profiles.binding(agent.id).inFlight, null)
    assert.equal(profiles.binding(agent.id).lastOutcome, 'uncertain')
    assert.equal(runtime.rpc.closed, true)
    agent.followup(message('followup', 'Continue')); await agent.whenIdle()
    assert.equal(events.at(-1).data.reason.kind, 'completed')
    assert.equal(adapter.live.get(agent.id).threadId, threadId)
    assert.equal(errors.length, 0)
    const rows = (await readFile(wire, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.method === 'session/new').length, 1)
    assert.equal(rows.filter(row => row.method === 'session/load').length, 1)
    assert.equal(rows.filter(row => row.method === 'session/prompt').length, 2)
    const { assertReleasedV4Relationships } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
    assert.doesNotThrow(() => assertReleasedV4Relationships({ header: h.stored.get(agent.id).header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES))
  } finally { await h.fiber.dispose(); await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

for (const outcome of ['accepted', 'rejected', 'uncertain']) test(`Codex steering ${outcome}: original active turn and input admission stay consistent`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-steering-')), wire = join(root, 'wire.jsonl')
  const h = await host({ closeSession: async () => {} }, true)
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_RPC_LOG: wire, ...(outcome === 'rejected' ? { KODE_FIXTURE_STEER_REJECT: '1' } : outcome === 'uncertain' ? { KODE_FIXTURE_STEER_DROP: '1' } : {}) } }])
  const adapter = new AgentRuntimeAdapter(h.ctx, profiles, { recordNative() {} })
  Object.assign(h.ctx.kodeAgents, { profiles, adapter, recordBinding() {} })
  try {
    const { agent } = await h.ctx.agents.create({ ...options, meta: { cwd: root } })
    agent.followup(message('initial', 'WAIT'))
    const readyBy = Date.now() + 5000
    while (!adapter.canSteer(agent.id) && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(adapter.canSteer(agent.id))
    const input = message('steering-input', 'Focus on the new task')
    agent.followup(input)
    const controller = { updateQueue() { throw new Error('Native transfer must not use remove-before-steer') } }
    const restore = installQueueSteering(h.ctx, controller)
    try { await controller.updateQueue({ sessionId: agent.id, itemId: input.id, action: { kind: 'steer' } }) }
    finally { restore() }
    await Promise.race([agent.whenIdle(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('steering timed out')), 6000); timer.unref() })])
    const rows = (await readFile(wire, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.method === 'turn/steer').length, 1)
    assert.equal(rows.find(row => row.method === 'turn/steer').params.expectedTurnId, 'turn-1')
    assert.equal(rows.filter(row => row.method === 'turn/start').length, outcome === 'rejected' ? 2 : 1)
    assert.equal(h.stored.get(agent.id).events.filter(event => event.type === 'user/message' && event.data.id === 'steering-input').length, 1)
    assert.equal(agent.inbox.nextStep.length + agent.inbox.nextTurn.length, 0)
    assert.ok(profiles.binding(agent.id).seenInputs.includes('steering-input'))
  } finally { await h.fiber.dispose(); await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

for (const type of ['claude', 'cursor', 'codebuddy']) for (const extension of [true, false]) test(`${type} queued steering persists a replayable official inbox (${extension ? 'inject' : 'restart'})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-acp-factory-')), wire = join(root, 'wire.jsonl')
  const h = await host({ closeSession: async () => {} }, true)
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type, executable: process.execPath, args: [fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))], env: { KODE_ACP_FIXTURE_LOG: wire, KODE_ACP_STEERING: extension ? '1' : '0' } }])
  // Exercise each real binding and adapter route without invoking an installed CLI.
  const adapter = new AgentRuntimeAdapter(h.ctx, profiles, { recordNative() {}, resolveProfile: async profile => ({ ...profile, type: 'custom' }) })
  Object.assign(h.ctx.kodeAgents, { profiles, adapter, recordBinding() {} })
  try {
    const { agent } = await h.ctx.agents.create({ ...options, agentOptions: { ...options.agentOptions, model: 'fixture-fast' }, meta: { cwd: root } })
    agent.followup(message('initial', extension ? 'WAIT' : 'WAIT_TOOL'))
    const readyBy = Date.now() + 5000
    while (!adapter.live.get(agent.id)?.active?.ready && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 10))
    const runtime = adapter.live.get(agent.id)
    assert.ok(runtime?.active?.ready)
    runtime.profile.type = type
    const input = message('steered', 'New requirement $fixture')
    agent.followup(input)
    const controller = { updateQueue() { throw new Error('Unexpected upstream transfer') } }
    const dispose = installQueueSteering(h.ctx, controller)
    try { await controller.updateQueue({ sessionId: agent.id, itemId: input.id, action: { kind: 'steer' } }) }
    finally { dispose() }
    await Promise.race([agent.whenIdle(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('ACP steering timed out')), 5000); timer.unref() })])
    const events = h.stored.get(agent.id).events
    assert.equal(events.filter(row => row.type === 'user/message' && row.data.id === input.id).length, 1)
    assert.equal(events.at(-1).data.reason.kind, 'completed')
    if (!extension) {
      assert.equal(events.filter(row => row.type === 'tool/result').length, 1)
      assert.equal(events.find(row => row.type === 'tool/result').data.message.isError, true)
    }
    assert.equal(agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0)
    assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, 'inbox'), { 'next-turn': [], 'next-step': [] })
    const { assertReleasedV4Relationships } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
    assert.doesNotThrow(() => assertReleasedV4Relationships({ header: h.stored.get(agent.id).header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES))
    const rows = (await readFile(wire, 'utf8')).trim().split('\n').map(JSON.parse)
    const restarted = type === 'codebuddy' && !extension
    assert.equal(rows.filter(row => row.method === 'session/new').length, 1)
    assert.equal(rows.filter(row => row.method === 'session/load').length, restarted ? 1 : 0)
    assert.equal(rows.filter(row => row.method === 'session/prompt').length, extension ? 1 : 2)
  } finally { await h.fiber.dispose(); await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

test('native commentary and final answer remain separate durable messages around tool activity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-native-messages-'))
  const h = await host({ closeSession: async () => {} })
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))] }])
  const adapter = new AgentRuntimeAdapter(h.ctx, profiles, { recordNative() {} })
  Object.assign(h.ctx.kodeAgents, { profiles, adapter, recordBinding() {} })
  try {
    const { agent } = await h.ctx.agents.create({ ...options, meta: { cwd: root } })
    agent.followup(message('multi-message', 'MULTI_MESSAGE')); await agent.whenIdle()
    const events = h.stored.get(options.sessionId).events
    const answers = events.filter(event => event.type === 'assistant/message').map(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')).filter(Boolean)
    assert.deepEqual(answers, ['Inspecting the workspace.', 'Final answer.'])
    assert.ok(events.some(event => event.type === 'tool/result'))
    assert.equal(events.at(-1).data.reason.kind, 'completed')
    if (process.env.KODE_TEST_DSH_NODE_MODULES) {
      const { assertReleasedV4Relationships } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
      assert.doesNotThrow(() => assertReleasedV4Relationships({ header: h.stored.get(options.sessionId).header, inheritedEventCount: 0, events }, KNOWN_SESSION_EVENT_TYPES))
    }
  } finally { await h.fiber.dispose(); await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

test('native setup appends only after store entry and creation publication, on create and resume', async () => {
  const h = await host({ closeSession: async () => {} })
  const announced = new Set()
  h.ctx.on('session/created', session => { announced.add(session.id) })
  let calls = 0
  const setup = async (_scope, driver) => {
    assert.equal(h.ctx.sessions.get(driver.id), driver.session)
    assert.ok(announced.has(driver.id), 'session/created must finish before setup writes')
    driver.session.append('agent-preset/selected', { agentPreset: 'kode-native' })
    calls++
  }
  try {
    const first = await h.ctx.agents.create({ ...options, setup }); await first.dispose()
    announced.clear()
    const second = await h.ctx.agents.resume({ resumeSessionId: options.sessionId, agentOptions: options.agentOptions, setup })
    const events = h.stored.get(options.sessionId).events
    assert.equal(calls, 2)
    assert.equal(events.filter(event => event.type === 'agent-preset/selected').length, 2)
    assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index))
    await second.dispose()
  } finally { await h.fiber.dispose() }
})

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
  const processes=await load(h.ctx,Subprocess),shell=await load(h.ctx,LocalBashExecutor)
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
  const commands=await load(h.ctx,CommandRuntime)
  const global=h.ctx.commands.register({name:'compact',description:'Harness compaction',handler:()=>({kind:'success',text:'global'})})
  const {agent}=await h.ctx.agents.create(options)
  const service={commandOwners:new Map(),adapter:{capabilities:async()=>({commands:[{name:'compact',description:'Native compact'},{name:'team:review',description:'Project skill',kind:'skill',input:{hint:'task'}}],modes:[]}),listModels:async()=>[{id:'next-model',name:'Friendly model'}]}}
  try{
    await mountNativeCommands(agent,service,{id:'fixture',name:'Company Codex',type:'codex',executable:'codex',args:[],env:{}})
    assert.equal(h.ctx.commands.list(agent).find(row=>row.name==='compact').description,'Native compact')
    const selected=await h.ctx.commands.execute(agent,'/model Friendly model',[],new AbortController().signal)
    assert.equal(selected.result.kind,'success');assert.equal(agent.options.model,'next-model')
    await h.ctx.commands.execute(agent,'/team-review inspect',[],new AbortController().signal);await agent.whenIdle()
    assert.equal(received[0].messages[0].content[0].text,'$team:review inspect')
    assert.ok(h.ctx.commands.list(agent).some(row=>row.name==='resume'))
    service.adapter.capabilities=async()=>({commands:[{name:'context',description:'Claude context'}],modes:[]})
    await mountNativeCommands(agent,service,{id:'claude-profile',name:'Claude Code',type:'claude',executable:'claude',args:[],env:{}})
    assert.ok(h.ctx.commands.list(agent).some(row=>row.name==='context'))
    assert.ok(h.ctx.commands.list(agent).some(row=>row.name==='resume'))
    assert.ok(!h.ctx.commands.list(agent).some(row=>row.name==='team-review'))
    assert.equal(h.ctx.commands.list(agent).find(row=>row.name==='compact').description,'Harness compaction')
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

test('parallel native commands remain in an open canonical step across reasoning and commentary', async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-overlap-')),h=await host({closeSession:async()=>{}})
 const profiles=await new AgentProfiles(join(root,'agents.json')).open([{id:'fixture',name:'Fixture',type:'codex',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))]}])
 const adapter=new AgentRuntimeAdapter(h.ctx,profiles,{recordNative(){}});Object.assign(h.ctx.kodeAgents,{profiles,adapter,recordBinding(){}})
 try{
  const {agent}=await h.ctx.agents.create({...options,meta:{cwd:root}})
  agent.followup(message('overlap','OVERLAPPING_NATIVE'));await agent.whenIdle()
  const events=h.stored.get(agent.id).events,pending=new Map()
  for(const e of events){if(e.type==='tool/call')pending.set(e.data.callId,e.data.step);if(e.type==='tool/result'){assert.equal(e.data.step,pending.get(e.data.message.toolCallId));pending.delete(e.data.message.toolCallId)}if(e.type==='step/end')assert.equal(pending.size,0)}
  assert.equal(events.filter(e=>e.type==='tool/result').length,2);assert.equal(events.at(-1).data.reason.kind,'completed')
  if(process.env.KODE_TEST_DSH_NODE_MODULES){const {assertReleasedV4Relationships}=await import('@deepseek-ai/dsh-session-format-v3-to-v4');assert.doesNotThrow(()=>assertReleasedV4Relationships({header:h.stored.get(agent.id).header,events,inheritedEventCount:0},KNOWN_SESSION_EVENT_TYPES))}
 }finally{await h.fiber.dispose();await adapter.close();await rm(root,{recursive:true,force:true})}
})

test('native goals wake idle dsh turns without injecting or replaying user prompts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-native-goal-')),wire=join(root,'wire.jsonl')
 const h=await host({closeSession:async()=>{}})
 const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'fixture',name:'Fixture',type:'codex',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))],env:{KODE_FIXTURE_RPC_LOG:wire,KODE_FIXTURE_GOAL_AUTO:'1'}}])
 const adapter=new AgentRuntimeAdapter(h.ctx,profiles,{recordNative(){}})
 Object.assign(h.ctx.kodeAgents,{profiles,adapter,recordBinding(){}})
 try{
  const {agent}=await h.ctx.agents.create({...options,meta:{cwd:root}})
  agent.followup(message('goal-input','/goal Verify continuation'))
  for(let i=0;i<150;i++){
   if(h.stored.get(agent.id).events.filter(e=>e.type==='turn/end').length>=2)break
   await new Promise(r=>setTimeout(r,10))
  }
  await agent.whenIdle()
  const events=h.stored.get(agent.id).events
  assert.equal(events.filter(e=>e.type==='turn/end').length,2)
  assert.equal(events.filter(e=>e.type==='user/message').length,1)
  assert.ok(events.filter(e=>e.type==='turn/end').every(e=>e.data.reason.kind==='completed'))
  const answers=events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message.content).filter(b=>b.type==='text').map(b=>b.text).join('\n')
  assert.match(answers,/Native goal 1/);assert.match(answers,/Native goal 2/)
  const rows=(await readFile(wire,'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.filter(r=>r.method==='turn/start').length,0)
  assert.equal(rows.filter(r=>r.method==='thread/goal/set').length,1)
  if(process.env.KODE_TEST_DSH_NODE_MODULES){
   const {assertReleasedV4Relationships}=await import('@deepseek-ai/dsh-session-format-v3-to-v4')
   assert.doesNotThrow(()=>assertReleasedV4Relationships({header:h.stored.get(agent.id).header,inheritedEventCount:0,events},KNOWN_SESSION_EVENT_TYPES))
  }
 }finally{await h.fiber.dispose();await adapter.close();await rm(root,{recursive:true,force:true})}
})

test('goal pause reaches the live native thread while a turn is running',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-live-goal-control-'))
 const h=await host({closeSession:async()=>{}})
 const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'fixture',name:'Fixture',type:'codex',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))]}])
 const adapter=new AgentRuntimeAdapter(h.ctx,profiles,{recordNative(){}})
 Object.assign(h.ctx.kodeAgents,{profiles,adapter,recordBinding(){}})
 try{
  const {agent}=await h.ctx.agents.create({...options,meta:{cwd:root}})
  agent.followup(message('initial','WAIT'))
  for(let i=0;i<100&&!adapter.canSteer(agent.id);i++)await new Promise(r=>setTimeout(r,10))
  assert.ok(adapter.canSteer(agent.id))
  await adapter.controlGoal(agent,'Finish checks',AbortSignal.timeout(5000))
  assert.match(await adapter.controlGoal(agent,'pause',AbortSignal.timeout(5000)),/已暂停/)
  assert.equal(agent.status,'running');assert.equal(agent.inbox.nextTurn.length,0)
  assert.match(await adapter.controlGoal(agent,'',AbortSignal.timeout(5000)),/已暂停/)
  agent.steer(message('finish','Finish now'));await agent.whenIdle()
  assert.equal(h.stored.get(agent.id).events.filter(e=>e.type==='turn/start').length,1)
 }finally{await h.fiber.dispose();await adapter.close();await rm(root,{recursive:true,force:true})}
})


test('third-party provider sessions use the real official loop while Kode sessions remain native', async () => {
  const h = await host({ closeSession: async () => {} }, true)
  try {
    const route = { provider: 'deepseek-official', model: 'test-model' }
    // An old QQ session may still carry the formerly global kode-native preset.
    const qq = await h.ctx.agents.create({sessionId:'qq-isolated', agentOptions:route, meta:{agentPreset:'kode-native'}})
    assert.equal(qq.agent.options.provider, route.provider)
    assert.equal(qq.agent.assertSteeringAvailable, undefined)
    assert.equal(typeof qq.agent.followup, 'function')
    const native = await h.ctx.agents.create({...options, sessionId:'kode-isolated'})
    assert.equal(typeof native.agent.assertSteeringAvailable, 'function')
    assert.equal(h.ctx.agents.get('qq-isolated'), qq.agent)
    await native.dispose(); await qq.dispose()
    const resumed = await h.ctx.agents.resume({resumeSessionId:'qq-isolated', agentOptions:route})
    assert.equal(resumed.agent.assertSteeringAvailable, undefined)
    await resumed.dispose()
  } finally { await h.ctx.fiber.dispose() }
})


test('explicit Kode selection promotes only its blank official session without changing other sessions', async () => {
  const h = await host({ closeSession: async () => {} }, true)
  try {
    const official = await h.ctx.agents.create({sessionId:'blank-ui',agentOptions:{provider:'deepseek-official',model:'test'}})
    const thirdParty = await h.ctx.agents.create({sessionId:'third-party',agentOptions:{provider:'deepseek-official',model:'test'}})
    const selection={provider:'kode-agent-fixture',model:'fixture'}
    const promoted=await h.ctx.kodeNativeFactory.promote(official.agent,selection)
    assert.equal(promoted.id,official.agent.id)
    assert.equal(typeof promoted.selectModel,'function')
    assert.equal(h.ctx.agents.get(promoted.id),promoted)
    assert.equal(h.ctx.agents.get(thirdParty.agent.id),thirdParty.agent)
    await thirdParty.dispose()
  } finally { await h.ctx.fiber.dispose() }
})

test('unloading Kode restores the official factory without disposing third-party sessions', async () => {
  const h = await host({ closeSession: async () => {} }, true)
  try {
    const options = {agentOptions:{provider:'deepseek-official',model:'test'}}
    const qq = await h.ctx.agents.create({...options,sessionId:'qq-before-unload'})
    await h.fiber.dispose()
    assert.equal(h.ctx.agents.get(qq.agent.id),qq.agent)
    const next = await h.ctx.agents.create({...options,sessionId:'qq-after-unload'})
    assert.equal(next.agent.assertSteeringAvailable,undefined)
    await next.dispose(); await qq.dispose()
  } finally { await h.ctx.fiber.dispose() }
})

test('cold native restore uses durable model ownership instead of caller defaults', async () => {
  const routes = []
  const h = await host({ async *stream(request) { routes.push(request.provider); yield { type: 'finish', reason: { kind: 'stop' } } }, closeSession: async () => {} }, true)
  try {
    const first = await h.ctx.agents.create({ ...options, sessionId: 'cold-native-owner' })
    first.agent.followup(message('before-restart', 'First turn')); await first.agent.whenIdle(); await first.dispose()
    const resumed = await h.ctx.agents.resume({ resumeSessionId: 'cold-native-owner', agentOptions: { provider: 'deepseek-official', model: 'fallback', reasoningEffort: 'high' } })
    assert.equal(resumed.agent.isKodeNativeAgent, true)
    assert.equal(resumed.agent.options.reasoningEffort, undefined, 'caller defaults cannot add effort to a saved native model')
    resumed.agent.followup(message('after-restart', 'Continue the same conversation')); await resumed.agent.whenIdle()
    assert.equal(h.stored.get(resumed.agent.id).events.at(-1).data.reason.kind, 'completed', JSON.stringify(h.stored.get(resumed.agent.id).events.at(-1)))
    assert.deepEqual(routes, [options.agentOptions.provider, options.agentOptions.provider])
    assert.equal(h.stored.get(resumed.agent.id).events.at(-1).data.reason.kind, 'completed')
    await resumed.dispose()
  } finally { await h.ctx.fiber.dispose() }
})

test('cold third-party restore is not captured by a Kode caller default', async () => {
  const h = await host({ closeSession: async () => {} }, true)
  try {
    const route = { provider: 'deepseek-official', model: 'test-model' }
    const first = await h.ctx.agents.create({ sessionId: 'cold-official-owner', agentOptions: route })
    first.agent.session.append('model/selection', route)
    await first.dispose()
    const resumed = await h.ctx.agents.resume({ resumeSessionId: 'cold-official-owner', agentOptions: options.agentOptions })
    assert.notEqual(resumed.agent.isKodeNativeAgent, true)
    assert.equal(resumed.agent.assertSteeringAvailable, undefined)
    await resumed.dispose()
  } finally { await h.ctx.fiber.dispose() }
})


test('unloading and reloading Kode never falls through to an official loop for native history', async () => {
  const h = await host({ async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } }, closeSession: async () => {} }, true)
  try {
    const first = await h.ctx.agents.create({ ...options, sessionId: 'native-reload-barrier' })
    first.agent.followup(message('first', 'Native turn')); await first.agent.whenIdle(); await first.dispose()
    const eventCount = h.stored.get(first.agent.id).events.length
    await h.fiber.dispose()
    await assert.rejects(h.ctx.agents.resume({ resumeSessionId: first.agent.id, agentOptions: { provider: 'deepseek-official', model: 'fallback' } }), /保护历史/)
    await assert.rejects(h.ctx.agents.create({ ...options, sessionId: 'native-during-reload' }), /保护历史/)
    assert.equal(h.stored.get(first.agent.id).events.length, eventCount)
    const other = await h.ctx.agents.create({ sessionId: 'official-during-reload', agentOptions: { provider: 'deepseek-official', model: 'fixture' } })
    other.agent.session.append('model/selection', { provider: 'deepseek-official', model: 'fixture' }); await other.dispose()
    const restoredOther = await h.ctx.agents.resume({ resumeSessionId: 'official-during-reload', agentOptions: options.agentOptions }); await restoredOther.dispose()
    const reloaded = await load(h.ctx,factoryPlugin)
    const resumed = await h.ctx.agents.resume({ resumeSessionId: first.agent.id, agentOptions: { provider: 'deepseek-official', model: 'fallback' } })
    assert.equal(resumed.agent.isKodeNativeAgent, true)
    resumed.agent.followup(message('next', 'Continue')); await resumed.agent.whenIdle()
    assert.equal(h.stored.get(first.agent.id).events.some(event => event.type === 'system/message'), false)
    await resumed.dispose(); await reloaded.dispose()
  } finally { await h.ctx.fiber.dispose() }
})


test('configured resumeWith routes native history to the native driver', async () => {
  const h = await host({ closeSession: async () => {} }, true, true)
  const adapter = new AgentRuntimeAdapter(h.ctx, { list: () => [{ id: 'fixture', name: 'Fixture', type: 'codex' }], bindings: {} })
  const unregister = h.ctx.llm.registerAdapter(['kode-agent-fixture'], adapter)
  let streams = 0
  adapter.stream = async function* () { streams++; yield { type: 'finish', reason: { kind: 'stop' } } }
  h.ctx.kodeAgents.adapter = adapter
  try {
    const first = await h.ctx.agents.create({ ...options, sessionId: 'direct-official-restore' })
    first.agent.session.append('user/message', message('historical', 'Native history'), { surfaceOp: 'append' })
    await first.dispose()
    // Configured AgentLoop restores can enter resumeWith directly, bypassing
    // createAgent/resume wrappers. Exercise the released loop's actual path.
    const restored = await h.ctx.agentLoop.resumeWith(h.ctx, h.ctx.sessionPersistence, { resumeSessionId: first.agent.id, agentOptions: options.agentOptions })
    assert.equal(restored.agent.isKodeNativeAgent, true)
    restored.agent.followup(message('followup', 'Continue'))
    await restored.agent.whenIdle()
    const events = h.stored.get(first.agent.id).events
    assert.equal(events.some(event => event.type === 'system/message'), false)
    assert.equal(streams, 1)
    assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    const { assertReleasedV4Relationships } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
    assert.doesNotThrow(() => assertReleasedV4Relationships({ header: h.stored.get(first.agent.id).header, events, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES))
    await restored.dispose()
  } finally { unregister(); await adapter.close(); await h.ctx.fiber.dispose() }
})

test('configured resumeWith retains its native barrier across plugin reloads', async () => {
  const h = await host({ async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } }, closeSession: async () => {} }, true)
  try {
    const first = await h.ctx.agents.create({ ...options, sessionId: 'configured-reload' })
    first.agent.followup(message('first', 'Native turn')); await first.agent.whenIdle(); await first.dispose()
    const count = h.stored.get(first.agent.id).events.length
    const restore = { resumeSessionId: first.agent.id, agentOptions: { provider: 'deepseek-official', model: 'fallback' } }
    await h.fiber.dispose()
    await assert.rejects(h.ctx.agentLoop.resumeWith(h.ctx, h.ctx.sessionPersistence, restore), /保护历史/)
    assert.equal(h.stored.get(first.agent.id).events.length, count)
    const other = await h.ctx.agents.create({ sessionId: 'configured-official', agentOptions: restore.agentOptions })
    other.agent.session.append('model/selection', restore.agentOptions); await other.dispose()
    const official = await h.ctx.agentLoop.resumeWith(h.ctx, h.ctx.sessionPersistence, { resumeSessionId: other.agent.id, agentOptions: options.agentOptions })
    assert.notEqual(official.agent.isKodeNativeAgent, true)
    await official.dispose()
    const reloaded = await load(h.ctx,factoryPlugin)
    const resumed = await h.ctx.agentLoop.resumeWith(h.ctx, h.ctx.sessionPersistence, restore)
    assert.equal(resumed.agent.isKodeNativeAgent, true)
    resumed.agent.followup(message('next', 'Continue')); await resumed.agent.whenIdle()
    assert.equal(h.stored.get(first.agent.id).events.at(-1).data.reason.kind, 'completed')
    await resumed.dispose(); await reloaded.dispose()
  } finally { await h.ctx.fiber.dispose() }
})

test('bypassing native routing still rejects ordinary system prompt admission', async () => {
  const h = await host({ closeSession: async () => {} }, true, true)
  const adapter = new AgentRuntimeAdapter(h.ctx, { list: () => [{ id: 'fixture', name: 'Fixture', type: 'codex' }], bindings: {} })
  const unregister = h.ctx.llm.registerAdapter(['kode-agent-fixture'], adapter)
  adapter.stream = async function* () { throw new Error('Ordinary loop must not reach native stream') }
  try {
    const first = await h.ctx.agents.create({ ...options, sessionId: 'unrouted-restore' })
    first.agent.session.append('user/message', message('historical', 'Native history'), { surfaceOp: 'append' })
    await first.dispose()
    const loop = h.ctx.agents.requireFactory().target
    const original = loop[Symbol.for('kode.native-factory.upstream')].resumeWith
    const restored = await original.call(loop, h.ctx, h.ctx.sessionPersistence, { resumeSessionId: first.agent.id, agentOptions: options.agentOptions })
    restored.agent.followup(message('next', 'Continue')); await restored.agent.whenIdle()
    const events = h.stored.get(first.agent.id).events
    assert.equal(events.some(event => event.type === 'system/message'), false)
    assert.match(events.at(-1).data.reason.error.message, /写入系统提示前停止/)
    await restored.dispose()
  } finally { unregister(); await adapter.close(); await h.ctx.fiber.dispose() }
})


test('history edits publish a balanced native branch before sending and retain the original session', async () => {
  const { HistoryEditor, branchHistoryInput } = await import('../src/history-edit.js')
  const { assertReleasedV4Relationships } = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  const root = await mkdtemp(join(tmpdir(), 'kode-edit-native-')), requests = []
  const h = await host({
    async *stream(options) {
      const agent = h.ctx.agents.get(options.sessionId)
      requests.push({ messages: options.messages, history: await branchHistoryInput(agent.session, { historyBranch: true }, undefined, false) })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Branch answer' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Branch answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }, closeSession: async () => {},
  })
  try {
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex' }])
    Object.assign(h.ctx.kodeAgents, { profiles, recordBinding() {}, hasRuntime: () => true })
    h.ctx.sessionPersistence.stat = async id => h.stored.has(id) ? {} : undefined
    h.ctx.provide('sessionQuery', { observeSession: async id => { const row = h.stored.get(id); return { header: row.header, events: [...row.events], [Symbol.dispose]() {} } } })
    h.ctx.provide('sessionController', { rename: async () => {}, resolveAgent: async id => ({ agent: h.ctx.agents.get(id) }) })
    const seed = buildHistorySeed({ timeline: [
      { kind: 'text', role: 'user', text: 'Prior question' }, { kind: 'text', role: 'agent', text: 'Prior answer' },
      { kind: 'text', role: 'user', text: 'Replace me' }, { kind: 'text', role: 'agent', text: 'Future answer' },
    ] }, options.agentOptions)
    const { agent: source } = await h.ctx.agents.create({ ...options, seed })
    await profiles.bind(source.id, 'fixture'); await profiles.patchBinding(source.id, { threadId: 'source-native-thread' })
    const before = JSON.stringify(h.stored.get(source.id).events)
    const seq = seed.find(event => event.type === 'user/message' && event.data.content[0].text === 'Replace me').seq
    const result = await new HistoryEditor(h.ctx, h.ctx.kodeAgents).edit({ sessionId: source.id, seq, text: 'Replacement', requestId: 'native-edit-request' })
    const child = h.ctx.agents.get(result.sessionId); await child.whenIdle()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].messages[0].content[0].text, 'Replacement')
    assert.match(JSON.stringify(requests[0].history), /Prior answer/)
    assert.ok(!JSON.stringify(requests[0].history).includes('Future answer'))
    assert.equal(JSON.stringify(h.stored.get(source.id).events), before)
    assert.equal(profiles.binding(child.id).threadId, undefined)
    const stored = h.stored.get(child.id)
    assert.doesNotThrow(() => assertReleasedV4Relationships({ header: stored.header, events: stored.events, inheritedEventCount: seq }, KNOWN_SESSION_EVENT_TYPES))
    assert.equal(child.status, 'idle')
  } finally { await h.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

for (const mode of ['cold', 'loaded', 'crash-loaded']) test(`restart recovery continues ${mode} native history exactly once`, async () => {
  const { RestartResume } = await import('../src/restart-resume.js')
  const root = await mkdtemp(join(tmpdir(), 'kode-restart-native-'))
  let started, runs = 0
  const ready = new Promise(resolve => { started = resolve })
  const h = await host({ async *stream({ signal }) {
    if (++runs === 1) { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted() }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Continued after restart' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Continued after restart' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }, closeSession: async () => {} })
  const backend = { call: async () => ({ auto_resume_interrupted: true }) }
  const file = join(root, 'restart.json'), initial = new RestartResume(h.ctx, backend, file)
  await initial.load()
  const subscription = h.ctx.on('agent/status', ({ agent }) => initial.status(agent))
  try {
    const first = await h.ctx.agents.create(options)
    first.agent.followup(message('restart-task', 'Finish this task')); await ready
    await first.dispose(); await initial.saving
    assert.equal(initial.records[options.sessionId], true)
    subscription()
    if (mode === 'crash-loaded') h.stored.get(options.sessionId).events.pop()
    h.ctx.provide('sessionController', {
      inspect: async id => ({ events: h.stored.get(id).events }),
      resolveAgent: id => h.ctx.agents.resume({ resumeSessionId: id, agentOptions: options.agentOptions }),
    })
    if (mode !== 'cold') await h.ctx.agents.resume({ resumeSessionId: options.sessionId, agentOptions: options.agentOptions })
    const recovery = new RestartResume(h.ctx, backend, file); await recovery.load()
    await recovery.recover(new AbortController().signal)
    const agent = h.ctx.agents.get(options.sessionId); await agent.whenIdle()
    assert.equal(runs, 2); assert.equal(agent.options.model, options.agentOptions.model)
    const events = h.stored.get(agent.id).events
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.id === 'restart-task').length, 1)
    assert.equal(events.filter(event => event.type === 'turn/start').length, 2)
    assert.equal(events.at(-1).data.reason.kind, 'completed')
    await recovery.recover(new AbortController().signal); assert.equal(runs, 2)
  } finally { subscription(); await h.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})


test('early startup barrier rolls back an ordinary native restore before input or prompt admission', async () => {
  const h = await host({ closeSession: async () => {} }, true)
  installNativeStartupBarrier(h.ctx)
  try {
    const first = await h.ctx.agents.create({ ...options, sessionId: 'early-startup' })
    first.agent.session.append('user/message', message('history', 'Retain my native task'), { surfaceOp: 'append' })
    await first.dispose()
    const count = h.stored.get(first.agent.id).events.length
    const loop = h.ctx.agents.requireFactory().target
    const original = loop[Symbol.for('kode.native-factory.upstream')].resumeWith
    await assert.rejects(original.call(loop, h.ctx, h.ctx.sessionPersistence, { resumeSessionId: first.agent.id, agentOptions: options.agentOptions }), /阻止普通 dsh/)
    assert.equal(h.ctx.agents.get(first.agent.id), undefined)
    assert.equal(h.writers.has(first.agent.id), false)
    // Released loops may seal an imported seed while opening the log.
    assert.ok(h.stored.get(first.agent.id).events.slice(count).every(event => event.type === 'session/end-seed'))
    assert.equal(h.stored.get(first.agent.id).events.filter(event => event.type === 'user/message').length, 1)
    const restored = await h.ctx.agents.resume({ resumeSessionId: first.agent.id, agentOptions: options.agentOptions })
    assert.equal(restored.agent.isKodeNativeAgent, true)
    await restored.dispose()
  } finally { await h.ctx.fiber.dispose() }
})

test('native admission waits for delayed factory initialization without creating an ordinary driver', async () => {
  const h = await host({ closeSession: async () => {} }, true)
  installNativeStartupBarrier(h.ctx)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  try {
    const first = await h.ctx.agents.create({ ...options, sessionId: 'delayed-startup' })
    await first.dispose(); await h.fiber.dispose()
    h.ctx.agentPresets.register = async () => { entered.resolve(); await release.promise; return () => {} }
    const loading = load(h.ctx, factoryPlugin)
    await entered.promise
    let admitted = false
    const restoring = h.ctx.agents.resume({ resumeSessionId: first.agent.id, agentOptions: options.agentOptions }).then(result => { admitted = true; return result })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(admitted, false)
    assert.equal(h.ctx.agents.get(first.agent.id), undefined)
    assert.equal(h.writers.has(first.agent.id), false)
    release.resolve(); await loading
    const restored = await restoring
    assert.equal(restored.agent.isKodeNativeAgent, true)
    await restored.dispose()
  } finally { release.resolve(); await h.ctx.fiber.dispose() }
})

test('native completion reaches the root notification carrier only after its durable turn settles', async () => {
  const { registerSessionNotifications } = await import('../src/session-notifications.js')
  const { EventEmitter } = await import('node:events')
  const h = await host({ async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } }, closeSession: async () => {} }, true)
  let route
  h.ctx.provide('webServer', { register(value) { route = value; return () => {} } })
  h.ctx.provide('connection', { admit: () => ({ peer: { principal: { kind: 'owner' } } }) })
  const dispose = registerSessionNotifications(h.ctx)
  const chunks = [], res = new EventEmitter()
  res.writeHead = () => {}; res.write = value => { chunks.push(value); return true }; res.end = () => res.emit('close')
  route.handler({ method: 'GET', headers: {} }, res)
  try {
    const { agent } = await h.ctx.agents.create({ ...options, sessionId: 'native-completion-notification' })
    agent.followup(message('work', 'Complete a fixture task')); await agent.whenIdle()
    const notices = chunks.flatMap(chunk => chunk.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))))
    assert.equal(notices.length, 1)
    assert.equal(notices[0].kind, 'completed')
    assert.equal(notices[0].sessionId, agent.id)
    assert.equal(h.stored.get(agent.id).events.at(-1).data.reason.kind, 'completed')
  } finally { dispose(); await h.ctx.fiber.dispose() }
})
