import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Questions from '@deepseek-ai/dsh-user-questions'
import {questionHeaderTools} from '../src/codex-async-question.js'
import {AgentProfiles} from '../src/agent-profiles.js'
import {AgentRuntimeAdapter,profileRoute} from '../src/agent-runtime.js'

test('Codex continues; DSH keeps one answerable native card and forwards a late answer',async()=>{
  const root=await mkdtemp(join(tmpdir(),'kode-questions-'))
  const ctx=new Context()
  const projections=await ctx.plugin(Projections), sessions=await ctx.plugin(Sessions)
  const session=ctx.sessions.prepare('async-question')
  const detach=ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  let reply
  const agent={id:session.id,ctx,session,inbox:{nextTurn:[],nextStep:[]},steer(message){reply=message}}
  ctx.provide('agents',{get:id=>id===session.id?agent:undefined})
  const questions=await ctx.plugin(Questions)
  const profile={id:'probe',name:'Probe',type:'codex',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-codex-server.js',import.meta.url))]}
  const profiles=await new AgentProfiles(join(root,'profiles.json')).open([profile])
  const adapter=new AgentRuntimeAdapter({agents:ctx.agents,sessionProjections:{stateOf:()=>({lastTurn:1,lastStepBoundary:{kind:'start',step:1}})}},profiles,{recordNative(){}})
  const selection={provider:profileRoute(profile.id),model:'fixture'}
  const stream=async message=>{
    let out=''
    for await(const chunk of adapter.stream({...selection,sessionId:session.id,messages:[message],tools:[],signal:AbortSignal.timeout(5000)}))
      if(chunk.type==='text-delta')out+=chunk.text
    return out
  }
  try {
    session.append('turn/start',{turn:1})
    session.append('request/header',{header:{config:selection,tools:questionHeaderTools([],profile)},reason:'initial'})
    session.append('step/start',{turn:1,step:1})
    assert.match(await stream({role:'user',id:'first',source:{kind:'user'},content:[{type:'text',text:'ASYNC_QUESTION'}]}),/fixture: ASYNC_QUESTION/)
    const view=()=>ctx.sessionProjections.stateOf(session,'userQuestions').questions
    const [card]=view().active
    assert.equal(view().active.length,1)
    assert.equal(card.state,'continued')
    const answers=card.questions.map((q,i)=>({id:q.id,selected:i?[]:['本机'],...(i?{custom:'下午'}:{})}))
    assert.equal(ctx.userQuestions.answer(agent,card.callId,{answers}),true)
    session.append('user/message',reply,{surfaceOp:'append'})
    const result=await stream(reply)
    const batch=JSON.parse(result.match(/<send_user_message_question_reply>\s*(.*?)\s*<\/send_user_message_question_reply>/s)[1])
    assert.deepEqual(batch.map(r=>[JSON.parse(r.questionItemId),r.answer]),[[['request_user_input_async','call_q',0],'本机'],[['request_user_input_async','call_q',1],'下午']])
    assert.equal(view().active.length,0)
    assert.equal(ctx.userQuestions.answer(agent,card.callId,{answers}),false)
  } finally {await adapter.close();detach();await questions.dispose();await sessions.dispose();await projections.dispose();await rm(root,{recursive:true,force:true})}
})
