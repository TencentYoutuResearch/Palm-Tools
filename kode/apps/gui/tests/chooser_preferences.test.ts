import assert from 'node:assert/strict'
import test from 'node:test'
import { rememberedSelection, rememberSelection, sameEndpoint } from '../src/lib/chooser_preferences.ts'

function storage(initial: string | null = null) {
  let value = initial
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next } }
}

test('remembers the last successful selection across chooser instances without resuming it', () => {
  const store = storage()
  const selection = { backendKey: 'agent', cwd: '/workspace/project', model: 'custom-model',
    endpointId: { kind: 'remote' as const, id: 'remote-one' }, resumeSessionId: 'old-session' }
  rememberSelection(selection, store)
  assert.deepEqual(rememberedSelection(store), {
    backendKey: 'agent', cwd: '/workspace/project', model: 'custom-model',
    endpointId: { kind: 'remote', id: 'remote-one' },
  })
  rememberSelection({ backendKey: 'other', cwd: '/workspace/other', endpointId: { kind: 'local' } }, store)
  assert.equal(rememberedSelection(store)?.model, undefined)
  assert.equal(rememberedSelection(store)?.backendKey, 'other')
})

test('missing, corrupt or inaccessible storage falls back to no selection', () => {
  for (const value of [null, 'invalid', '{}', '{"backendKey":"agent","cwd":"/work","endpointId":{"kind":"remote"}}']) {
    assert.equal(rememberedSelection(storage(value)), null)
  }
  const unavailable = { getItem: () => { throw Error('unavailable') }, setItem: () => { throw Error('unavailable') } }
  assert.equal(rememberedSelection(unavailable), null)
  assert.doesNotThrow(() => rememberSelection({ backendKey: 'agent', cwd: '/work', endpointId: { kind: 'local' } }, unavailable))
})

test('workspace endpoint matching isolates local and different remote nodes', () => {
  assert.equal(sameEndpoint({ kind: 'local' }, { kind: 'local' }), true)
  assert.equal(sameEndpoint({ kind: 'local' }, { kind: 'remote', id: 'a' }), false)
  assert.equal(sameEndpoint({ kind: 'remote', id: 'a' }, { kind: 'remote', id: 'b' }), false)
  assert.equal(sameEndpoint({ kind: 'remote', id: 'a' }, { kind: 'remote', id: 'a' }), true)
})
