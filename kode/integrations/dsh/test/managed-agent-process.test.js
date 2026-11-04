import test from 'node:test'
import assert from 'node:assert/strict'
import { signalAgentProcess } from '../src/managed-agent-process.js'

test('a protected process group falls back to its owned live child', () => {
  const calls = [], child = { pid: 321, exitCode: null, signalCode: null, kill: signal => calls.push(signal) }
  signalAgentProcess(child, 'SIGKILL', { platform: 'darwin', killGroup: pid => { assert.equal(pid, -321); throw Object.assign(new Error('protected group'), { code: 'EPERM' }) } })
  assert.deepEqual(calls, ['SIGKILL'])
})

test('protected reaped groups and denied child signals cannot escape a cleanup timer', () => {
  const denied = () => { throw Object.assign(new Error('protected process'), { code: 'EPERM' }) }
  assert.doesNotThrow(() => signalAgentProcess({ pid: 321, exitCode: null, signalCode: null, kill: denied }, 'SIGKILL', { platform: 'darwin', killGroup: denied }))
  signalAgentProcess({ pid: 321, exitCode: 0, signalCode: null, kill: () => assert.fail('must not signal a reaped child') }, 'SIGKILL', { platform: 'darwin', killGroup: denied })
})
