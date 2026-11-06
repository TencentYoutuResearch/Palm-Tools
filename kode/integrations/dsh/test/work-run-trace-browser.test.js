/** Actual native delivery, shipped trace UI, keyboard inspection and browser file download. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
test('owner searches and downloads the complete delivered native trace after Home restart',{
 skip:!process.env.KODE_TEST_BACKEND_URL||!process.env.KODE_TEST_HOST_NODE||!process.env.KODE_TEST_BROWSER_BIN,timeout:115000,
},async()=>{
 const env={...process.env,KODE_TEST_COORDINATOR_BROWSER:'1',KODE_TEST_HOME_TRACE_BROWSER:'1',KODE_TEST_COORDINATOR_TRANSFER:'0'};delete env.NODE_TEST_CONTEXT
 const {stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',fileURLToPath(new URL('./fixture-coordinator-pipeline.js',import.meta.url))],{env,timeout:110000,maxBuffer:1024*1024})
 assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);assert.match(stdout,/skipped 0/)
})
