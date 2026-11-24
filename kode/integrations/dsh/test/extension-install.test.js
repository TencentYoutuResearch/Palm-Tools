import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compileFunction } from 'node:vm'
import { join } from 'node:path'
const source = await readFile(new URL('../kode-extension/bin/start.mjs', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('async function ensurePlugin('), source.indexOf('function serve()'))
function fixture(saved, installed = true, failure = false) {
  const files = new Map([['/extension/vendor/kode-dsh.tgz', 'archive'], ['/data/plugin.stamp', saved]])
  if (installed) files.set('/home/profiles/kode/node_modules/@kode/dsh/package.json', '{}')
  const calls = []
  const fn = compileFunction(`${body}; return ensurePlugin`, ['join', 'here', 'data', 'dshHome', 'PROFILE', 'dshVersion', 'existsSync', 'readFile', 'createHash', 'progress', 'log', 'mkdir', 'copyFile', 'run', 'writeFile', 'rename', 'rm', 'fail'])(
    join, '/extension', '/data', '/home', 'kode', 'new', p => files.has(p), async p => files.get(p),
    () => ({ update: () => ({ digest: () => 'hash' }) }), () => {}, () => {}, async () => {}, async () => {},
    () => { calls.push('install'); if (failure) throw new Error('install failed') },
    async (p, v) => files.set(p, v), async (a, b) => { files.set(b, files.get(a)); files.delete(a) },
    async p => files.delete(p), message => { throw new Error(message) },
  )
  return { fn, calls, files }
}
test('runtime upgrade and legacy stamps reinstall the integration', async () => {
  for (const stamp of ['hash', 'old:hash']) {
    const f = fixture(stamp); await f.fn('dsh')
    assert.equal(f.calls.length, 1)
    assert.equal(f.files.get('/data/plugin.stamp'), 'new:hash\n')
  }
})
test('matching stamp skips only an existing installation', async () => {
  for (const installed of [true, false]) {
    const f = fixture('new:hash', installed); await f.fn('dsh')
    assert.equal(f.calls.length, installed ? 0 : 1)
  }
})
test('failed install leaves no success stamp and can retry', async () => {
  const f = fixture('old:hash', true, true)
  await assert.rejects(f.fn('dsh'), /install failed/)
  assert.equal(f.files.has('/data/plugin.stamp'), false)
})
