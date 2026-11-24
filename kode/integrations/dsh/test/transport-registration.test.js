import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
test('transport registers under the profile package name', async () => {
  const pkg = JSON.parse(await readFile(new URL('../packages/transport/package.json', import.meta.url), 'utf8'))
  const source = await readFile(new URL('../packages/transport/client.js', import.meta.url), 'utf8')
  const registry = new Map()
  runInNewContext(source, { window: { __ModuleLoader__: { load: entry => registry.set(entry.id, entry.factory) } } })
  assert.equal(typeof registry.get(pkg.name), 'function')
})

test('Kode UI registers under the configured root package name', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const source = await readFile(new URL('../src/agent-client.js', import.meta.url), 'utf8')
  const registry = new Map()
  runInNewContext(source, { window: { __ModuleLoader__: { load: entry => registry.set(entry.id, entry.factory) } } })
  assert.equal(typeof registry.get(pkg.name), 'function')
})
