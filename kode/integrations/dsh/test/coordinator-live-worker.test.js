/** Live implementation, or all live Workers, with a controlled Coordinator model. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test(`live free ${process.env.KODE_TEST_LIVE_ALL_WORKERS === '1' ? 'implementation/review/verification Workers' : 'implementation Worker'} deliver through Home admission and accounting`, {
  skip: process.env.KODE_TEST_LIVE_FREE_WRAPPER !== '1' || !process.env.KODE_TEST_BACKEND_URL,
  timeout: 950000,
}, async t => {
  for (const key of ['KODE_TEST_HOST_NODE', 'KODE_TEST_MANAGED_CODEX_WRAPPER',
    'KODE_TEST_MANAGED_CODEX_EXECUTABLE', 'KODE_TEST_WRAPPER_HOME',
    'KODE_TEST_WRAPPER_PROVIDER', 'KODE_TEST_NATIVE_MODEL']) assert.ok(process.env[key], `Explicit ${key} required`)
  const env = { ...process.env, KODE_TEST_LIVE_WORKER: '1', KODE_TEST_NATIVE_ANSWER: '0',
    KODE_TEST_COORDINATOR_ANSWER: '0', KODE_TEST_REMOTE_ANSWER: '0',
    KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE: process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,
    KODE_TEST_MANAGED_CODEX_EXECUTABLE: process.env.KODE_TEST_MANAGED_CODEX_WRAPPER }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url)),
  ], { env, timeout: 940000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
  assert.match(stdout, /"live_worker_decisions":/)
  const summary = stdout.split('\n').find(line => line.includes('"live_worker_decisions":'))
  t.diagnostic(summary)
})
