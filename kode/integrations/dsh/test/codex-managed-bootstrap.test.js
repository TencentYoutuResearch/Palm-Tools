import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { bootstrapArguments, prepareManagedBootstrap, readManagedBootstrapReport } from '../src/codex-managed-bootstrap.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kode-bootstrap-quoted ' path-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, manifest: { executable: process.execPath, settings: ['features.shell_tool=false', 'model_provider="host"'],
    catalogPath: join(root, 'normalized.json'), reportPath: join(root, 'report.json') } }
}

test('bootstrap delegates engine discovery without opening a catalog or changing arguments', async t => {
  const { manifest } = await fixture(t)
  const args = ['--version', '--bundled']
  assert.deepEqual(await bootstrapArguments(manifest, args), args)
  await assert.rejects(stat(manifest.reportPath), { code: 'ENOENT' })
})

test('Host controls follow wrapper defaults even when no public catalog is supplied', async t => {
  const { manifest } = await fixture(t)
  const args = ['app-server', '-c', 'features.shell_tool=true']
  assert.deepEqual(await bootstrapArguments(manifest, args), [...args, '-c', 'features.shell_tool=false', '-c', 'model_provider="host"'])
  assert.deepEqual(JSON.parse(await readFile(manifest.reportPath, 'utf8')),
    { version: 1, source_hash: null, effective_hash: null, model_count: 0 })
})

test('public model catalog loses native patch declarations and preserves model capabilities and original bytes', async t => {
  const { root, manifest } = await fixture(t)
  const source = join(root, 'models.json')
  const original = JSON.stringify({ models: [{ slug: 'first', apply_patch_tool_type: 'freeform', supported_reasoning_levels: ['high'] },
    { slug: 'second', apply_patch_tool_type: 'function', context_window: 100000 }] })
  await writeFile(source, original)
  const args = await bootstrapArguments(manifest, ['app-server', '-c', `model_catalog_json=${JSON.stringify(source)}`])
  assert.equal(args.at(-1), `model_catalog_json=${JSON.stringify(manifest.catalogPath)}`)
  const effective = await readFile(manifest.catalogPath, 'utf8')
  assert.deepEqual(JSON.parse(effective).models, [{ slug: 'first', apply_patch_tool_type: null, supported_reasoning_levels: ['high'] },
    { slug: 'second', apply_patch_tool_type: null, context_window: 100000 }])
  assert.equal(await readFile(source, 'utf8'), original)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.deepEqual(JSON.parse(await readFile(manifest.reportPath, 'utf8')),
    { version: 1, source_hash: digest(original), effective_hash: digest(effective), model_count: 2 })
  assert.equal((await stat(manifest.catalogPath)).mode & 0o777, 0o600)
})

test('invalid public catalogs fail before producing effective controls or a report', async t => {
  const { root, manifest } = await fixture(t)
  const source = join(root, 'invalid.json')
  for (const content of ['{', '{"models":[]}', '{"models":[null]}', '{"models":[{}]}', ' '.repeat(8 * 1024 * 1024 + 1)]) {
    await writeFile(source, content)
    await assert.rejects(bootstrapArguments(manifest, ['app-server', '-c', `model_catalog_json=${JSON.stringify(source)}`]))
    await assert.rejects(stat(manifest.reportPath), { code: 'ENOENT' })
  }
})

test('generated launcher preserves executable discovery and quoted paths', async t => {
  const { root } = await fixture(t)
  const prepared = await prepareManagedBootstrap(root, { executable: process.execPath, pathVariable: 'FIXTURE_CODEX_PATH' }, [])
  assert.equal((await stat(prepared.env.FIXTURE_CODEX_PATH)).mode & 0o777, 0o700)
  const { stdout } = await promisify(execFile)(prepared.env.FIXTURE_CODEX_PATH, ['--version'])
  assert.equal(stdout.trim(), process.version)
  const isolated = await promisify(execFile)(prepared.env.FIXTURE_CODEX_PATH,
    ['--eval', 'console.log(JSON.stringify({home:process.env.HOME,codex:process.env.CODEX_HOME}))'],
    { env: { ...process.env, HOME: '/fixture/foreign-home', CODEX_HOME: '/fixture/foreign-config' } })
  assert.deepEqual(JSON.parse(isolated.stdout), { home: root, codex: join(root, 'codex') })
})

test('wrapper feature switches cannot reenable disabled Host features', async t => {
  const { manifest } = await fixture(t)
  for (const args of [['--enable', 'shell_tool'], ['--enable=shell_tool'], ['--enable', 'item_ids,shell_tool']]) {
    await assert.rejects(bootstrapArguments(manifest, ['app-server', ...args]), /overrides Host controls/)
  }
  await assert.rejects(stat(manifest.reportPath), { code: 'ENOENT' })
  assert.ok((await bootstrapArguments(manifest, ['app-server', '--enable', 'item_ids'])).includes('item_ids'))
})

test('bootstrap reports contain bounded immutable catalog hashes', async t => {
  const { manifest } = await fixture(t)
  await bootstrapArguments(manifest, ['app-server'])
  const { configuration: report } = await readManagedBootstrapReport(manifest.reportPath)
  assert.ok(Object.isFrozen(report))
  for (const value of [{ ...report, model_count: -1 }, { ...report, source_hash: 'invalid' },
    { ...report, model_count: 1, source_hash: 'f'.repeat(64), effective_hash: null }]) {
    await writeFile(manifest.reportPath, JSON.stringify(value))
    await assert.rejects(readManagedBootstrapReport(manifest.reportPath), /Invalid managed CLI bootstrap report/)
  }
})

test('wrapper transport reports expose origin and hashes in persisted configuration', async t => {
  const { manifest } = await fixture(t)
  manifest.provider = 'fixture'
  const args = ['app-server', 'model_providers.fixture={base_url="http://127.0.0.1:4567/private-route",http_headers={Authorization="fixture-private-value"}}']
  await bootstrapArguments(manifest, args)
  const state = await readManagedBootstrapReport(manifest.reportPath, 'fixture')
  assert.equal(state.endpoint.href, 'http://127.0.0.1:4567/private-route/responses')
  assert.equal(state.configuration.transport.origin, 'http://127.0.0.1:4567')
  assert.match(state.configuration.transport.endpoint_hash, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(state.configuration), /private-route|fixture-private-value/)
  await assert.rejects(readManagedBootstrapReport(manifest.reportPath, 'other'), /identity changed/)
  await assert.rejects(readManagedBootstrapReport(manifest.reportPath), /Unexpected managed wrapper transport/)
})
