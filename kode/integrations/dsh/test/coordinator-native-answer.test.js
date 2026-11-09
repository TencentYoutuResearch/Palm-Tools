/** Installed native engine, owned synthetic Responses peer, actual human-answer workflow. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('installed native Worker asks through its Superagent and resumes the same session with the human answer', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE || !process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,
  timeout: 105000,
}, async () => {
  const env = { ...process.env, KODE_TEST_NATIVE_ANSWER: '1', KODE_TEST_COORDINATOR_ANSWER: '1' }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url)),
  ], { env, timeout: 100000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
})
