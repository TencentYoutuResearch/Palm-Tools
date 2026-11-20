import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../src-tauri/', import.meta.url)
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'))

test('macOS disables only the native drag handler and keeps the base window shape', () => {
  const base = read('tauri.conf.json')
  const macos = read('tauri.macos.conf.json')
  const baseWindow = base.app.windows[0]
  const macWindow = macos.app.windows[0]

  assert.equal(baseWindow.dragDropEnabled, true)
  assert.equal(macWindow.dragDropEnabled, false)
  assert.deepEqual(
    { ...macWindow, dragDropEnabled: true },
    baseWindow,
  )
})
