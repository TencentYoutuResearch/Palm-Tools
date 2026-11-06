/** Run actual Builder tools and workspace locks in the isolated native-capable runtime. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

test('native Builder official loop, scoped tools and durable accounting', {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE,
  // Two sequential native cases each retain their own 60-second deadline.
  timeout: 135000,
}, async () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE, [
    '--test', '--test-reporter=spec',
    fileURLToPath(new URL('./fixture-official-builder-tools.js', import.meta.url)),
  ], { env, timeout: 130000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, /pass 2/)
  assert.match(stdout, /fail 0/)
  assert.match(stdout, /skipped 0/)
})
