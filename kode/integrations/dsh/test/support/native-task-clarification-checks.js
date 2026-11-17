/** Explicit helper checks; no provider or child launch. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {nativeTaskEnvironment} from './native-task-clarification-runner.js'
import {nativeTaskClarificationSource} from './native-task-clarification-source.js'
import {answerCommand,consumedAnswer,taskAnswer} from './native-task-clarification-pipeline.js'
const env={KODE_TEST_LIVE_TASK_CLARIFICATION:'1',KODE_TEST_LIVE_FREE_WRAPPER:'1',KODE_TEST_HOST_NODE:'/node',KODE_TEST_MANAGED_CODEX_EXECUTABLE:'/engine',KODE_TEST_MANAGED_CODEX_WRAPPER:'/wrapper',KODE_TEST_WRAPPER_HOME:'/home',KODE_TEST_WRAPPER_PROVIDER:'example',KODE_TEST_NATIVE_MODEL:'example',KODE_TEST_LIVE_EVIDENCE_DIR:'/new-evidence',KODE_TEST_BACKEND_URL:'http://127.0.0.1:1'}
test('native route requires both gates, all explicit inputs, absolute paths; strips other scenarios',()=>{
 for(const key of Object.keys(env)){const missing={...env};delete missing[key];assert.throws(()=>nativeTaskEnvironment(missing),key)}
 assert.throws(()=>nativeTaskEnvironment({...env,KODE_TEST_WRAPPER_HOME:'relative'}))
 const result=nativeTaskEnvironment({...env,KODE_TEST_REMOTE_ANSWER:'1',NODE_TEST_CONTEXT:'child'})
 assert.equal(result.KODE_TEST_REMOTE_ANSWER,undefined);assert.equal(result.NODE_TEST_CONTEXT,undefined)
})
test('fixture source uses only verified setup seam, no inherited response-loss expectations execute',async()=>{
 const original=await readFile(new URL('../fixture-coordinator-pipeline.js',import.meta.url),'utf8'),source=nativeTaskClarificationSource(original)
 assert.ok(source.indexOf('await withNativeTaskCleanup(')<source.indexOf('const plan=await host.planCoordinatorStart'))
 assert.ok(source.includes("throw Error('Controlled adapter forbidden"));assert.ok(source.includes('timeout:Infinity'))
 assert.throws(()=>nativeTaskClarificationSource(original.replace("  const automatic=",'  const removed=')))
})
test('owner answer scope and exact multiline consumed payload',()=>{
 const task={runId:'run',archive_surface_id:'channel',thread_id:'thread'},q={run_id:'run',state:'pending',assignment_id:'assignment',request:{request_id:'question',questions:[{question:'model-owned question'}]}}
 const input=answerCommand(task,q);assert.equal(input.content,taskAnswer)
 assert.throws(()=>answerCommand(task,{...q,run_id:'other'}));assert.throws(()=>answerCommand(task,{...q,state:'answered'}))
 const payload={format:'kode.assignment.clarification-answer.v1',run_id:'run',assignment_id:'assignment',question_request_id:'question',answer:{content:taskAnswer}}
 const events=[{type:'user/message',data:{content:[{type:'text',text:'Forwarded answer\n\n'+JSON.stringify(payload)}]}}]
 consumedAnswer(events,input)
 assert.throws(()=>consumedAnswer(events,{...input,content:'mutated'}));assert.throws(()=>consumedAnswer(events,{...input,run_id:'other'}));assert.throws(()=>consumedAnswer([...events,...events],input))
})
