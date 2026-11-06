/** Real Home, official runtimes and shipped IM; model output is controlled/unpaid. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('two persistent contacts keep identity and history across a different Coordinator session and Home restart', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE || !process.env.KODE_TEST_BROWSER_BIN,
  timeout: 115000,
}, async () => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('KODE_TEST_COORDINATOR_') || key.startsWith('KODE_TEST_HOME_TRACE') || key === 'KODE_TEST_FULL_DESKTOP' || key === 'KODE_TEST_EXECUTION_RECHECK') delete env[key]
  delete env.NODE_TEST_CONTEXT
  Object.assign(env, { KODE_TEST_COORDINATOR_TRANSFER:'1', KODE_TEST_COORDINATOR_FRESH_SUCCESSOR:'1', KODE_TEST_COORDINATOR_BROWSER:'1' })
  const { stdout } = await promisify(execFile)(env.KODE_TEST_HOST_NODE, ['--test','--test-reporter=spec',fileURLToPath(new URL('./fixture-coordinator-pipeline.js',import.meta.url))], { env, timeout:110000, maxBuffer:1024*1024 })
  assert.match(stdout,/pass 1/);assert.match(stdout,/fail 0/);assert.match(stdout,/skipped 0/)
})
