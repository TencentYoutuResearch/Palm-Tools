import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../packages/collab/discussion-ui.js', import.meta.url), 'utf8')
const expression = source.match(/const wanted=(.*?);requestedTab=null/)?.[1]
assert.ok(expression, 'Main selection effect must resolve the requested tab')
const wanted = (requestedTab, selected) => vm.runInNewContext(`(${expression})`, { requestedTab, selected })

test('first Orbit entry with no selection or requested tab falls back to discussion without crashing', () => {
  assert.doesNotThrow(() => wanted(null, null))
  assert.equal(wanted(null, null), 'discussion')
  assert.equal(wanted({ surfaceId: 'surface', tab: 'settings' }, null), 'discussion')
  assert.equal(wanted(null, { surface: { id: 'surface' } }), 'discussion')
  assert.equal(wanted({ surfaceId: 'other', tab: 'settings' }, { surface: { id: 'surface' } }), 'discussion')
  assert.equal(wanted({ surfaceId: 'surface', tab: 'settings' }, { surface: { id: 'surface' } }), 'settings')
})
