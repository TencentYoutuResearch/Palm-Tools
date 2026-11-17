/** Real DSH collection -> ClientEntries.start -> Cordis activation, without a server. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, cp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import * as cordis from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import * as zod from 'zod'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const id = '@kode/dsh-composer'
async function collect() {
  const host = new cordis.Context()
  await host.plugin(Loader, { baseUrl: import.meta.url })
  await host.loader.create({ name: new URL('../packages/composer/host.js', import.meta.url).href })
  await host.loader.await()
  await host.plugin(ClientModuleRegistry)
  await auditStartupEntries(host, 'composer-test', () => {})
  return host
}
async function activate(host, omitApply = false) {
  // UI rendering is covered by browser tests. Static UI seeds are inert here;
  // actual collection, lazy modules, ClientEntries, Loader, Cordis and audit run.
  const staticModules = {
    '@deepseek-ai/cordis': cordis, zod,
    react: { memo: value => value }, 'react/jsx-runtime': {}, 'react-dom': {},
    '@deepseek-ai/dsh-client-ui-primitives': {}, '@deepseek-ai/dsh-client-store': {}, '@deepseek-ai/dsh-client-ui-slots': {},
  }
  const registrationTarget = { mode: 'queue', pendingQueue: [], load(value) { this.pendingQueue.push(value) } }
  const sandbox = vm.createContext({ window: { __ModuleLoader__: registrationTarget }, console, setTimeout, clearTimeout, URL, TextEncoder })
  const bootstrapSource = await readFile(require.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8')
  vm.runInContext(bootstrapSource, sandbox)
  const bootstrap = registrationTarget.pendingQueue.shift()
  const api = bootstrap.factory(name => staticModules[name])
  const system = api.createClientModuleSystem(registrationTarget, { id: bootstrap.id, exports: api }, {
    boot: host.clientModules.graph(), staticModules,
    async loadBundle(url) {
      const response = await host.clientModules.fetchBundle(new Request(new URL(url, 'https://fixture.example/')))
      assert.equal(response.status, 200)
      vm.runInContext(await response.text(), sandbox)
      if (omitApply) {
        // Reproduce the exact pre-fix shape while keeping the production transport.
        const original = system.factories.get(id)
        system.factories.set(id, { ...original, factory(require) { const { apply: _apply, ...components } = original.factory(require); return components } })
      }
    },
  })
  const client = new cordis.Context()
  await client.plugin(Loader, { baseUrl: 'https://fixture.example/' })
  client.loader.internal = system
  try {
    await system.entries.start(client.loader, system.manifest)
    await auditStartupEntries(client, 'composer-client-test', () => {})
    const entry = [...client.loader.entries()].find(entry => entry.options.name === id)
    assert.equal(entry?.fiber?.state, 2, 'composer must reach ACTIVE, not merely import')
    const exported = await system.import(id)
    assert.deepEqual(Object.keys(exported).sort(), ['PortableTextComposer', 'apply', 'portableComposerCapabilities'])
    assert.equal(exported.apply(), undefined)
    assert.equal(client.conversation, undefined)
    assert.equal(client.sessions, undefined)
    return entry.fiber.state
  } finally { await client.fiber.dispose() }
}

test('production collector serves composer and real ClientEntries activation passes audit', async () => {
  const host = await collect()
  try {
    assert.deepEqual(host.clientModules.graph().entries.map(row => row.id), [id])
    assert.equal(await activate(host), 2)
  } finally { await host.fiber.dispose() }
})

test('real ClientEntries rejects the historical component-only export shape', async () => {
  const host = await collect()
  try { await assert.rejects(activate(host, true), /invalid plugin/) }
  finally { await host.fiber.dispose() }
})

test('isolated bundle packaging includes composer with the actual bundled-dependency strategy', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'kode-composer-package-test-'))
  try {
    const packageRoot = join(stage, 'package')
    await mkdir(packageRoot)
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    // No backend build or daily installation: stage the existing package inputs.
    await cp(join(root, 'packages'), join(packageRoot, 'packages'), { recursive: true })
    await cp(join(root, 'cordis.patch.yml'), join(packageRoot, 'cordis.patch.yml'))
    manifest.bundledDependencies = []
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      if (!spec.startsWith('file:packages/')) continue
      await cp(join(packageRoot, spec.slice(5)), join(packageRoot, 'node_modules', name), { recursive: true })
      const local = JSON.parse(await readFile(join(packageRoot, spec.slice(5), 'package.json'), 'utf8'))
      manifest.dependencies[name] = local.version
      manifest.bundledDependencies.push(name)
    }
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
    const npm = join(dirname(process.execPath), 'npm')
    const packed = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--cache', join(stage, 'npm-cache'), '--pack-destination', stage], { cwd: packageRoot, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8' }))
    const archive = join(stage, packed[0].filename)
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.match(files, /package\/node_modules\/@kode\/dsh-composer\/client.js/)
    assert.match(files, /package\/node_modules\/@kode\/dsh-composer\/host.js/)
    assert.match(files, /package\/node_modules\/@kode\/dsh-composer\/upstream-lock.json/)
    const client = execFileSync('tar', ['-xOzf', archive, 'package/node_modules/@kode/dsh-composer/client.js'])
    assert.deepEqual(client, await readFile(join(root, 'packages/composer/client.js')))
    const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex')
    console.log(`isolated composer archive sha256=${archiveHash}; bytes=${(await readFile(archive)).length}; composer client byte-identical`)
  } finally { await rm(stage, { recursive: true, force: true }) }
})


test('extracted CSS never suppresses a different official conversation build', async () => {
  const source = await readFile(join(root, 'packages/composer/client.js'), 'utf8')
  const blocks = [...source.matchAll(/var (css[\w$]*) = [^\n]+;\nvar (tagId[\w$]*) = [^\n]+;\nif \(typeof document[^\n]+\) \{\n[\s\S]*?document.head.appendChild\(tag\);\n\}/g)].map(match => match[0])
  assert.equal(blocks.length, 10, 'all pinned CSS injections must be covered')
  const officialId = '@deepseek-ai/dsh-client-ui-conversation/ConversationRoot.module.css'
  for (const officialFirst of [false, true]) {
    const styles = officialFirst ? [{dataset:{pluginCss:officialId},textContent:'.kiGsTW_root{display:flex}'}] : []
    const document = {
      querySelector(selector) { return styles.find(tag => selector === `style[data-plugin-css="${tag.dataset.pluginCss}"]`) ?? null },
      createElement() { return {dataset:{}} }, head:{appendChild(tag) {styles.push(tag)}},
    }
    vm.runInNewContext(blocks.join('\n'), {document})
    const extracted = styles.filter(tag => tag.dataset.pluginCss !== officialId)
    assert.equal(extracted.length, 10)
    assert.ok(extracted.every(tag => tag.dataset.pluginCss.startsWith('@kode/dsh-composer/')))
    assert.ok(extracted.some(tag => tag.textContent.includes('.wSkVaW_root')))
    if (!officialFirst) {
      assert.equal(document.querySelector(`style[data-plugin-css="${officialId}"]`), null)
      document.head.appendChild({dataset:{pluginCss:officialId},textContent:'.kiGsTW_root{display:flex}'})
    }
    assert.equal(styles.find(tag => tag.dataset.pluginCss === officialId).textContent, '.kiGsTW_root{display:flex}')
  }
})
