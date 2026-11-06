/** Two native pipelines, failed verifiers and concurrent expert demand on one finite account/budget. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
test('two teams wait for shared expert funding and automatically finish without duplicate reservations',{
 skip:!process.env.KODE_TEST_BACKEND_URL||!process.env.KODE_TEST_HOST_NODE,timeout:115000,
},async()=>{
 const env={...process.env,KODE_TEST_AUTOMATIC_SCENARIO:'shared-teams',KODE_TEST_SHARED_EXPERT_PRESSURE:'1',KODE_TEST_STAGE_ESCALATION:'1',KODE_TEST_STAGE_ESCALATION_ALTERNATE:'1',KODE_TEST_STAGE_ESCALATION_BUDGET:'0'};delete env.NODE_TEST_CONTEXT
 const {stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',fileURLToPath(new URL('./fixture-automatic-workflow.js',import.meta.url))],{env,timeout:110000,maxBuffer:1024*1024})
 assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);assert.match(stdout,/skipped 0/)
})
