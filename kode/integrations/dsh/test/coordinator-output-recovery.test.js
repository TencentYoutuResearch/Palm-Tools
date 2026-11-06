/** Known evidence intent recovers omitted publication without additional model calls. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

for (const [output, remote] of [['artifact', false], ['reviewed', false], ['checked', false], ['all', false], ['all', true]]) test(`Home completes exact evidence after ${remote ? 'remote' : 'local'} Worker omits ${output} publication`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: remote ? 930000 : 100000,
}, async t => {
  const env = { ...process.env, KODE_TEST_OMIT_OUTPUT_PUBLICATION: output,
    KODE_TEST_REMOTE_ANSWER: remote ? '1' : '0', KODE_TEST_COORDINATOR_ANSWER: remote ? '1' : '0' }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,
    ['--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url))],
    { env, timeout: remote ? 925000 : 95000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
  assert.match(stdout, /skipped 0/)
  const summary = stdout.split('\n').find(line => line.includes('"recovered_output_scope":'))
  assert.ok(summary)
  t.diagnostic(summary)
})
