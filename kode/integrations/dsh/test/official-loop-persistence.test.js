/** Native persistence libraries run in the owned fixture runtime, not the hardened desktop binary. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
test('actual official loop restores zstd session history before a new authorized operation', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE,
  timeout: 30000,
}, async () => {
  const env = { ...process.env, KODE_TEST_OFFICIAL_PERSISTENCE: '1' }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await exec(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec', fileURLToPath(new URL('./official-loop.test.js', import.meta.url))], {
    env, timeout: 25000, maxBuffer: 128 * 1024,
  })
  assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/)
})
