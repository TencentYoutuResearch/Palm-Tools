/** Real Home/Host/Session durability, with an owned synthetic model and native protocol peer. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for (const missingUsage of [false, true]) test(`native Worker question is Home-owned, idempotent, private and restart-durable (usage missing=${missingUsage})`, {
 skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: 65000,
}, async () => {
 const env = { ...process.env, KODE_TEST_CLI_QUESTION: '1', KODE_TEST_QUESTION_NO_USAGE: missingUsage ? '1' : '0' }
 // Notification omission is implemented by the owned protocol peer. The installed
 // engine ignores that fixture variable and would emit its normal usage instead.
 if (missingUsage) delete env.KODE_TEST_MANAGED_CODEX_EXECUTABLE
 delete env.NODE_TEST_CONTEXT
 const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-name-pattern=cli=true', '--test-reporter=spec',
  fileURLToPath(new URL('./fixture-official-assignment.js', import.meta.url))], { env, timeout: 60000, maxBuffer: 1024 * 1024 })
 assert.match(stdout, /pass 1/)
 assert.match(stdout, /fail 0/)
})
