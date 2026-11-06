/** Real Coordinator notices, native Workers and Hub decisions; deterministic inference, no paid provider. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for (const [choice, revised] of [['accept', false], ['reject', false], ['reject', true]]) test(`Coordinator handles human acceptance and explicit linked revision (choice=${choice}, revised=${revised})`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 115000,
}, async () => {
  const env = { ...process.env, KODE_TEST_COORDINATOR_HUMAN_ACCEPTANCE: '1', KODE_TEST_COORDINATOR_HUMAN_CHOICE: choice, KODE_TEST_COORDINATOR_REVISED_DELIVERY: revised ? '1' : '0', KODE_TEST_COORDINATOR_UPDATE_RECOVERY: '0', KODE_TEST_COORDINATOR_BOOTSTRAP: '0', KODE_TEST_COORDINATOR_BLOCKED: '0', KODE_TEST_COORDINATOR_TRANSFER: '0', KODE_TEST_COORDINATOR_OWNER_SETUP: '0', KODE_TEST_COORDINATOR_BUILDER_SETUP: '0', KODE_TEST_COORDINATOR_BROWSER: '0' }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-coordinator-pipeline.js', import.meta.url))], { env, timeout: 110000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/); assert.match(stdout, /skipped 0/)
})
