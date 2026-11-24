/**
 * Build the Kode desktop extension (kode.new-ui) from this integration.
 *
 * Output: dist/kode-extension/ = kode-extension/ sources plus
 * vendor/kode-dsh.tgz, this package packed the way `build:bundle` does it
 * minus the remote SSH runtime assets (the desktop view only drives local
 * sessions through Kode's workbench service).
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
// Refuse mixed-version artifacts: all custom browser bundles must be rebuilt
// against the runtime shipped by the extension before packaging.
const expected = JSON.parse(await readFile(join(root, 'kode-extension/package.json'), 'utf8')).kodeNewUi.dsh
const actual = JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/dsh-client-connection/package.json'), 'utf8')).version
if (actual !== expected) throw new Error(`Build dependencies are ${actual}; install dsh ${expected} dependencies before packaging`)
const output = join(root, 'dist/kode-extension')
const staging = await mkdtemp(join(tmpdir(), 'kode-extension-'))
const packageRoot = join(staging, 'package')
const roots = new Set(['assets', 'packages', 'scripts', 'src'])
try {
  await cp(root, packageRoot, {
    recursive: true,
    filter(path) {
      const rel = relative(root, path).split(sep).join('/')
      if (!rel) return true
      if (rel.split('/').includes('node_modules')) return false
      // Remote hosts need per-platform Rust bundles; desktop views do not.
      if (rel.startsWith('assets/remote')) return rel === 'assets/remote'
      return roots.has(rel.split('/')[0]) || ['README.md', 'cordis.patch.yml', 'cordis.remote.patch.yml', 'package.json'].includes(rel)
    },
  })
  // pnpm resolves `file:` dependencies relative to the installing profile;
  // ship the private UI packages as bundled dependencies instead.
  const path = join(packageRoot, 'package.json')
  const pkg = JSON.parse(await readFile(path, 'utf8'))
  pkg.bundledDependencies = []
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (!spec.startsWith('file:packages/')) continue
    await cp(join(packageRoot, spec.slice(5)), join(packageRoot, 'node_modules', name), { recursive: true })
    pkg.dependencies[name] = JSON.parse(await readFile(join(packageRoot, spec.slice(5), 'package.json'), 'utf8')).version
    pkg.bundledDependencies.push(name)
  }
  await writeFile(path, JSON.stringify(pkg, null, 2) + '\n')
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', staging], { cwd: packageRoot, encoding: 'utf8' })
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`)
  const [{ filename }] = JSON.parse(packed.stdout)

  await rm(output, { recursive: true, force: true })
  await cp(join(root, 'kode-extension'), output, { recursive: true })
  await mkdir(join(output, 'vendor'), { recursive: true })
  await rename(join(staging, filename), join(output, 'vendor/kode-dsh.tgz'))
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  await writeFile(join(output, 'vendor/kode-dsh.json'), JSON.stringify({ version: pkg.version, commit }, null, 2) + '\n')
  console.log(`built ${relative(process.cwd(), output) || output} (@kode/dsh ${pkg.version}, ${commit.slice(0, 12)})`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
