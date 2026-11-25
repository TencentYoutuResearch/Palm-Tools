import assert from 'node:assert/strict'
import test from 'node:test'

import { terminalLinkActivationEnabled } from '../src/lib/terminal_links.ts'
import { terminalLinkTargets } from '../src/lib/terminal_path_links.ts'

test('desktop terminal links open with a direct click', () => {
  assert.equal(terminalLinkActivationEnabled({ metaKey: false, ctrlKey: false }), true)
  assert.equal(terminalLinkActivationEnabled({ metaKey: false, ctrlKey: true }), true)
})

test('link activation is platform independent', () => {
  assert.equal(terminalLinkActivationEnabled({ type: 'click' }), true)
})

test('missing mouse events never open a link', () => {
  assert.equal(terminalLinkActivationEnabled(undefined), false)
  assert.equal(terminalLinkActivationEnabled(null), false)
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
