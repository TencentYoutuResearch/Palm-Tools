/** Installed wrapper and engine, owned synthetic inference and real Home/Worker workflow. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('installed TCodex wrapper uses the Host bootstrap and resumes its Worker after a human answer', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE
    || !process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE || !process.env.KODE_TEST_MANAGED_CODEX_WRAPPER,
  timeout: 125000,
}, async () => {
  const env = { ...process.env, KODE_TEST_NATIVE_ANSWER: '1', KODE_TEST_COORDINATOR_ANSWER: '1',
    KODE_TEST_NATIVE_MODEL: 'hy4-preview-ioa',
    KODE_TEST_MANAGED_CODEX_BOOTSTRAP_ENGINE: process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,
    KODE_TEST_MANAGED_CODEX_EXECUTABLE: process.env.KODE_TEST_MANAGED_CODEX_WRAPPER }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url)),
  ], { env, timeout: 120000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
})
