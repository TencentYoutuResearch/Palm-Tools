import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedHub } from './support/isolated-hub.js'
test('native handoff uses a real disposable Hub and original Host mailbox once', { skip: !process.env.KODE_TEST_HUB_BIN, timeout: 90000 }, async () => {
  const hub = await isolatedHub('native-handoff-fixture')
  try {
    const env = { ...process.env, KODE_TEST_BACKEND_URL: hub.url, KODE_TEST_TOKEN_FILE: join(hub.root, 'admin.token') }; delete env.NODE_TEST_CONTEXT
    const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=spec', '--test-name-pattern=real backend dispatches an idempotent handoff',
      fileURLToPath(new URL('./agent-hub.test.js', import.meta.url))], { env, timeout: 85000, maxBuffer: 1024 * 1024 })
    assert.match(stdout, /pass 1/); assert.match(stdout, /fail 0/)
  } finally { await hub.close() }
})
