import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for (const acceptance of [false, true]) test(`owner browser reviews exact waiver and recovers lost commit reply (acceptance=${acceptance})`, { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE || !process.env.KODE_TEST_BROWSER_BIN, timeout: 90000 }, async () => {
 const env = { ...process.env, KODE_TEST_AUTOMATIC_SCENARIO: 'success', KODE_TEST_WAIVER_PREVIEW: '1', KODE_TEST_WAIVER_DECISION: '1', KODE_TEST_WAIVER_DELIVERY: '1', KODE_TEST_WAIVER_MIDDLE: '1', KODE_TEST_WAIVER_REWORK: '0', KODE_TEST_WAIVER_BROWSER: '1', KODE_TEST_STAGE_ESCALATION: '0', KODE_TEST_STAGE_ESCALATION_BUDGET: '0', KODE_TEST_HUMAN_ACCEPTANCE: acceptance ? '1' : '0' }; delete env.NODE_TEST_CONTEXT
 const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-automatic-workflow.js', import.meta.url))], { env, timeout: 85000, maxBuffer: 1024 * 1024 })
 assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/); assert.match(stdout, /skipped 0/)
})
