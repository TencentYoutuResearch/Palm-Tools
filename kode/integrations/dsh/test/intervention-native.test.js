/** Real official Workers, verification subprocess, Home restart and resumed independent pipeline. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
test('owner takeover drains actual verification, then revalidates manual edits through fresh independent Workers', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 105000,
}, async () => {
  const env = { ...process.env, KODE_TEST_AUTOMATIC_SCENARIO: 'takeover-tool' }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec',
    fileURLToPath(new URL('./fixture-automatic-workflow.js', import.meta.url))], { env, timeout: 100000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/); assert.match(stdout, /skipped 0/)
})
