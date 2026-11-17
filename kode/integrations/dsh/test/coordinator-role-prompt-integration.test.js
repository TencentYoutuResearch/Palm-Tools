import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for (const restore of [false, true]) test(`real Coordinator factory keeps its role and fixed procedure (restore=${restore})`, { skip: !process.env.KODE_TEST_HUB_BIN, timeout: 70000 }, async () => {
  const env = { ...process.env, KODE_TEST_BACKEND_URL: 'disposable-fixture', KODE_TEST_ROLE_PROMPT: '1', KODE_TEST_COORDINATOR_RESUME: restore ? '1' : '0' }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=spec',
    fileURLToPath(new URL('./fixture-official-coordinator.js', import.meta.url))], { env, timeout: 65000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/)
})
