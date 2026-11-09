/** Actual Coordinator inbox/official tools and subsequent normal independent delivery. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
test('paused work survives Home restart and notifies its Coordinator once before owner resume', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 110000,
}, async () => {
  const env = { ...process.env, KODE_TEST_COORDINATOR_INTERVENTION: '1' }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec',
    fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url))], { env, timeout: 105000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/); assert.match(stdout, /skipped 0/)
})
