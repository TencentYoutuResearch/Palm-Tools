/** Native artifact evidence, owner-only preview/decision and durable policy fencing. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for (const [decision, delivery, middle, rework] of [[false, false, false, false], [true, false, false, false], [true, true, false, false], [true, true, true, false], [true, true, true, true]]) test(`owner waiver ${decision ? `decision is durable with allow_delivery=${delivery}, middle=${middle}, rework=${rework}` : 'preview leaves ordinary verification running'}`,  { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 90000 }, async () => {
 const env = { ...process.env, KODE_TEST_AUTOMATIC_SCENARIO: rework ? 'verification-rework' : 'success', KODE_TEST_WAIVER_PREVIEW: '1', KODE_TEST_WAIVER_DECISION: decision ? '1' : '0', KODE_TEST_WAIVER_DELIVERY: delivery ? '1' : '0', KODE_TEST_WAIVER_MIDDLE: middle ? '1' : '0', KODE_TEST_WAIVER_REWORK: rework ? '1' : '0', KODE_TEST_STAGE_ESCALATION: '0', KODE_TEST_STAGE_ESCALATION_BUDGET: '0', KODE_TEST_HUMAN_ACCEPTANCE: '0' }; delete env.NODE_TEST_CONTEXT
 const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-automatic-workflow.js', import.meta.url))], { env, timeout: 85000, maxBuffer: 1024 * 1024 })
 assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/); assert.match(stdout, /skipped 0/)
})
