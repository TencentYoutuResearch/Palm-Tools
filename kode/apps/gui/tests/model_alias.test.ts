import assert from 'node:assert/strict'
import test from 'node:test'

import { compactModelName } from '../src/lib/model_alias.ts'

test('compacts Cursor Grok model names to family and version', () => {
  assert.equal(compactModelName('grok-4.6'), 'Grok 4.6')
})

test('keeps unknown routed model labels within the compact chip width', () => {
  assert.equal(compactModelName('cursor-provider/deployment-model-very-long'), 'cursor-provider/d…')
})
