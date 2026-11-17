import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
test('real Hub role lifecycle covers admission retry, derived workspace and native CLI wire', { skip: !process.env.KODE_TEST_HUB_BIN, timeout: 120000 }, async () => {
  const env = { ...process.env, KODE_TEST_BACKEND_URL: 'disposable-fixture', KODE_TEST_ROLE_PROMPT: '1' }
  delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=spec', '--test-name-pattern=pump=(false|mandate|downstream), cli=false|pump=model-tools, cli=true',
    fileURLToPath(new URL('./fixture-official-assignment.js', import.meta.url))], { env, timeout: 115000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 4/); assert.match(stdout, /fail 0/)
})
