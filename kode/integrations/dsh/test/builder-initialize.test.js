import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { initializeBuilderInterview } from '../src/builder-initialize.js'
test('startup questionnaire initialization preserves custom plans and recovers exact saves', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
  const hub=await isolatedHub('builder-initialize')
  try{
    const drafts='/api/v1/messaging/superagents/drafts'
    const interview={purpose:'Create team',workspace_refs:[],answers:{},questions:[],proposed_team:null}
    await hub.client.call(drafts,{id:'draft',request_id:'create',expected_revision:0,revoked:false,interview})
    const start={draft_id:'draft',draft_revision:1,operation:{owner_session:'owner',request_key:'start'}}
    let writes=0
    const lossy={call:async(path,body,...rest)=>{const value=await hub.client.call(path,body,...rest);if(path===drafts){writes++;throw new Error('committed initialization reply lost')}return value}}
    const saved=await initializeBuilderInterview(lossy,start)
    assert.equal(saved.revision,2);assert.equal(saved.interview.questionnaire.id,'software-team')
    assert.equal(saved.interview.questions.length,3);assert.equal(writes,1)
    await hub.client.call(`${drafts}/draft/answers`,{request_id:'answer',expected_revision:2,answers:{task_kind:'需求交付'}})
    await hub.stop('SIGKILL');await hub.start()
    assert.deepEqual(await initializeBuilderInterview(hub.client,start),saved)
    assert.equal((await hub.client.call(`${drafts}/draft`)).revision,3,'replay cannot rewind confirmed answers')
    const custom={...interview,questionnaire:{id:'research',version:'1',questions:[{id:'outcome',prompt:'What research result?'}]},answers:{outcome:'report'},questions:[]}
    await hub.client.call(drafts,{id:'custom',request_id:'create',expected_revision:0,revoked:false,interview:custom})
    const selected=await initializeBuilderInterview(hub.client,{...start,draft_id:'custom'})
    assert.deepEqual(selected.interview,custom,'existing owner plan and answers remain exact')
    await hub.client.call(drafts,{id:'populated',request_id:'create',expected_revision:0,revoked:false,interview:{...interview,answers:{unknown:'legacy answer'}}})
    await assert.rejects(initializeBuilderInterview(hub.client,{...start,draft_id:'populated'}),/Select an interview plan/)
    assert.equal((await hub.client.call(`${drafts}/populated`)).revision,1)
    assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items,[])
  }finally{await hub.close()}
})
