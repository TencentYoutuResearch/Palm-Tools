/** Run actual Coordinator input and workspace locks in the isolated native-capable runtime. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

for(const [recovery,followup] of [[false,false],[true,false],[false,true]])test(`native Coordinator official loop, inbox consumption and durable accounting (history recovery=${recovery}, follow-up=${followup})`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE,
  timeout: 65000,
}, async () => {
  const env = { ...process.env, KODE_TEST_COORDINATOR_RESUME:recovery?'1':'0', KODE_TEST_COORDINATOR_FOLLOWUP:followup?'1':'0' }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec',
    fileURLToPath(new URL('./fixture-official-coordinator.js', import.meta.url)),
  ], { env, timeout: 60000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
  assert.match(stdout, /skipped 0/)
})
