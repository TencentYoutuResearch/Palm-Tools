import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
test('task question preserves active renew, tools, report and verified delivery', { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 90000 }, async t=>{
 const env={...process.env,KODE_TEST_AUTOMATIC_SCENARIO:'success',KODE_TEST_COLLABORATION_QUESTION:'1'};delete env.NODE_TEST_CONTEXT
 const {stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',fileURLToPath(new URL('./fixture-automatic-workflow.js',import.meta.url))],{env,timeout:85000,maxBuffer:1024*1024})
 assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);assert.match(stdout,/"lease_renewed":true/);t.diagnostic(stdout.split("\n").find(line=>line.includes("lease_renewed")))
})

for(const mode of ['cancel-busy','cancel-tool'])test(`task cancellation preserves stop and accounting authority (${mode})`,{skip:!process.env.KODE_TEST_BACKEND_URL||!process.env.KODE_TEST_HOST_NODE,timeout:90000},async t=>{
 const env={...process.env,KODE_TEST_AUTOMATIC_SCENARIO:mode,KODE_TEST_COLLABORATION_CANCEL:'1'};delete env.NODE_TEST_CONTEXT;delete env.KODE_TEST_COLLABORATION_QUESTION
 const{stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',fileURLToPath(new URL('./fixture-automatic-workflow.js',import.meta.url))],{env,timeout:85000,maxBuffer:1024*1024})
 assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);assert.match(stdout,/"restart_recovered":true/);t.diagnostic(stdout.split('\n').find(line=>line.includes('task_cancel')))
})
