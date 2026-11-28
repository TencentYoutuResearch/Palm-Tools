import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import { join } from 'node:path'
const source = await readFile(new URL('../kode-extension/bin/start.mjs', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('async function ensurePlugin('), source.indexOf('function serve()'))
function fixture(saved, installed = true, fail = () => false) {
  const files = new Map([['/extension/vendor/kode-dsh.tgz', 'archive'], ['/data/plugin.stamp', saved]])
  if (installed) files.set('/home/profiles/kode/node_modules/@kode/dsh/package.json', '{}')
  const calls = []
  const fn = compileFunction(`${body}; return ensurePlugin`, ['join', 'here', 'data', 'dshHome', 'PROFILE', 'dshVersion', 'existsSync', 'readFile', 'createHash', 'progress', 'log', 'mkdir', 'copyFile', 'run', 'writeFile', 'rename', 'rm', 'fail'])(
    join, '/extension', '/data', '/home', 'kode', 'new', p => files.has(p), async p => files.get(p),
    () => ({ update: () => ({ digest: () => 'hash' }) }), () => {}, () => {}, async () => {}, async () => {},
    (_command, args) => {
      const mode = args.includes('--offline') ? 'offline' : 'online'
      calls.push(mode)
      if (fail(mode)) throw new Error('install failed')
    },
    async (p, v) => files.set(p, v), async (a, b) => { files.set(b, files.get(a)); files.delete(a) },
    async p => files.delete(p), message => { throw new Error(message) },
  )
  return { fn, calls, files }
}
test('runtime upgrade and legacy stamps reinstall the integration', async () => {
  for (const stamp of ['hash', 'old:hash']) {
    const f = fixture(stamp); await f.fn('dsh')
    assert.deepEqual(f.calls, ['offline'])
    assert.equal(f.files.get('/data/plugin.stamp'), 'new:hash\n')
  }
})
test('matching stamp skips only an existing installation', async () => {
  for (const installed of [true, false]) {
    const f = fixture('new:hash', installed); await f.fn('dsh')
    assert.deepEqual(f.calls, installed ? [] : ['online'])
  }
})
test('an update missing cached dependencies falls back to the online install', async () => {
  const f = fixture('new:old-hash', true, mode => mode === 'offline')
  await f.fn('dsh')
  assert.deepEqual(f.calls, ['offline', 'online'])
  assert.equal(f.files.get('/data/plugin.stamp'), 'new:hash\n')
})
test('failed install leaves no success stamp and can retry', async () => {
  const f = fixture('old:hash', true, () => true)
  await assert.rejects(f.fn('dsh'), /install failed/)
  assert.deepEqual(f.calls, ['offline', 'online'])
  assert.equal(f.files.has('/data/plugin.stamp'), false)
})

test('start.mjs allows fallbackNode bootstrap on Node 18..24.8 instead of hard-failing', () => {
  assert.doesNotMatch(
    source,
    /if \(major < 24 \|\| \(major === 24 && minor < 9\)\) fail\(/,
    'start.mjs must not reject Node < 24.9 when fallbackNode can be installed',
  )
  assert.match(source, /--engine-strict=false/)
})

test('Node 22.23.2 can bootstrap the extension', () => {
  const launcher = fileURLToPath(new URL('../kode-extension/bin/start.mjs', import.meta.url))
  const script = `Object.defineProperty(process.versions, 'node', { value: '22.23.2' }); import(process.argv[1])`
  const env = { ...process.env }
  delete env.KODE_WORKBENCH_CONNECTION
  const result = spawnSync(process.execPath, ['-e', script, launcher], { env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Kode did not pass KODE_WORKBENCH_CONNECTION/)
})
