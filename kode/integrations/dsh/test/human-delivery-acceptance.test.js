/** Actual native Workers/evidence/Hub; model replies and owner acceptance are controlled fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for (const [browser, choice] of [[false, 'accept'], [true, 'accept'], [true, 'reject']]) test(`configured human acceptance gates delivery after real implementation review and verification (browser=${browser}, choice=${choice})`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE || (browser && !process.env.KODE_TEST_BROWSER_BIN), timeout: 75000,
}, async () => {
  const env = { ...process.env, KODE_TEST_AUTOMATIC_SCENARIO: 'success', KODE_TEST_HUMAN_ACCEPTANCE: '1', KODE_TEST_HUMAN_ACCEPTANCE_BROWSER: browser ? '1' : '0', KODE_TEST_HUMAN_ACCEPTANCE_CHOICE: choice }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-automatic-workflow.js', import.meta.url))], { env, timeout: 70000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/); assert.match(stdout, /skipped 0/)
})
