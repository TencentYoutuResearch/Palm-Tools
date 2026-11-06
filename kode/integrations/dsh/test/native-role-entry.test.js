/** Real installed CLI, owned inference responses and normal Home workflow entry points. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

for (const role of ['builder', 'coordinator']) test(`installed native ${role} runs through Home with owned model responses`, {
  skip: !process.env.KODE_TEST_BACKEND_URL || !process.env.KODE_TEST_HOST_NODE
    || !process.env.KODE_TEST_MANAGED_CODEX_EXECUTABLE,
  timeout: 125000,
}, async t => {
  const env = { ...process.env, KODE_TEST_NATIVE_BUILDER: role === 'builder' ? '1' : '0',
    KODE_TEST_NATIVE_COORDINATOR: role === 'coordinator' ? '1' : '0',
    KODE_TEST_LIVE_WORKER: '0', KODE_TEST_NATIVE_ANSWER: '0', KODE_TEST_REMOTE_ANSWER: '0' }
  delete env.NODE_TEST_CONTEXT
  const fixture = role === 'builder' ? 'fixture-official-builder-tools.js' : 'fixture-coordinator-pipeline.js'
  const { stdout } = await promisify(execFile)(process.env.KODE_TEST_HOST_NODE,
    ['--test', '--test-reporter=spec', fileURLToPath(new URL(fixture, import.meta.url))],
    { env, timeout: 120000, maxBuffer: 1024 * 1024 })
  assert.match(stdout, role === 'builder' ? /pass 2/ : /pass 1/)
  assert.match(stdout, /fail 0/)
  assert.match(stdout, /skipped 0/)
  t.diagnostic(stdout.trim())
})
