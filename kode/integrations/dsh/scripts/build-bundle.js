/** Build a platform-specific npm package containing the matching Kode backend. */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
}
const nativeTarget = process.platform === 'darwin'
  ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
  : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
const value = process.argv.indexOf('--target')
const rustTarget = value < 0 ? nativeTarget : process.argv[value + 1]
const platform = Object.entries(targets).find(([, target]) => target === rustTarget)?.[0]
if (!platform) throw new Error(`Unsupported bundle target: ${rustTarget}`)

function run(command, args, { capture = false, cwd = root } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      shell: false,
    })
    let output = ''
    child.stdout?.on('data', bytes => { output += bytes })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolveRun(output)
      : reject(new Error(`${command} exited ${code}`)))
  })
}

await run(process.execPath, [join(root, 'scripts/build-remote.js'), '--target', rustTarget])
const destination = join(root, 'dist')
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
const staging = await mkdtemp(join(tmpdir(), 'kode-dsh-bundle-'))
const packageRoot = join(staging, 'package')
const includedRoots = new Set(['assets', 'packages', 'scripts', 'src'])
try {
  await cp(root, packageRoot, {
    recursive: true,
    filter(source) {
      const path = relative(root, source).split(sep).join('/')
      if (!path) return true
      if (path.startsWith('assets/remote')) {
        return path === 'assets/remote'
          || path === 'assets/remote/.npmignore'
          || path.startsWith(`assets/remote/${platform}`)
      }
      const first = path.split('/')[0]
      if (includedRoots.has(first)) return true
      return ['README.md', 'cordis.patch.yml', 'cordis.remote.patch.yml', 'package.json'].includes(path)
    },
  })
  // pnpm resolves file: dependencies relative to the installing profile. Ship
  // the private UI packages as bundled dependencies instead of local links.
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.bundledDependencies = []
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    if (!spec.startsWith('file:packages/')) continue
    await cp(join(packageRoot, spec.slice(5)), join(packageRoot, 'node_modules', name), { recursive: true })
    const bundled = JSON.parse(await readFile(join(packageRoot, spec.slice(5), 'package.json'), 'utf8'))
    manifest.dependencies[name] = bundled.version
    manifest.bundledDependencies.push(name)
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const packed = JSON.parse(await run('npm', ['pack', '--json', '--pack-destination', destination], {
    capture: true,
    cwd: packageRoot,
  }))
  const source = join(destination, packed[0].filename)
  const archive = join(destination, `${basename(source, '.tgz')}-${platform}.tgz`)
  await rename(source, archive)
  process.stdout.write(`Kode dsh bundle: ${archive}\n`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
