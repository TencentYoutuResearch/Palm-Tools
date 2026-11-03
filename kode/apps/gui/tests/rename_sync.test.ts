import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTabRename, shouldSyncTitleToBackend } from '../src/lib/rename_sync.ts'

test('only local (or unspecified) endpoints sync the title to the backend', () => {
  assert.equal(shouldSyncTitleToBackend(undefined), true)
  assert.equal(shouldSyncTitleToBackend(null), true)
  assert.equal(shouldSyncTitleToBackend({ kind: 'local' }), true)
  assert.equal(shouldSyncTitleToBackend({ kind: 'remote', id: 'ep1' }), false)
})

test('local rename updates the tab store and then calls set_title', async () => {
  const calls: string[] = []
  const ok = await applyTabRename(7, { kind: 'local' }, '新名字', {
    renameTab: (id, t) => calls.push(`rename:${id}:${t}`),
    setTitle: async (id, t) => { calls.push(`set:${id}:${t}`) },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, ['rename:7:新名字', 'set:7:新名字'])
})

test('remote rename only updates the tab store', async () => {
  const calls: string[] = []
  const ok = await applyTabRename(7, { kind: 'remote', id: 'ep1' }, 'x', {
    renameTab: (id, t) => calls.push(`rename:${id}:${t}`),
    setTitle: async () => { calls.push('set') },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, ['rename:7:x'])
})

test('backend failure keeps the optimistic rename and reports false', async () => {
  const calls: string[] = []
  const origError = console.error
  console.error = () => {}
  try {
    const ok = await applyTabRename(3, undefined, 'y', {
      renameTab: (id, t) => calls.push(`rename:${id}:${t}`),
      setTitle: async () => { throw new Error('no session 3') },
    })
    assert.equal(ok, false)
    assert.deepEqual(calls, ['rename:3:y'])
  } finally {
    console.error = origError
  }
})
