import assert from 'node:assert/strict'
import test from 'node:test'

import { compactModelName } from '../src/lib/model_alias.ts'

test('compacts Cursor Grok model names to family and version', () => {
  assert.equal(compactModelName('grok-4.6'), 'Grok 4.6')
})

test('keeps unknown routed model labels within the compact chip width', () => {
  assert.equal(compactModelName('cursor-provider/deployment-model-very-long'), 'cursor-provider/d…')
})

test('compacts tclaude response model without inventing a version or context size', () => {
  assert.equal(compactModelName('deepseek/deepseek-flash'), 'DS Flash')
  assert.equal(compactModelName('deepseek/deepseek-v4.1-flash'), 'DS v4.1f')
  assert.equal(compactModelName('claude-deepseek-v4.1-flash[1m]'), 'DS v4.1f')
})
