/** Actual Home/Host/Worker/Superagent conversation path with a controlled model adapter. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

for (const answer of [false, true]) test(`Worker question reaches its Superagent and fixed conversation (answer and resume=${answer})`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE,
  timeout: 105000,
}, async () => {
  const env = { ...process.env, KODE_TEST_COORDINATOR_QUESTION: '1', KODE_TEST_COORDINATOR_ANSWER: answer ? '1' : '0' }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url)),
  ], { env, timeout: 100000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
})
