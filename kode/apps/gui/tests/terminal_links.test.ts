import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalLinkActivationEnabled } from '../src/lib/terminal_links.ts'
import { terminalLinkTargets } from '../src/lib/terminal_path_links.ts'

test('Windows terminal links open with a direct click', () => {
  assert.equal(terminalLinkActivationEnabled({ metaKey: false, ctrlKey: false }, true), true)
  assert.equal(terminalLinkActivationEnabled({ metaKey: false, ctrlKey: true }, true), true)
})

test('macOS terminal links keep Cmd+Click as the modifier', () => {
  assert.equal(terminalLinkActivationEnabled({ metaKey: true, ctrlKey: false }, false), true)
  assert.equal(terminalLinkActivationEnabled({ metaKey: false, ctrlKey: true }, false), false)
})

test('missing mouse modifiers never open a link', () => {
  assert.equal(terminalLinkActivationEnabled(undefined, true), false)
  assert.equal(terminalLinkActivationEnabled(null, false), false)
})

test('URLs stay whole links and are never split into path segments', () => {
  assert.deepEqual(terminalLinkTargets('https://example.com/a/b'), [{
    text: 'https://example.com/a/b',
    start: 0,
    end: 23,
    target: 'https://example.com/a/b',
    revealChild: null,
    activation: 'open',
  }])
})

test('line and column suffixes are excluded from the clickable file path', () => {
  const targets = terminalLinkTargets('/repo/src/file.ts:12:3')
  assert.equal(targets.at(-1)?.target, '/repo/src/file.ts')
  assert.equal(targets.at(-1)?.text, 'file.ts')
})
