import { previewVerification, confirmVerification } from '../src/verification-review.js'
import { execFile, fork } from 'node:child_process'
import { CoordinatorCloseRecovery } from '../src/coordinator-close-recovery.js'
import { promisify } from 'node:util'
import { OFFICIAL_COORDINATOR_TOOLS, OPTIONAL_COORDINATOR_TOOLS } from '../src/official-coordinator-tools.js'
import { COORDINATOR_PROMPT_VERSION } from '../src/coordinator-context.js'
import { browserBuilderWorkflow } from './support/browser-builder-workflow.js'
import { inspectBuilderStartup, browserInterviewAnswers } from './support/collab-builder-start-browser.js'
import { confirmBuilderStart } from '../packages/collab/builder-start-command.js'
/** Actual scoped tool registration and home-Hub resource reads, without model inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { pluginRecordOf } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createRequire } from 'node:module'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(loopRequire.resolve('@deepseek-ai/dsh-system-prompt'))
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { realpath, writeFile, mkdir, readdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { mountOfficialBuilderTools, OFFICIAL_BUILDER_TOOLS } from '../src/official-builder-tools.js'
import { acquireOperationLease } from '../src/operation-lease.js'
import { registerBuilderStart } from '../src/builder-start-route.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { apply as applyHost } from '../src/host.js'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { deliveryInputId } from '../src/delivery-tracker.js'
import { registerBuilderInput } from '../src/builder-input-route.js'
import { registerBuilderConversation } from '../src/builder-conversation.js'
import { observeOfficialBuilderDraft } from '../src/builder-observe-tool.js'
import { registerBuilderAccept } from '../src/builder-accept-route.js'
import { registerBuilderContinue } from '../src/builder-continue-route.js'
import { setupSavedBuilderWorkflow } from '../src/builder-workflow-setup.js'
import { BUILDER_PROMPT_VERSION } from '../src/builder-prompt.js'
import { nativeDecisionProvider } from './support/native-decision-provider.js'
const inspectionPaths = ['README.md', '.github/workflows', '.agents/skills', 'skills']
const liveBuilder = process.env.KODE_TEST_LIVE_BUILDER === '1'
const liveInterview = liveBuilder && process.env.KODE_TEST_LIVE_BUILDER_INTERVIEW === '1'
const nativeBuilder = process.env.KODE_TEST_NATIVE_BUILDER === '1' || liveBuilder
const builderProvider = nativeBuilder ? 'kode-workflow-builder' : 'fixture'
const builderModel = liveBuilder ? process.env.KODE_TEST_NATIVE_MODEL : 'model'
const builderEffort = liveBuilder ? 'low' : null
const validityMs = liveBuilder ? 1200000 : 60000

for(const mode of liveBuilder?['prepared']:['prepared','atomic']) test(`Builder official loop uses fixed draft tools, creation budget and durable tool accounting (${mode})`, {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:liveBuilder?900000:60000},async t=>{
  const hub=await isolatedHub('official-builder'),ctx=new Context()
  let execution,host,webServer,inputHttp,conversationHttp,continueHttp,acceptHttp,nativePeer
  try{
    await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false})
    await ctx.plugin(Tools);await ctx.plugin(LlmRuntime)
    const workerSteps = new Map(), workerSessions = new Set()
    let coordinatorCalls = 0, browserRunId, successorHuman, finalizedCoordinator, resolveCoordinatorInput
    const coordinatorInput = new Promise(resolve => { resolveCoordinatorInput = resolve })
    let commandReference,calls=0,browserCalls=0,browserDraft,browserWorkflow,browserTeam,proposal,workflowProposal;const draftRevision=mode==='atomic'?2:1;const errors=[]
    ctx.on('agent/error',event=>errors.push(event.error.message))
    class Fixture extends LlmAdapter{
      async *stream(options){
        const system=JSON.stringify(options.messages.filter(message=>message.role==='system'))
    if(options.tools.some(t=>t.name==='kode_publish_output')){
     assert.ok(!options.tools.some(t=>t.name.startsWith('kode_sessions_')),'Worker cannot inherit general messaging tools')
     assert.ok(!JSON.stringify(options.messages.filter(m=>m.role==='system')).includes(COORDINATOR_PROMPT_VERSION),'Coordinator procedure cannot leak to Workers')
     workerSessions.add(options.sessionId)
     const step=workerSteps.get(options.sessionId)??0;workerSteps.set(options.sessionId,step+1)
     const names=options.tools.map(t=>t.name)
     const output=names.includes('kode_write_source')?'artifact':names.includes('kode_review_output')?'reviewed':'checked'
     const result=id=>{const message=options.messages.find(m=>m.role==='tool'&&m.source?.callId===id);assert.ok(message);return JSON.parse(message.content.filter(b=>b.type==='text').map(b=>b.text).join(''))}
     let tool,args
     if(output==='artifact'&&step===0){tool='kode_write_source';args={path:'implemented.txt',expected_sha256:null,content:'implemented'}}
     else if(output==='reviewed'&&step===0){tool='kode_read_source';args={path:'implemented.txt'}}
     else if(output==='checked'&&step===0){tool='kode_verify_output';args={output,request_id:'verify'}}
     else if(output==='artifact'&&step===1){tool='kode_capture_output';args={output,request_id:'capture'}}
     else if(output==='reviewed'&&step===1){assert.equal(result('worker-0').text,'implemented');tool='kode_review_output';args={output,request_id:'review',verdict:'passed',findings:[]}}
     else if(step===(output==='checked'?1:2)){const evidence=result(`worker-${step-1}`);assert.ok(evidence.evidence_id);tool='kode_publish_output';args={output,evidence_id:evidence.evidence_id}}
     if(tool){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:`worker-${step}`,name:tool,arguments:JSON.stringify(args)}}}
     else {yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'Stage evidence published'}}}
     yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
     yield {type:'finish',reason:{kind:tool?'tool-calls':'stop'}}
     return
    }
        if (system.includes(COORDINATOR_PROMPT_VERSION)) {
          const human = await coordinatorInput
          assert.deepEqual(options.tools.map(tool => tool.name).sort(), [...OFFICIAL_COORDINATOR_TOOLS, ...OPTIONAL_COORDINATOR_TOOLS].sort())
          assert.ok(!system.includes(BUILDER_PROMPT_VERSION))
          coordinatorCalls++
          if (coordinatorCalls >= 7) {
            assert.ok(successorHuman)
            assert.match(JSON.stringify(options.messages), /Next requirement after this work/)
            assert.match(JSON.stringify(options.messages), /实现、独立评审与验证已完成/)
            if (coordinatorCalls === 7) {
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'successor-reply', name: 'kode_coordinator_publish_reply', arguments: JSON.stringify({ request_id: 'successor-reply', source_message_id: successorHuman.id, content: '已接手关闭期间收到的新需求，并保留前次交付记录。' }) } }
            } else {
              assert.equal(coordinatorCalls, 8)
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Successor reply published.' } }
            }
            yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
            yield { type: 'finish', reason: { kind: coordinatorCalls === 7 ? 'tool-calls' : 'stop' } }
            return
          }
          if (coordinatorCalls >= 4) {
            assert.match(JSON.stringify(options.messages), /Hub workflow event/)
            if (coordinatorCalls === 4 || coordinatorCalls === 5) {
              let name = 'kode_coordinator_workflow_status', args = { run_id: browserRunId }
              if (coordinatorCalls === 5) {
                const message = options.messages.find(message => message.role === 'tool' && message.source?.callId === 'browser-final-status')
                assert.ok(message)
                const status = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
                assert.equal(status.completion_authorized, true)
                assert.equal(status.state, 'completed')
                assert.deepEqual(status.stages.map(stage => stage.state), ['passed', 'passed', 'passed'])
                name = 'kode_coordinator_publish_reply'
                args = { request_id: 'browser-final-result', source_message_id: human.id, content: '实现、独立评审与验证已完成，产物和验证证据已留档。' }
              }
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: coordinatorCalls === 4 ? 'browser-final-status' : 'browser-final-publish', name, arguments: JSON.stringify(args) } }
            } else {
              assert.equal(coordinatorCalls, 6)
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Verified result published.' } }
            }
            yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
            yield { type: 'finish', reason: { kind: coordinatorCalls < 6 ? 'tool-calls' : 'stop' } }
            return
          }
          if (coordinatorCalls <= 2) {
            const name = coordinatorCalls === 1 ? 'kode_coordinator_workflow_start' : 'kode_coordinator_publish_reply'
            const args = coordinatorCalls === 1
              ? { request_id: 'browser-work-run', source_message_id: human.id, binding_id: 'local', inputs: { request: human.content } }
              : { request_id: 'browser-coordinator-reply', source_message_id: human.id, content: '需求已进入实现、独立评审与验证流程，尚未完成。' }
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'browser-coordinator-tool-' + coordinatorCalls, name, arguments: JSON.stringify(args) } }
          } else {
            assert.equal(coordinatorCalls, 3)
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Workflow registered.' } }
          }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: coordinatorCalls <= 2 ? 'tool-calls' : 'stop' } }
          return
        }
        assert.ok(system.includes(BUILDER_PROMPT_VERSION),'Builder procedure must reach the actual model system context')
        assert.match(system,/at most three/)
        assert.deepEqual(options.tools.map(t=>t.name).sort(),[...OFFICIAL_BUILDER_TOOLS].sort());calls++
        if (JSON.stringify(options.messages).includes('Browser conversation check')) {
          browserCalls++
          if (browserCalls === 1) {
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'browser-draft-read', name: OFFICIAL_BUILDER_TOOLS[0], arguments: '{}' } }
          } else if (browserCalls === 2) {
            const transcript = JSON.stringify(options.messages)
            for (const answer of Object.values(browserInterviewAnswers)) assert.ok(transcript.includes(answer))
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'browser-workflow-save', name: OFFICIAL_BUILDER_TOOLS[4], arguments: JSON.stringify({ expected_revision: browserDraft.revision, request_id: 'browser-generated-workflow', questions: [], proposed_team: null, proposed_workflow: browserWorkflow }) } }
          } else if (browserCalls === 4) {
            assert.ok(JSON.stringify(options.messages).includes('Use the registered workflow to propose my team'))
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'browser-team-save', name: OFFICIAL_BUILDER_TOOLS[4], arguments: JSON.stringify({ expected_revision: browserDraft.revision, request_id: 'browser-generated-team', questions: [], proposed_team: browserTeam, proposed_workflow: browserWorkflow }) } }
          } else {
            assert.ok([3, 5].includes(browserCalls))
            const transcript = JSON.stringify(options.messages)
            for (const answer of Object.values(browserInterviewAnswers)) assert.ok(transcript.includes(answer), 'persisted human answers must reach the real Builder loop')
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Browser reply received' } }
          }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
          yield { type: 'finish', reason: { kind: browserCalls < 3 || browserCalls === 4 ? 'tool-calls' : 'stop' } }
          return
        }
        if(calls===3)assert.match(JSON.stringify(options.messages),/runtime_readiness/)
        if(calls<6){
          const name=OFFICIAL_BUILDER_TOOLS[calls-1]
          const args=[{}, {expected_revision:draftRevision}, {expected_revision:draftRevision,request_id:'capture:1',workspace_id:'fixture',paths:inspectionPaths}, {expected_revision:draftRevision+1,request_id:'questions:1'}, {expected_revision:draftRevision+1,request_id:'save:1',questions:[{id:'budget',prompt:'What is the team budget?'}],proposed_team:proposal,proposed_workflow:workflowProposal}][calls-1]
          yield {type:'block-start',index:0,blockType:'tool-call'}
          yield {type:'block-end',index:0,block:{type:'tool-call',id:`builder-${calls}`,name,arguments:JSON.stringify(args)}}
        }else if(calls===7){
          yield {type:'block-start',index:0,blockType:'tool-call'}
          yield {type:'block-end',index:0,block:{type:'tool-call',id:'builder-7',name:OFFICIAL_BUILDER_TOOLS[0],arguments:'{}'}}
        }else if(calls===8){
          yield {type:'block-start',index:0,blockType:'tool-call'}
          yield {type:'block-end',index:0,block:{type:'tool-call',id:'builder-8',name:OFFICIAL_BUILDER_TOOLS[5],arguments:JSON.stringify({expected_revision:draftRevision+3,kind:'workflow',after_id:'',after_version:'',limit:3})}}
          yield {type:'block-start',index:1,blockType:'tool-call'}
          yield {type:'block-end',index:1,block:{type:'tool-call',id:'builder-command-reference',name:OFFICIAL_BUILDER_TOOLS[5],arguments:JSON.stringify({expected_revision:draftRevision+3,kind:'verification_command',after_id:'owner-local',after_version:'smoke',command_revision:'1',limit:1})}}
        }else if(calls===9){
          const observed=options.messages.find(m=>m.role==='tool'&&m.source?.callId==='builder-command-reference')
          assert.ok(observed,'actual Builder model receives registered command reference')
          const metadata=JSON.parse(observed.content.filter(b=>b.type==='text').map(b=>b.text).join(''))
          assert.deepEqual(metadata.items[0].reference,commandReference)
          assert.equal(metadata.items[0].execution_performed,false)
          assert.equal(metadata.items[0].registration_performed,false)
          assert.doesNotMatch(JSON.stringify(metadata),/executable|--version/)

          yield {type:'block-start',index:0,blockType:'tool-call'}
          yield {type:'block-end',index:0,block:{type:'tool-call',id:'builder-9',name:OFFICIAL_BUILDER_TOOLS[6],arguments:JSON.stringify({expected_revision:draftRevision+3,policy_id:'candidate-budget',policy_revision:1,target_id:''})}}
        }else if(calls===10){
          yield {type:'block-start',index:0,blockType:'tool-call'}
          yield {type:'block-end',index:0,block:{type:'tool-call',id:'builder-10',name:OFFICIAL_BUILDER_TOOLS[4],arguments:JSON.stringify({expected_revision:draftRevision+3,request_id:'save:2',questions:[],proposed_team:proposal,proposed_workflow:workflowProposal})}}
        }else{
          if(calls===11){assert.match(JSON.stringify(options.messages),/50 credits/);assert.match(JSON.stringify(options.messages),/catalog-flow/);assert.match(JSON.stringify(options.messages),/团队预算/)}
          assert.match(JSON.stringify(options.messages),/Selected fixture project/)
          assert.match(JSON.stringify(options.messages),/task_kind/)
          yield {type:'block-start',index:0,blockType:'text'}
          yield {type:'block-end',index:0,block:{type:'text',text:calls===11?'Confirmed budget received; configuration still requires human activation.':'Draft requires configuration and human activation.'}}
        }
        yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
        yield {type:'finish',reason:{kind:calls<6||(calls>=7&&calls<=10)?'tool-calls':'stop'}}
      }
    }
    ctx.llm.registerAdapter(['fixture'],new Fixture())
    const root=await realpath(hub.root),call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b)
    if(mode==='atomic')await ctx.plugin(persistence,{root:join(root,'sessions'),compression:'zstd'})
    await writeFile(join(root,'README.md'),'# Selected fixture project\n')
    await mkdir(join(root,'.github/workflows'),{recursive:true})
    await mkdir(join(root,'.agents/skills/check'),{recursive:true})
    await mkdir(join(root,'skills/plan'),{recursive:true})
    await writeFile(join(root,'.github/workflows/check.yml'),'name: Selected fixture CI\n')
    await writeFile(join(root,'.agents/skills/check/SKILL.md'),'# Selected fixture skill\n')
    await writeFile(join(root,'skills/plan/SKILL.md'),'# Selected project plugin skill\n')
    if(nativeBuilder&&!liveBuilder){
      assert.ok(process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE)
      nativePeer=await nativeDecisionProvider(async ({messages,tools,model,instructions})=>{
        assert.ok(!tools.some(tool=>tool.name==='request_user_input'))
        let call,text
        const input={messages:[{role:'system',content:[{type:'text',text:instructions}]},...messages],tools,model,sessionId:'builder'}
        for await(const event of new Fixture().stream(input))if(event.type==='block-end'){
          if(event.block.type==='tool-call')call=event.block
          if(event.block.type==='text')text=event.block.text
        }
        return call?{call}:{text}
      })
    }
    if(liveBuilder){
      assert.equal(process.env.KODE_TEST_LIVE_FREE_WRAPPER,'1')
      for(const key of ['KODE_TEST_NATIVE_MODEL','KODE_TEST_MANAGED_CODEX_EXECUTABLE','KODE_TEST_MANAGED_CODEX_WRAPPER','KODE_TEST_WRAPPER_PROVIDER','KODE_TEST_WRAPPER_HOME'])assert.ok(process.env[key],`Explicit ${key} required`)
    }
    const inference=liveBuilder?{roles:['builder'],reasoningEfforts:['low'],bootstrap:{
      executable:process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,pathVariable:'TCODEX_CODEX_PATH',
      provider:process.env.KODE_TEST_WRAPPER_PROVIDER,home:process.env.KODE_TEST_WRAPPER_HOME,
    }}:nativeBuilder?{endpoint:nativePeer.endpoint,roles:['builder']}:null
    const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'builder',name:'Builder',
      ...(nativeBuilder?{type:'codex',executable:process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,
        ...(liveBuilder?{executable:process.env.KODE_TEST_MANAGED_CODEX_WRAPPER,defaultModel:builderModel,defaultReasoningEffort:builderEffort,
          env:{TCODEX_SKIP_UPDATE:'1',TCODEX_DISABLE_TELEMETRY:'1'}}:{}),managedInference:inference}:{type:'dsh'})}])
    const registered=mode==='prepared'?await call('sessions',{session_id:'builder',title:'Builder',runtime:'external'}):null
    const client=registered?hub.client.forSession(registered.owner_token):null
    await profiles.bind('builder','builder')
    ctx.provide('workspaceRegistry',{list:()=>[{id:'fixture',path:root},{id:'selected-other',path:join(root,'other')}]})
    ctx.provide('kodeOfficialToolPolicies',new OfficialToolPolicies())
    if(mode==='prepared')ctx.provide('kodeOperationLeases',{acquire:(agent,binding,signal,admission)=>acquireOperationLease(client,binding,{node_id:hub.node,session_id:agent.id,grant_enforcement:true,profile_id:'builder'},{signal,leaseMs:10000,beforeClaim:admission.beforeClaim})})
    let lostCoordinatorAccounting = false, allowCoordinatorAccounting = false
    let lostSave=false,saveWrites=0,lostScope=false,lostStart=false,lostObservation=false,observationWrites=0
    const transport={call:async(path,body,...rest)=>{
      if (path.endsWith('/coordinator-accounting') && body && !allowCoordinatorAccounting) {
        const operation = await hub.client.call(path.replace('/coordinator-accounting', ''))
        if (operation.state === 'reported') { lostCoordinatorAccounting = true; throw Error('fixture accounting temporarily unavailable after report/disposal') }
      }
      const saved=await hub.client.call(path,body,...rest)
      if(mode==='prepared'&&path.endsWith('/builder-scope')&&body&&!lostScope){lostScope=true;throw new Error('fixture committed scope reply lost')}
      if(mode==='atomic'&&path==='/api/v1/messaging/superagents/builder-starts'&&!lostStart){lostStart=true;throw new Error('fixture committed start reply lost')}
      if(path==='/api/v1/messaging/superagents/drafts'&&body?.host_inspection){observationWrites++;if(!lostObservation){lostObservation=true;throw new Error('fixture committed observation reply lost')}}
      if(path==='/api/v1/messaging/superagents/drafts'&&body?.builder_operation){saveWrites++;if(!lostSave){lostSave=true;throw new Error('fixture committed save reply lost')}}
      return saved
    }}
    execution=new OfficialExecution(ctx,profiles,transport,{host:hub.node});host=new OfficialLoopHost(ctx,execution)
    if(nativeBuilder&&mode==='prepared')ctx.provide('kodeAgents',{profiles,officialExecution:execution,officialLoops:host})
    if(mode==='atomic'){
      ctx.provide('kodeAgents',{profiles,officialExecution:execution,officialLoops:host})
      await applyHost(ctx,{url:hub.url,tokenFile:join(hub.root,'admin.token'),stateFile:join(hub.root,'host-state.json'),agentRuntime:false,runtimeBridge:false,pollMs:10})
      assert.equal((await call('sessions')).sessions.some(s=>s.address.session_id==='builder'),false)
    }
    const draft={id:'draft',request_id:'create',expected_revision:0,revoked:false,interview:{purpose:'Build a team',workspace_refs:[{host_id:hub.node,workspace_id:'fixture',root_ref:root},{host_id:hub.node,workspace_id:'selected-other',root_ref:join(root,'other')}],answers:{},questions:[],proposed_team:null}}
    await call('superagents/drafts',draft)
    proposal={name:'Candidate',purpose:'Project delivery',kind:'coordinator',workspace_refs:draft.interview.workspace_refs,execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off'}
    workflowProposal={workflow:{id:'proposed-flow',version:'1',inputs:['request'],stages:[{id:'make',role:'author',requires:['request'],produces:['artifact'],independent_from:[]}],completion_stages:['make'],evidence_rules:{artifact:{kind:'artifact',repository_binding:'code'}}},
      project:{id:'proposed-project',version:'1',spec:{kind:'project_bindings',repositories:{code:{repository_id:'repo',workspace:draft.interview.workspace_refs[0]}},environments:{},commands:{},connections:{}}},
      delivery:{id:'proposed-delivery',version:'1',targets:[{kind:'local',repository_binding:'code'}],required_outputs:['artifact']}}
    delete proposal.grant_id;delete proposal.budget_policy_id;delete proposal.scheduling_policy_id
    proposal.delivery_bindings=[]
    const unbudgeted=await call('operations',{owner_session:'owner',request_key:'unbudgeted',worker:{node_id:hub.node,session_id:'builder'},grant_required:true})
    await profiles.patchBinding('builder',{managedOperation:{id:unbudgeted.id,attempt:1,epoch:1}})
    await assert.rejects(mountOfficialBuilderTools({get:()=>assert.fail('must reject before registering tools')},{id:'builder'},execution,{draft_id:'draft',team_id:'candidate'}),/budgeted, granted/)
    const at=Date.now()
    await call('budgets',{id:'creation',scope:'team',scope_id:'builder',unit:'credits',limit:100,starts_at:at-1000,ends_at:at+validityMs,expected_revision:0})
    const tokenPrice=liveBuilder?1:1000000
    await call('price-versions',{id:'price',model:builderModel,unit:'credits',model_policy:'requested_model',input_per_million:tokenPrice,cached_per_million:tokenPrice,output_per_million:tokenPrice})
    const scope={team_id:'builder',revision:1,target:{host:hub.node,workspace:'fixture',root},capabilities:['read','builder_draft_write'],tools:[...OFFICIAL_BUILDER_TOOLS],network:false,budget_ids:['creation']}
    await call('team-grants',{expected_revision:0,policy:{id:'grant',team_id:'builder',enabled:true,expires_at:at+validityMs,targets:[scope.target],capabilities:scope.capabilities,tools:scope.tools,network:false,budget_ids:scope.budget_ids}})
    let op,command,creation
    const policy={draft_id:'draft',team_id:'candidate'}
    if(mode==='prepared'){
    op=await call('operations',{owner_session:'owner',request_key:'builder',worker:{node_id:hub.node,session_id:'builder'},budget_required:true,grant_required:true,selection_policy:{profile_revision:profiles.binding('builder').revision,model:builderModel,effort:builderEffort,scope:'executor_configuration'}})
    await call('budget-reservations',{id:'hold',budget_ids:['creation'],amount:80,unit:'credits',operation_id:op.id})
    await call('budget-reservations/hold/pricing',{price_id:'price'})
    op=await call(`operations/${op.id}/budget`,{attempt:1,expected_revision:op.revision,reservation_id:'hold'})
    op=await call(`operations/${op.id}/grant`,{expected_revision:op.revision,binding:{grant_id:'grant',attempt:1,epoch:1,scope}})
    await profiles.patchBinding('builder',{managedOperation:{id:op.id,attempt:1,epoch:1}})
    await assert.rejects(mountOfficialBuilderTools({get:()=>assert.fail('must reject before mounting')},{id:'builder'},execution,{draft_id:'draft',team_id:'candidate'}),/authoritative draft scope/)
    assert.equal(calls,0)
    const preparation={command_id:'builder-create',operation_id:op.id,operation_revision:op.revision,draft_id:'draft',draft_revision:1,team_id:'candidate',profile_id:'builder',provider:builderProvider}
    await assert.rejects(host.prepareBuilder({...preparation,draft_revision:2}),/revision conflict/)
    await assert.rejects(host.prepareBuilder({...preparation,operation_revision:op.revision+1}),/authorization unavailable/)
    await profiles.update(state=>{delete state.bindings.builder})
    await assert.rejects(host.prepareBuilder(preparation),/committed scope reply lost/)
    assert.equal(profiles.binding('builder'),undefined)
    assert.equal((await call(`operations/${op.id}/builder-scope`)).scope.request.draft_id,'draft')
    command=await host.prepareBuilder(preparation)
    assert.deepEqual(await host.prepareBuilder(preparation),command,'preparation reuses scope and profile binding')
    assert.equal(calls,0,'preparation does not infer or claim the operation')
    assert.equal((await call(`operations/${op.id}`)).state,'prepared')
    assert.equal((await call('budgets/creation')).budget.spent,0)
    await call('superagents/drafts',{...draft,id:'foreign'})
    await assert.rejects(mountOfficialBuilderTools({get:()=>assert.fail('must reject before mounting')},{id:'builder'},execution,{draft_id:'foreign',team_id:'candidate'}),/authoritative draft scope/)
    await profiles.patchBinding('builder',{managedOperation:{id:op.id,attempt:1,epoch:1}})
    command.builder=policy
    creation=await host.dispatches.dispatch(command)
    assert.equal(creation.state,'created')
    assert.deepEqual(await host.dispatches.dispatch(command),creation,'creation replay does not create another Builder')
    await assert.rejects(host.dispatches.dispatch({...command,builder:{...policy,draft_id:'foreign'}}),/identity conflict/)
    await assert.rejects(host.dispatches.dispatch({...command,builder:{...policy,team_id:'foreign'}}),/identity conflict/)
    assert.throws(()=>host.dispatches.dispatch({...command,tools:[...OFFICIAL_BUILDER_TOOLS,'shell']}),/Builder dispatch/)
    }else{
    await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
    await call('resource-bindings',{host:hub.node,profile:'builder',account_id:'account',account_epoch:1,expected_revision:0})
    const start={draft_id:'draft',draft_revision:1,price_id:'price',operation:{owner_session:'owner',request_key:'builder-start',worker:{node_id:hub.node,session_id:'builder'},
      selection_policy:{profile_revision:profiles.binding('builder').revision,model:'model',effort:null,scope:'executor_configuration'},
      funding:{budget_ids:['creation'],amount:80,unit:'credits'},resource:{host:hub.node,profile:'builder',account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'},grant_id:'grant',grant_scope:scope}}
    await call('superagents/drafts/draft/selection', { request_id: 'select-runtime', expected_revision: 0, draft_revision: 1, selection: { profile_id: 'builder', provider: builderProvider, model: 'model', effort: null, workspace: draft.interview.workspace_refs[0] } })
    const request={command_id:'builder-create',team_id:'candidate',provider:builderProvider,selection_revision:1,start}
    const routes=new Map(),routeContext={webServer:{register:r=>{routes.set(r.path,r)}},get:name=>name==='kodeAgents'?{officialLoops:host,profiles}:ctx.get(name),connection:{admit:req=>req.headers['x-fixture-principal']==='owner'?{peer:{principal:{kind:'owner'}}}:{rejection:401}}}
    registerBuilderStart(routeContext);registerBuilderInput(routeContext,{backendClient:hub.client})
    registerBuilderConversation(routeContext,{backendClient:hub.client})
    registerBuilderContinue(routeContext,{backendClient:hub.client})
    registerBuilderAccept(routeContext,{backendClient:hub.client})
    webServer=createServer((req,res)=>routes.get(new URL(req.url,'http://localhost').pathname).handler(req,res));webServer.listen(0,'127.0.0.1');await once(webServer,'listening')
    const startHttp=async input=>{
      const response=await fetch(`http://127.0.0.1:${webServer.address().port}/api/kode/builder/start`,{method:'POST',headers:{'content-type':'application/json','x-fixture-principal':'owner'},body:JSON.stringify(input)})
      const value=await response.json();if(!response.ok)throw new Error(value.error);return value
    }
    inputHttp=async(input,read=false)=>{
      const query=read?`?${new URLSearchParams({operation_id:input.operation_id,request_id:input.request_id})}`:''
      const response=await fetch(`http://127.0.0.1:${webServer.address().port}/api/kode/builder/input${query}`,{method:read?'GET':'POST',headers:{'content-type':'application/json','x-fixture-principal':'owner'},...(read?{}:{body:JSON.stringify(input)})})
      const result=await response.json();assert.equal(response.status,200);return result
    }
    acceptHttp=async input=>{
      const response=await fetch(`http://127.0.0.1:${webServer.address().port}/api/kode/builder/accept-proposal`,{method:'POST',headers:{'content-type':'application/json','x-fixture-principal':'owner'},body:JSON.stringify(input)})
      const value=await response.json();assert.equal(response.status,200);return value
    }
    continueHttp=async input=>{
      const response=await fetch(`http://127.0.0.1:${webServer.address().port}/api/kode/builder/continue`,{method:'POST',headers:{'content-type':'application/json','x-fixture-principal':'owner'},body:JSON.stringify(input)})
      const value=await response.json();assert.equal(response.status,200);return value
    }
    conversationHttp=async operationId=>{
      let cursor={seq:0,offset:0};const messages=[];let source
      for(let n=0;n<100;n++){
        const query=new URLSearchParams({operation_id:operationId,...cursor})
        const response=await fetch(`http://127.0.0.1:${webServer.address().port}/api/kode/builder/conversation?${query}`,{headers:{'x-fixture-principal':'owner'}})
        assert.equal(response.status,200);const page=await response.json()
        source=page.source;messages.push(...page.messages);cursor=page.cursor
        if(!page.has_more)return {messages,source}
      }
      assert.fail('conversation cursor must finish')
    }
    for (const changed of [
      { ...request, selection_revision: 2 },
      { ...request, provider: 'different-provider' },
      { ...request, start: { ...start, operation: { ...start.operation, selection_policy: { ...start.operation.selection_policy, model: 'different-model' } } } },
      { ...request, start: { ...start, operation: { ...start.operation, grant_scope: { ...scope, target: { ...scope.target, root: join(root, 'other') } } } } },
    ]) await assert.rejects(startHttp(changed), /not confirmed/)
    assert.equal((await call('budgets/creation')).budget.reserved, 0, 'selection mismatch cannot reserve creation funds')
    assert.equal(lostStart, false)
    let startSlot
    const startStorage = { async reserve(_, value) { return startSlot && startSlot.state !== 'accepted' ? startSlot : (startSlot = value) }, async save(_, value) { startSlot = value } }
    const startFromClient = command => confirmBuilderStart({ storage: startStorage, draft: { id: 'draft', home_hub: hub.node }, command, request: startHttp })
    await profiles.update(state=>{delete state.bindings.builder})
    await assert.rejects(startFromClient(request),/not confirmed/)
    assert.equal(lostStart,true)
    assert.equal(profiles.binding('builder'),undefined)
    assert.equal((await call('budgets/creation')).budget.reserved,80)
    const started=await Promise.all([startFromClient(request),startFromClient({ ...request, command_id: 'changed-offer' })])
    assert.deepEqual(started[0],started[1],'concurrent starts share one creation')
    creation=started[0]
    assert.equal(startSlot.state, 'created')
    assert.deepEqual(await startFromClient({ ...request, command_id: 'new-offer' }), creation, 'terminal local slot cannot create another Builder')
    assert.equal(creation.state,'created')
    assert.deepEqual(await startHttp(request),creation)
    assert.equal((await call('budgets/creation/reservations')).reservations.length,1)
    await call('superagents/drafts/draft/selection', { request_id: 'future-choice', expected_revision: 1, draft_revision: 2, selection: { profile_id: 'builder', provider: 'fixture', model: 'next-model', effort: null, workspace: draft.interview.workspace_refs[0] } })
    assert.deepEqual(await startHttp(request), creation, 'later selection edits cannot change a committed start receipt')
    assert.equal(calls,0,'creation and replay do not submit model input')
    await assert.rejects(startHttp({...request,team_id:'different'}),/not confirmed/)
    command=creation.request;op=await call(`operations/${command.operation.id}`)
    assert.equal((await call('superagents/drafts/draft')).interview.questionnaire.id,'software-team')
    assert.equal(op.resource_required,true)
    assert.equal(op.state,'active')
    const registeredBuilder=(await call('sessions')).sessions.find(s=>s.address.session_id==='builder')
    assert.equal(registeredBuilder.runtime,'dsh','real Host registers Builder automatically before lease claim')
    }
    const ownerReview=await previewVerification(execution.verificationRunners,hub.node,{runner_id:'owner-local',command_id:'smoke',revision:'1',executable:await realpath(process.execPath),args:['--version'],timeout_ms:1000,max_output_bytes:1024,scenario_ids:['smoke'],capabilities:['read'],network:false,tool_id:'kode_verify_output'})
    commandReference=(await confirmVerification(execution.verificationRunners,hub.node,ownerReview)).reference
    const owned=host.handles.get('builder')
    if(liveBuilder){
      const before=await call('superagents/drafts/draft')
      const request=liveInterview
        ? '我想创建一个负责软件需求交付的团队，工作区已选好。请开始访谈，准备并保存本轮需要我回答的问题，然后等我回答。我还没有决定团队预算、交付终点和权限，请向我确认。'
        : 'Read the current draft with kode_builder_read_draft, then briefly summarize its purpose. This request is read-only. Finish after the summary.'
      owned.agent.followup({id:'live-builder-input',role:'user',source:{kind:'human'},content:[{type:'text',text:request}]})
      await owned.agent.whenIdle()
      assert.deepEqual(errors,[])
      const binding=profiles.binding('builder'),tools=Object.values(binding.officialTools??{})
      assert.ok(tools.some(row=>row.tool==='kode_builder_read_draft'&&row.home_reconciled))
      const after=await call('superagents/drafts/draft')
      if(liveInterview){
        assert.ok(after.revision>before.revision)
        assert.ok(after.interview.questions.length>0&&after.interview.questions.length<=3)
        assert.deepEqual(after.interview.answers,{})
        assert.equal(after.status,'draft')
      }else{
        assert.ok(tools.every(row=>row.tool==='kode_builder_read_draft'&&row.status==='returned'))
        assert.deepEqual(after,before)
      }
      assert.deepEqual((await call('teams')).items,[])
      const decisions=owned.agent.session.snapshotEvents().map(pluginRecordOf).filter(row=>row?.type==='plugin:kode/managed-cli-decision')
      assert.ok(decisions.length>=2)
      for(const {data} of decisions){
        assert.equal(data.failure_code,null)
        assert.equal(data.configuration.model,builderModel)
        assert.equal(data.configuration.reasoningEffort,builderEffort)
        assert.ok(data.usage.input_tokens+data.usage.output_tokens>0)
        assert.equal(data.stop.process_group_empty,true)
      }
      await owned.run.finish();await owned.dispose()
      const budget=await call('budgets/creation')
      assert.ok(budget.budget.spent>0)
      t.diagnostic(JSON.stringify({live_builder_decisions:decisions.length,scenario:liveInterview?'interview':'read',team_budget_spent:budget.budget.spent,
        price_basis:'internal_test_credits',cost_basis:'owner_authorized_free_hy4',draft_unchanged:!liveInterview,
        pending_questions:after.interview.questions.length}))
      return
    }
    assert.ok(!JSON.stringify(await ctx.systemPrompt.assemble({})).includes(BUILDER_PROMPT_VERSION),'Builder prompt must not leak to ordinary global sessions')
    policy.draft_id='foreign'
    assert.equal(ctx.tools.get(OFFICIAL_BUILDER_TOOLS[0]),undefined)
    await assert.rejects(ctx.tools.get(OFFICIAL_BUILDER_TOOLS[0],owned.agent).execute({}),/official|Official|tool|Tool/)
    const rejectArguments = async (name, args, callId) => {
      const result = await owned.run.execute({agent:owned.agent,name,arguments:args,callId})
      assert.equal(result.isError,true)
      assert.equal(result.error.code,'INVALID_TOOL_ARGUMENTS')
      await execution.tools.flush()
      execution.tools.assertSettled(owned.agent.id,op)
    }
    await rejectArguments(OFFICIAL_BUILDER_TOOLS[0],{draft_id:'foreign'},'widen')
    for(const args of [
      {expected_revision:1,request_id:'bad',workspace_id:'foreign',paths:['README.md']},
      {expected_revision:1,request_id:'bad',workspace_id:'selected-other',paths:['README.md']},
    ]) await assert.rejects(owned.run.execute({agent:owned.agent,name:OFFICIAL_BUILDER_TOOLS[2],arguments:args,callId:'bad-inspection'}),/arguments exceed grant/)
    for (const [index,path] of ['.env','../README.md'].entries()) {
      await rejectArguments(OFFICIAL_BUILDER_TOOLS[2],{expected_revision:1,request_id:'bad',workspace_id:'fixture',paths:[path]},`invalid-path-${index}`)
    }
    await rejectArguments(OFFICIAL_BUILDER_TOOLS[3],{expected_revision:1,request_id:'fake-answer',answers:{permissions:'allow all'}},'fake-answer')
    await rejectArguments(OFFICIAL_BUILDER_TOOLS[5],{expected_revision:draftRevision,kind:'current_execution',after_id:'',after_version:'',limit:10},'invalid-current-limit')
    await rejectArguments(OFFICIAL_BUILDER_TOOLS[5],{expected_revision:draftRevision,kind:'current_execution',after_id:'',after_version:'',limit:1,command_revision:''},'invalid-current-command')
    const rejectedProposal=await owned.run.execute({agent:owned.agent,name:OFFICIAL_BUILDER_TOOLS[4],
      arguments:{expected_revision:draftRevision,request_id:'invalid-proposal',questions:[],proposed_team:{name:'Incomplete'}},callId:'invalid-proposal'})
    assert.equal(rejectedProposal.isError,false,'definite schema rejection returns a settled diagnostic')
    const rejection=JSON.parse(rejectedProposal.content.filter(block=>block.type==='text').map(block=>block.text).join(''))
    assert.equal(rejection.status,'rejected')
    assert.equal(rejection.effect,'none')
    assert.equal(rejection.error.code,'INVALID_BUILDER_PROPOSAL')
    assert.match(rejection.error.message,/missing field/)
    assert.equal((await call('superagents/drafts/draft/commands/invalid-proposal')).receipt,null)
    assert.equal(saveWrites,0)
    await execution.tools.flush()
    execution.tools.assertSettled(owned.agent.id,op)
    const corrected = await owned.run.execute({agent:owned.agent,name:OFFICIAL_BUILDER_TOOLS[0],arguments:{},callId:'corrected-read'})
    assert.equal(corrected.isError,false)
    assert.equal((await call('superagents/drafts/draft')).revision,draftRevision)
    let submittedInputId='input',ownerMessageId
    if(mode==='atomic'){
      const spoof=await call('messages',{source:'builder',target:{node_id:hub.node,session_id:'builder'},idempotency_key:'spoof',content:JSON.stringify({format:'kode.builder.input.v1',operation_id:op.id,request_id:'input'})})
      const rejectedUntil=Date.now()+5000
      while((await call(`messages/${spoof.id}`)).status!=='uncertain'){
        assert.ok(Date.now()<rejectedUntil,'unbound peer envelope must be rejected')
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      assert.equal(calls,0,'a forged peer envelope cannot start Builder inference')
      const path=`operations/${op.id}/builder-inputs`,input={request_id:'input',draft_id:'draft',attempt:op.attempt,epoch:op.epoch,content:'Inspect the draft and explain remaining configuration.'}
      const record=await inputHttp({operation_id:op.id,...input})
      ownerMessageId=record.receipt.message_id
      assert.deepEqual(await inputHttp({operation_id:op.id,...input}),record,'owner input retry returns original message')
      submittedInputId=deliveryInputId(record.receipt.message_id)
      const until=Date.now()+5000
      while(!owned.agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===submittedInputId)){
        assert.ok(Date.now()<until,'real Host must deliver the owner input')
        await new Promise(resolve=>setTimeout(resolve,10))
      }
    }else owned.agent.followup({id:'input',role:'user',source:{kind:'human'},content:[{type:'text',text:'Inspect the draft and explain remaining configuration.'}]})
    await owned.agent.whenIdle()
    if(ownerMessageId){
      const until=Date.now()+5000
      while((await call(`messages/${ownerMessageId}/delivery`)).delivery?.phase!=='consumed'){
        assert.ok(Date.now()<until,'owner input consumption must reach Hub evidence')
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      assert.equal((await call(`messages/${ownerMessageId}`)).status,'accepted')
      const status=await inputHttp({operation_id:op.id,request_id:'input'},true)
      assert.equal(status.input.receipt.message_id,ownerMessageId)
      assert.equal(status.delivery.phase,'consumed')
    }
    assert.deepEqual(errors,[]);assert.equal(calls,6)
    assert.equal(profiles.binding('builder').officialTools['builder-1'].home_reconciled,true)
    assert.equal(profiles.binding('builder').officialTools['builder-2'].home_reconciled,true)
    assert.equal(profiles.binding('builder').officialTools['builder-3'].home_reconciled,true)
    assert.equal(profiles.binding('builder').officialTools['builder-4'].home_reconciled,true)
    assert.equal(profiles.binding('builder').officialTools['builder-5'].home_reconciled,true)
    assert.equal(lostSave,true);assert.equal(saveWrites,1,'committed response loss is recovered by readback, not another save')
    const budget=await call('budgets/creation')
    assert.equal(budget.label,'团队预算');assert.equal(budget.budget.spent,12)
    const savedDraft=await call('superagents/drafts/draft')
    assert.equal(savedDraft.revision,draftRevision+2);assert.equal(savedDraft.actor.kind,'builder')
    assert.equal(savedDraft.actor.operation_id,op.id)
    assert.deepEqual(savedDraft.interview.answers,{})
    assert.deepEqual(savedDraft.interview.proposed_workflow,workflowProposal)
    await assert.rejects(call('workflows/proposed-flow/versions/1'),/404/)
    assert.equal(observationWrites,1);assert.equal(lostObservation,true)
    const observedFacts=savedDraft.interview.inspections[0].facts
    assert.equal(observedFacts.find(f=>f.path==='README.md').content,'# Selected fixture project\n')
    assert.equal(observedFacts.find(f=>f.path==='.github/workflows/check.yml').content,'name: Selected fixture CI\n')
    assert.equal(observedFacts.find(f=>f.path==='.agents/skills/check/SKILL.md').content,'# Selected fixture skill\n')
    assert.equal(observedFacts.find(f=>f.path==='skills/plan/SKILL.md').content,'# Selected project plugin skill\n')
    assert.ok(savedDraft.interview.inspections[0].pending_checks.includes('workflow_preflight'))
    await writeFile(join(root,'README.md'),'changed after observation')
    const inspected=await owned.run.execute({agent:owned.agent,name:OFFICIAL_BUILDER_TOOLS[2],arguments:{expected_revision:draftRevision,request_id:'capture:1',workspace_id:'fixture',paths:inspectionPaths},callId:'repeat-inspect'})
    assert.equal(inspected.isError,false);assert.equal(observationWrites,1,'replay must not recapture changed files')
    await assert.rejects(observeOfficialBuilderDraft(execution,owned.agent,{draft_id:'draft'},op,{expected_revision:draftRevision,request_id:'capture:1',workspace_id:'fixture',paths:['package.json']},()=>{throw Error('must not recapture')}),/identity conflict/)
    assert.equal(observationWrites,1)
    const expectedProposal={...proposal,grant_id:null,budget_policy_id:null,scheduling_policy_id:null};delete expectedProposal.delivery_bindings
    assert.deepEqual(savedDraft.interview.proposed_team,expectedProposal,'receipt checks preserve backend optional-field normalization')
    const repeated=await owned.run.execute({agent:owned.agent,name:OFFICIAL_BUILDER_TOOLS[4],arguments:{expected_revision:draftRevision+1,request_id:'save:1',questions:[{id:'budget',prompt:'What is the team budget?'}],proposed_team:proposal,proposed_workflow:workflowProposal},callId:'repeat-save'})
    assert.equal(repeated.isError,false);assert.equal(saveWrites,1)
    assert.deepEqual((await call('teams')).items,[])
    if(nativeBuilder){
      assert.equal(nativePeer.calls,6)
      assert.deepEqual(nativePeer.errors,[])
      await owned.run.finish()
      await owned.dispose()
      return
    }
    let continued
    if(mode==='atomic'){
      await call('workflows',{id:'catalog-flow',version:'1',inputs:['request'],stages:[{id:'report',role:'writer',requires:['request'],produces:['report'],independent_from:[]}],completion_stages:['report'],evidence_rules:{report:{kind:'report',schema_id:'report',schema_hash:'a'.repeat(64)}}})
      await call('budgets',{id:'candidate-budget',scope:'team',scope_id:'candidate',unit:'credits',limit:50,expected_revision:0,starts_at:Date.now()-1000,ends_at:Date.now()+60000})
      await call('team-policies',{id:'candidate-budget',team_id:'candidate',expected_revision:0,policy:{kind:'budget',budget_ids:['candidate-budget'],unit:'credits',max_assignment_charge:10}})
      const confirmation={operation_id:op.id,draft_id:'draft',attempt:1,epoch:1,answer:{request_id:'budget-confirmed',expected_revision:savedDraft.revision,answers:{budget:'50 credits'}}}
      continued=await continueHttp(confirmation)
      assert.deepEqual(await continueHttp(confirmation),continued,'confirmation retry preserves one input')
      const nextInput=deliveryInputId(continued.input.receipt.message_id),until=Date.now()+5000
      while(!owned.agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===nextInput)){
        assert.ok(Date.now()<until,'confirmed answers must continue the real Builder loop')
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      await owned.agent.whenIdle()
      assert.equal(calls,11);assert.deepEqual(errors,[])
      assert.equal(profiles.binding('builder').officialTools['builder-7'].home_reconciled,true)
      assert.equal(profiles.binding('builder').officialTools['builder-8'].home_reconciled,true)
      assert.equal(profiles.binding('builder').officialTools['builder-9'].home_reconciled,true)
      assert.equal(profiles.binding('builder').officialTools['builder-command-reference'].home_reconciled,true)
      assert.equal(execution.verificationRunners.pending.size,0)
      assert.equal((await call('budgets/candidate-budget')).budget.spent,0)
      assert.equal((await call('budgets/creation')).budget.spent,22)
      const current=await call('superagents/drafts/draft')
      assert.equal(current.interview.answers.budget,'50 credits')
      assert.equal(continued.draft.interview.proposed_workflow,undefined,'confirmed answer invalidates workflow proposal')
      assert.deepEqual(current.interview.proposed_workflow,workflowProposal)
      assert.equal(continued.draft.interview.proposed_team,null,'confirmation invalidates prior proposal')
      assert.deepEqual(current.interview.proposed_team,expectedProposal,'Builder saves a new proposal after confirmed answers')
      assert.equal(saveWrites,2)
      assert.equal(profiles.binding('builder').officialTools['builder-10'].home_reconciled,true)
      assert.deepEqual((await call('teams')).items,[])
    }
    const readyDraft=await call('superagents/drafts/draft')
    const setupRequest={draft_id:'draft',expected_revision:readyDraft.revision,request_id:'confirm-workflow'}
    const setup=await setupSavedBuilderWorkflow(hub.client,setupRequest)
    assert.equal(setup.state,'registered');assert.equal(setup.activation_performed,false)
    assert.deepEqual(await setupSavedBuilderWorkflow(hub.client,setupRequest),setup)
    assert.deepEqual((await call('workflows/proposed-flow/versions/1')).pack,{...workflowProposal.workflow,stages:workflowProposal.workflow.stages.map(stage=>({...stage,on_reject:null}))})
    const liveConversation=mode==='atomic'?await conversationHttp(op.id):null
    if(liveConversation){
      assert.equal(liveConversation.source,'live')
      assert.deepEqual(liveConversation.messages.map(m=>m.text),['Inspect the draft and explain remaining configuration.','Draft requires configuration and human activation.',continued.input.request.content,'Confirmed budget received; configuration still requires human activation.'])
      assert.equal(calls,11,'conversation reads do not run inference')
    }
    if(mode==='atomic'){
      const acceptance={draft_id:'draft',request_id:'accept-proposal',expected_revision:draftRevision+4,team_id:'candidate',team_revision:0}
      const accepted=await acceptHttp(acceptance)
      assert.deepEqual(await acceptHttp(acceptance),accepted)
      assert.deepEqual(accepted.team.spec,expectedProposal)
      assert.equal(accepted.activation_performed,false);assert.equal(accepted.team.status,'draft')
      assert.equal((await call('teams')).items.length,1)
      assert.equal(calls,11,'owner acceptance does not invoke a model')
    }
    await owned.run.finish()
    if(mode==='atomic'){
      await owned.dispose()
      assert.equal(ctx.agents.get('builder'),undefined)
      const cold=await conversationHttp(op.id)
      assert.equal(cold.source,'stored');assert.deepEqual(cold.messages,liveConversation.messages)
      assert.equal(ctx.agents.get('builder'),undefined,'stored transcript read must not resume the Agent')
      const stored=await ctx.sessionPersistence.open('builder','read')
      try{
        const {events}=await stored.read(0,4096)
        assert.equal(events.filter(e=>e.type==='plugin:kode/official-creation').length,1)
        assert.equal(events.filter(e=>e.type==='user/message'&&e.data.id===submittedInputId).length,1)
        assert.match(JSON.stringify(events),/Draft requires configuration and human activation/)
        assert.equal(events.filter(e=>e.type==='user/message'&&e.data.id===deliveryInputId(continued.input.receipt.message_id)).length,1)
      }finally{await stored.close()}
      if (process.env.KODE_TEST_BROWSER_BIN) {
        const browserRoot = join(root, 'browser-project')
        await mkdir(browserRoot)
        await writeFile(join(browserRoot, 'README.md'), '# Selected fixture project\n')
        const git = args => promisify(execFile)('/usr/bin/git', ['-C', browserRoot, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } })
        await git(['init', '-q']); await git(['add', 'README.md']); await git(['commit', '-qm', 'isolated test baseline'])
        const recoverColdClose = async () => {
          const deadline = Date.now() + 10000
          while (!lostCoordinatorAccounting) {
            assert.ok(Date.now() < deadline, 'must reach reported/disposed pending accounting')
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          await host.coordinatorCloseRecovery.close()
          assert.equal(host.handles.has('browser-coordinator'), false)
          const pending = await call('coordinator-closes/pending')
          assert.equal(pending.items.length, 1)
          const before = coordinatorCalls
          const child = fork(new URL('./support/coordinator-close-cold-process.js', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
          try {
            const result = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(Error('Cold close process timed out')), 10000)
              child.once('error', error => { clearTimeout(timer); reject(error) })
              child.once('exit', code => { clearTimeout(timer); reject(Error(`Cold close process exited before its result (${code})`)) })
              child.on('message', async message => {
                if (message.kind === 'request') {
                  try { child.send({ kind: 'response', id: message.id, value: await hub.client.call(message.path, message.body) }) }
                  catch (error) { child.send({ kind: 'response', id: message.id, error: error.message }) }
                } else if (message.kind === 'done') { clearTimeout(timer); resolve(message) }
                else if (message.kind === 'failed') { clearTimeout(timer); reject(Error(message.error)) }
              })
              child.send({ kind: 'start', home: hub.node })
            })
            assert.equal(result.handles, 0)
            assert.equal(result.results.length, 1)
            assert.equal(result.results[0].state, 'closed')
            assert.equal(result.results[0].execution_resumed, false)
            assert.equal(coordinatorCalls, before, 'cold accounting recovery must not invoke the model')
            assert.deepEqual((await call('coordinator-closes/pending')).items, [])
          } finally { child.kill() }
          allowCoordinatorAccounting = true
          host.coordinatorCloseRecovery = new CoordinatorCloseRecovery(host)
          host.coordinatorCloseRecovery.start()
        }
        const browserSession = await inspectBuilderStartup({ hub, host, profiles, root: browserRoot, onPendingCoordinatorClose: recoverColdClose, onCoordinatorInput: human => resolveCoordinatorInput(human), onSuccessorInput: human => { successorHuman = human }, onRunCompleted: run => { browserRunId = run.id }, onCoordinatorFinalized: value => { finalizedCoordinator = value }, onConfigured: async draft => { browserDraft = draft; browserWorkflow = await browserBuilderWorkflow(execution, draft.interview.workspace_refs[0]) }, onWorkflowRegistered: async (draft, team) => { browserDraft = draft; browserTeam = team } })
        assert.equal(lostCoordinatorAccounting, true)
        assert.equal(workerSessions.size, 3)
        assert.equal(coordinatorCalls, 8)
        assert.deepEqual(errors, [])
        assert.equal(calls, 16, 'two browser inputs save workflow and team proposals through actual tools')
        assert.equal(profiles.binding(browserSession).officialTools['browser-team-save'].home_reconciled, true)
        assert.equal(profiles.binding(browserSession).officialTools['browser-workflow-save'].home_reconciled, true)
        assert.equal(profiles.binding(browserSession).officialTools['browser-draft-read'].home_reconciled, true)
        const browserOwned = host.handles.get(browserSession)
        await browserOwned.run.finish()
        await browserOwned.dispose()
        const untrusted = await call('sessions', { session_id: 'accounting-peer', title: 'Untrusted peer', runtime: 'external' })
        await assert.rejects(hub.client.forSession(untrusted.owner_token).call('/api/v1/messaging/' + finalizedCoordinator.path, finalizedCoordinator.command), /403/)
        await hub.stop('SIGKILL'); await hub.start()
        assert.deepEqual(await call(finalizedCoordinator.path, finalizedCoordinator.command), finalizedCoordinator.receipt)
        assert.deepEqual(await host.closeCoordinator(finalizedCoordinator.closeInput), finalizedCoordinator.closed)
        const finalEvents = (await call('operations/' + finalizedCoordinator.receipt.operation_id + '/events?after=0')).events
        assert.equal(finalEvents.filter(event => event.data.kind === 'coordinator_team_budget_finalized').length, 1)

      }
    }
  }finally{if(webServer){webServer.closeAllConnections();await new Promise(resolve=>webServer.close(resolve))}await host?.close();await execution?.close();await nativePeer?.close();await ctx.fiber.dispose();for(const name of await readdir(join(hub.root,'artifact-workspaces')).catch(e=>{if(e.code==='ENOENT')return [];throw e})){await chmod(join(hub.root,'artifact-workspaces',name,'source'),0o700).catch(e=>{if(e.code!=='ENOENT')throw e})}await hub.close()}
})
