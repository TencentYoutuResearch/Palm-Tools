import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for(const cancelled of [false,true])test(`two task clarification scope and continuation (cancel second=${cancelled})`,{skip:!process.env.KODE_TEST_BACKEND_URL||!process.env.KODE_TEST_HOST_NODE,timeout:90000},async t=>{
 const env={...process.env,KODE_TEST_AUTOMATIC_SCENARIO:'success',KODE_TEST_COLLABORATION_CLARIFICATION:'1',KODE_TEST_CLARIFICATION_CANCEL:cancelled?'1':'0'}
 for(const key of ['NODE_TEST_CONTEXT','KODE_TEST_COLLABORATION_QUESTION','KODE_TEST_COLLABORATION_CANCEL'])delete env[key]
 const {stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',fileURLToPath(new URL('./fixture-automatic-workflow.js',import.meta.url))],{env,timeout:85000,maxBuffer:1024*1024})
 assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);assert.match(stdout,cancelled?/"cancelled_task_rejects_answer":true/:/"completed_runs":2/)
 t.diagnostic(stdout.split('\n').find(line=>line.includes('completed_runs')))
})
