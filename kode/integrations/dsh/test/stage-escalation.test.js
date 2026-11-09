/** Actual failed verification -> rework -> frozen escalation ranking -> independent checks. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for (const [alternate, budgetBlocked] of [[false, false], [true, false], [true, true]]) test(`authorized stage escalation changes capability requirements after recorded rework (alternate=${alternate}, budgetBlocked=${budgetBlocked})`, { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 90000 }, async () => {
 const env = { ...process.env, KODE_TEST_AUTOMATIC_SCENARIO: 'verification-rework', KODE_TEST_STAGE_ESCALATION: '1', KODE_TEST_STAGE_ESCALATION_BUDGET: budgetBlocked ? '1' : '0', KODE_TEST_STAGE_ESCALATION_ALTERNATE: alternate ? '1' : '0', KODE_TEST_HUMAN_ACCEPTANCE: '0' }; delete env.NODE_TEST_CONTEXT
 const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-automatic-workflow.js', import.meta.url))], { env, timeout: 85000, maxBuffer: 1024 * 1024 })
 assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/); assert.match(stdout, /skipped 0/)
})
