import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
for (const scenario of ['pipeline', 'cancel-busy', 'cancel-tool', 'takeover-tool', 'question']) test(`remote official Worker home lifecycle across retries (scenario=${scenario})`, { skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE, timeout: scenario === 'takeover-tool' ? 1815000 : 915000 }, async () => {
  const env = { ...process.env, KODE_TEST_REMOTE_SCENARIO: scenario }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, ['--test', '--test-reporter=spec', fileURLToPath(new URL('./fixture-remote-official-dispatch.js', import.meta.url))], { env, timeout: scenario === 'takeover-tool' ? 1810000 : 910000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/)
})
