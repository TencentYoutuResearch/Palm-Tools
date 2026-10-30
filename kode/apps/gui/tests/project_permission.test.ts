import assert from 'node:assert/strict'
import test from 'node:test'

import { rememberBypass, rememberedBypass } from '../src/lib/project_permission.ts'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

test('remembers bypass per path and ignores trailing slashes', () => {
  const storage = memoryStorage()
  assert.equal(rememberedBypass('/work/app', storage), false)
  rememberBypass('/work/app/', true, storage)
  assert.equal(rememberedBypass('/work/app', storage), true)
  assert.equal(rememberedBypass('/work/other', storage), false)
})

test('starting without bypass forgets the path', () => {
  const storage = memoryStorage()
  rememberBypass('/work/app', true, storage)
  rememberBypass('/work/app', false, storage)
  assert.equal(rememberedBypass('/work/app', storage), false)
})

test('tolerates missing storage, empty cwd and corrupt data', () => {
  assert.equal(rememberedBypass('/work/app', null), false)
  const storage = memoryStorage()
  rememberBypass('  ', true, storage)
  assert.equal(rememberedBypass('', storage), false)
  storage.setItem('kode.chooser.bypassProjects', 'not json')
  assert.equal(rememberedBypass('/work/app', storage), false)
})
