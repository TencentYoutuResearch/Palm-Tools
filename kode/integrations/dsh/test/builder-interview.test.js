import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { prepareBuilderInterview, defaultBuilderQuestionnaire, registerBuilderInterview } from '../src/builder-interview.js'
const path='/api/v1/messaging/superagents/drafts'
test('configurable Builder interview resumes, branches on explicit answers and never activates', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
  const hub=await isolatedHub('builder-interview-home')
  try {
    await hub.client.call(path,{id:'draft',request_id:'create',expected_revision:0,revoked:false,interview:{purpose:'Custom research team',workspace_refs:[],answers:{delivery:'local report'},questions:[],proposed_team:null}})
    const questionnaire={id:'custom',version:'1',questions:[
      {id:'scenario',prompt:'Which work?'},
      {id:'delivery',prompt:'Where does delivery end?'},
      {id:'reproduce',prompt:'How to reproduce?',when_answer:{question_id:'scenario',equals:'bug'}},
      {id:'budget',prompt:'Team budget?'},{id:'permissions',prompt:'External writes?'},{id:'failure',prompt:'When to pause?'},
    ]}
    const initial=await prepareBuilderInterview(hub.client,{draft_id:'draft',request_id:'plan',expected_revision:1,questionnaire})
    assert.deepEqual(initial.questions.map(q=>q.id),['scenario','budget','permissions'])
    assert.equal(initial.questions.length,3); assert.equal(initial.interview_answers_complete,false)
    await hub.client.call(path,initial.command)
    await hub.stop('SIGKILL'); await hub.start()
    const answered=await prepareBuilderInterview(hub.client,{draft_id:'draft',request_id:'answer',expected_revision:2,answers:{scenario:'bug',budget:'100 credits',permissions:'ask first'}})
    assert.deepEqual(answered.questions.map(q=>q.id),['reproduce','failure'])
    assert.deepEqual(answered.command.interview.questionnaire,questionnaire)
    await hub.client.call(path,answered.command)
    const complete=await prepareBuilderInterview(hub.client,{draft_id:'draft',request_id:'complete',expected_revision:3,answers:{reproduce:'fixture',failure:'pause on missing evidence'}})
    assert.equal(complete.interview_answers_complete,true); assert.equal(complete.eligible_for_execution,false)
    assert.ok(complete.pending_checks.includes('human_activation'))
    const saved=await hub.client.call(path,complete.command)
    assert.deepEqual(await hub.client.call(path,complete.command),saved)
    const changed=await prepareBuilderInterview(hub.client,{draft_id:'draft',request_id:'change',expected_revision:4,answers:{scenario:'research'},clear_answers:['budget']})
    assert.deepEqual(changed.invalidated_answers,['reproduce'])
    assert.equal(changed.command.interview.answers.reproduce,undefined)
    assert.deepEqual(changed.questions.map(q=>q.id),['budget'])
    assert.equal(changed.configuration_invalidated,true)
    await hub.client.call(path,changed.command)
    await assert.rejects(prepareBuilderInterview(hub.client,{draft_id:'draft',request_id:'stale',expected_revision:4}),/revision conflict/)
    await assert.rejects(prepareBuilderInterview(hub.client,{draft_id:'draft',request_id:'inactive',expected_revision:5,answers:{reproduce:'fabricated'}}),/inactive/)
    await assert.rejects(prepareBuilderInterview(hub.client,{draft_id:'draft',request_id:'unknown',expected_revision:5,answers:{invented:'yes'}}),/invalid Builder answers/)
    await assert.rejects(prepareBuilderInterview(hub.client,{draft_id:'draft',request_id:'replace',expected_revision:5,questionnaire:defaultBuilderQuestionnaire()}),/already selected/)
    const bad=structuredClone(changed.command); bad.expected_revision=5;bad.request_id='cycle'
    bad.interview.questionnaire.questions[0].when_answer={question_id:'failure',equals:'yes'}
    await assert.rejects(hub.client.call(path,bad),/forward dependency/)
    assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items,[])
    await hub.client.call(path,{id:'default',request_id:'create',expected_revision:0,revoked:false,interview:{purpose:'Software delivery',workspace_refs:[],answers:{task_kind:'缺陷修复',delivery:'本地验证',example:'修复一个崩溃'},questions:[],proposed_team:null}})
    const standard=await prepareBuilderInterview(hub.client,{draft_id:'default',request_id:'questions',expected_revision:1})
    assert.deepEqual(standard.questions.map(q=>q.id),['reproduction','workflow','resources'])
    assert.equal(standard.command.interview.questionnaire.id,'software-team')
    await hub.client.call(path,standard.command)
    const remaining=Object.fromEntries(defaultBuilderQuestionnaire().questions.filter(q=>!Object.hasOwn(standard.command.interview.answers,q.id)).map(q=>[q.id,'由用户明确说明的约定']))
    const standardComplete=await prepareBuilderInterview(hub.client,{draft_id:'default',request_id:'answers',expected_revision:2,answers:remaining})
    assert.equal(standardComplete.interview_answers_complete,true)
    assert.equal(standardComplete.command.interview.proposed_team,null,'answers do not fabricate a validated team')
    assert.equal(standardComplete.eligible_for_execution,false)
    await hub.client.call(path,standardComplete.command)
  } finally { await hub.close() }
})
test('Builder interview preparation denies Worker credentials before invoking backend',async()=>{
  let route,status
  registerBuilderInterview({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind:'worker'}}})}},{backendClient:{call:()=>assert.fail('must not call')}})
  await route.handler({method:'POST'},{writeHead:s=>{status=s},end:()=>{}})
  assert.equal(status,403)
})
