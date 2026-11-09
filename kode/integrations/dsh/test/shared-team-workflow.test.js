/** Real isolated Hub, official loops, six Worker sessions and local verification processes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
test('two teams using one registered Git root automatically deliver into isolated task worktrees',{
 skip:!process.env.KODE_TEST_BACKEND_URL||!process.env.KODE_TEST_HOST_NODE,timeout:75000,
},async t=>{
 const env={...process.env,KODE_TEST_AUTOMATIC_SCENARIO:'shared-teams'};delete env.NODE_TEST_CONTEXT
 const {stdout}=await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,['--test','--test-reporter=spec',fileURLToPath(new URL('./fixture-automatic-workflow.js',import.meta.url))],{env,timeout:70000,maxBuffer:1024*1024})
 assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);assert.match(stdout,/skipped 0/)
 const evidence=stdout.split('\n').find(line=>line.includes('task_worktree_evidence'))
 assert.ok(evidence,'task worktree receipt and original dirty tree evidence is retained')
 t.diagnostic(evidence)
})
