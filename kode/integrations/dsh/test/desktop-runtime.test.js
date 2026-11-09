import test from 'node:test'
import assert from 'node:assert/strict'
import { findDevelopmentRuntime } from '../src/desktop-runtime.js'
const hash = 'a'.repeat(64), cache = '/fixture/native-notifications'
const old = `${cache}/preparing.old/Electron.app/Contents/MacOS/Electron`
const target = `${cache}/dsh-development-v2-${hash}/Electron.app`
function fixture(overrides = {}) {
  return { readDirectory: () => [hash, 'preparing.old'], realpath: () => old,
    identifier: path => path === target ? 'com.deepseek.dsh.development' : 'com.github.Electron', verify: () => {}, ...overrides }
}
test('old cached shell migrates only to its paired, identified and verified runtime', () => {
  let verified
  assert.equal(findDevelopmentRuntime(old, fixture({ verify: path => { verified = path } })), target + '/Contents/MacOS/Electron')
  assert.equal(verified, target)
  for (const io of [fixture({ identifier: () => 'com.github.Electron' }), fixture({ verify: () => { throw Error('Invalid signature') } }), fixture({ realpath: path => path })]) assert.equal(findDevelopmentRuntime(old, io), null)
})
test('identified runtimes and packaged applications never relaunch or loop', () => {
  assert.equal(findDevelopmentRuntime(target + '/Contents/MacOS/Electron', fixture({ identifier: () => 'com.deepseek.dsh.development' })), null)
  assert.equal(findDevelopmentRuntime('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', fixture({ readDirectory: () => assert.fail('must not inspect production runtimes') })), null)
})
