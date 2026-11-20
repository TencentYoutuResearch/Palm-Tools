import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../src-tauri/', import.meta.url)
const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'))

test('native file drops use a Wry version that resolves modern Finder URLs', () => {
  const base = read('tauri.conf.json')
  const baseWindow = base.app.windows[0]
  const lock = readFileSync(new URL('../../../Cargo.lock', root), 'utf8')
  const wryVersion = lock.match(/\[\[package\]\]\r?\nname = "wry"\r?\nversion = "([^"]+)"/)?.[1]

  assert.equal(baseWindow.dragDropEnabled, true)
  assert.ok(wryVersion, 'Cargo.lock must contain the Wry package')
  const [major, minor, patch] = wryVersion.split('.').map(Number)
  assert.ok(
    major > 0 || minor > 57 || (minor === 57 && patch >= 3),
    `Wry ${wryVersion} cannot resolve Finder public.file-url drops`,
  )
})
