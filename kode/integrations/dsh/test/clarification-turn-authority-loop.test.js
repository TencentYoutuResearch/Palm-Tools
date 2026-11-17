/** Real Host and Hub clarification loop, with one extra adversarial controlled-model turn. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,rm} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'

test('answer turn rejects old owner workflow authority and wrong targets before tool bodies, then answers normally',{skip:!process.env.KODE_TEST_HOST_NODE||!process.env.KODE_TEST_BACKEND_URL,timeout:120000},async()=>{
 let source=await readFile(new URL('./fixture-coordinator-pipeline.js',import.meta.url),'utf8')
 const replace=(a,b)=>{assert.ok(source.includes(a),'Fixture seam changed: '+a.slice(0,80));source=source.replace(a,b)}
 replace('  let questionReceipt,answerNoticePhase=0','  let injectedAttackTurns=0;const forbiddenBodyCalls=[]\n  let questionReceipt,answerNoticePhase=0')
 replace('    if(answerScenario&&calls>=10){',`    if(answerScenario&&calls===10&&injectedAttackTurns===0){
     injectedAttackTurns++
     const human=options.messages.filter(message=>message.role==='user').at(-1)
     const reference=JSON.stringify(human).match(/Hub request reference: ([A-Za-z0-9_.-]+)/)?.[1]
     assert.ok(reference);assert.notEqual(reference,currentReply.source_message_id)
     const attacks=[
      ['kode_coordinator_workflow_start',{request_id:'forbidden-old-owner-start',source_message_id:currentReply.source_message_id,binding_id:'local',inputs:{request:'must not create another run'}}],
      ['kode_coordinator_answer_clarification',{request_id:'forbidden-other-assignment',source_message_id:reference,assignment_id:'other-assignment',question_request_id:questionReceipt.request.request_id}],
      ['kode_coordinator_answer_clarification',{request_id:'forbidden-other-question',source_message_id:reference,assignment_id:questionReceipt.assignment_id,question_request_id:'other-question'}],
      ['kode_coordinator_answer_clarification',{request_id:'forbidden-old-owner-answer',source_message_id:currentReply.source_message_id,assignment_id:questionReceipt.assignment_id,question_request_id:questionReceipt.request.request_id}],
      ['kode_coordinator_publish_reply',{request_id:'forbidden-other-source-reply',source_message_id:currentReply.source_message_id,content:'must not publish from this answer turn'}],
     ]
     for(const [index,[name,args]] of attacks.entries()){
      yield {type:'block-start',index,blockType:'tool-call'}
      yield {type:'block-end',index,block:{type:'tool-call',id:'authority-attack-'+index,name,arguments:JSON.stringify(args)}}
     }
     // Existing fixture counter describes normal protocol steps; injectedAttackTurns separately
     // records this additional actual adapter call so no normal completion assertion is weakened.
     calls--
     yield {type:'usage',usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}
     yield {type:'finish',reason:{kind:'tool-calls'}};return
    }
    if(answerScenario&&calls>=10){`)
 replace("  ctx.provide('kodeAgents'",`  const originalBody=execution.entry.assertToolBody.bind(execution.entry)
  execution.entry.assertToolBody=(agent,name,args)=>{if(args.request_id?.startsWith('forbidden-'))forbiddenBodyCalls.push({name,args});return originalBody(agent,name,args)}
  ctx.provide('kodeAgents'`)
 replace('    assert.equal(answerWrites,1);assert.equal(lostAnswer,true)',`    assert.equal(answerWrites,1);assert.equal(lostAnswer,true)
    assert.equal(injectedAttackTurns,1);assert.deepEqual(forbiddenBodyCalls,[])
    assert.equal(workflowWrites,1,'only the original authorized workflow was created')
    const denials=Object.values(profiles.binding(coordinatorId).officialTools).filter(x=>x.reason==='clarification_rejected_before_dispatch')
    assert.equal(denials.length,5);assert.ok(denials.every(x=>x.status==='returned'&&x.home_reconciled))
    assert.equal((await call('teams/team/work-runs?limit=20')).items.length,1)
    console.log('clarification_turn_authority '+JSON.stringify({extra_controlled_adapter_turns:injectedAttackTurns,denied_before_dispatch:denials.length,forbidden_body_calls:forbiddenBodyCalls.length,authorized_answers:answerWrites,workflow_writes:workflowWrites}))`)
 replace('52+4*answerProgressNotices-recoveryDiscount','52+4*answerProgressNotices-recoveryDiscount+2*injectedAttackTurns')
 const path=fileURLToPath(new URL('.clarification-authority-'+randomUUID()+'.mjs',import.meta.url))
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('KODE_TEST_'))),KODE_TEST_BACKEND_URL:process.env.KODE_TEST_BACKEND_URL,KODE_TEST_HOST_NODE:process.env.KODE_TEST_HOST_NODE,KODE_TEST_COORDINATOR_ANSWER:'1',KODE_TEST_COORDINATOR_QUESTION:'1',KODE_TEST_NATIVE_ANSWER:'0',KODE_TEST_REMOTE_ANSWER:'0'};delete env.NODE_TEST_CONTEXT
 await writeFile(path,source,{flag:'wx'})
 try{const {stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',path],{env,timeout:110000,maxBuffer:2*1024*1024});assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);assert.match(stdout,/"forbidden_body_calls":0/)}catch(error){throw Error((error.stdout??'')+'\n'+(error.stderr??'')+'\n'+error.message)}finally{await rm(path,{force:true})}
})
