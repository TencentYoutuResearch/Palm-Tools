/** Two isolated Hubs, real official runtimes, controlled model and actual verification. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('remote Worker consumes its Home-bound human answer and completes independent review and verification', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE,
  timeout: 930000,
}, async () => {
  const env = { ...process.env, KODE_TEST_REMOTE_ANSWER: '1', KODE_TEST_COORDINATOR_ANSWER: '1', KODE_TEST_NATIVE_ANSWER: '0' }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url)),
  ], { env, timeout: 925000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
})
