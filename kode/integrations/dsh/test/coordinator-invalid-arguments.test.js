/** Reject before dispatch, return known validation failure, then complete the real workflow. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

for (const kind of ['capture', 'review', 'read']) test(`Worker recovers from ${kind} input errors and completes without uncertain effects`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 95000,
}, async () => {
  const env = { ...process.env, KODE_TEST_INVALID_WORKER_ARGUMENTS: kind === 'capture' ? '1' : kind }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url)),
  ], { env, timeout: 90000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
})
