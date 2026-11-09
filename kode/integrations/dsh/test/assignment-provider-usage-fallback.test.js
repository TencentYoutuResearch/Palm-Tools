/** Home ledger integration for trusted provider usage fallback and invalid totals. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

for (const mode of ['provider-fallback-valid', 'provider-fallback-alias', 'provider-fallback-invalid',
  'provider-fallback-delayed', 'provider-fallback-tail-conflict', 'provider-fallback-stalled']) test(`Home usage accounting with native usage omitted (${mode})`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE,
  timeout: 65000,
}, async () => {
  const env = { ...process.env, KODE_TEST_PROVIDER_FALLBACK: mode }
  delete env.KODE_TEST_MANAGED_CODEX_EXECUTABLE
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', `--test-name-pattern=${mode}`, '--test-reporter=spec',
    fileURLToPath(new URL('./fixture-official-assignment.js', import.meta.url)),
  ], { env, timeout: 60000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/)
  assert.match(stdout, /fail 0/)
})
