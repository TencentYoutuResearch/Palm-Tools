#!/usr/bin/env node
/**
 * kode-new-ui backend: runs `dsh web` with the @kode/dsh integration and
 * reports its private URL to Kode.
 *
 * Kode extension backend contract (kode.extension/v1):
 * - print exactly one `{"type":"kode.extension.ready",...}` line on stdout;
 * - exit when stdin reaches EOF (Kode closed or disabled the extension).
 * Everything else goes to stderr, which Kode shows in Settings → Extensions.
 *
 * State lives in $KODE_EXTENSION_DATA:
 * - runtime/   pinned @deepseek-ai/dsh install
 * - dsh-home/  DSH_HOME with a private `kode` profile, so this never touches
 *              the user's own dsh profiles
 * - plugin.stamp  which vendored @kode/dsh build is installed
 *
 * @kode/dsh joins the Kode workbench service named by
 * $KODE_WORKBENCH_CONNECTION, which Kode passes because the manifest asks for
 * the `workbench` capability.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withInstallLock } from './install-lock.mjs'

const PROFILE = 'kode'
const here = resolve(fileURLToPath(new URL('..', import.meta.url)))
const data = process.env.KODE_EXTENSION_DATA ?? join(here, '.data')
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
const dshVersion = process.env.KODE_NEW_UI_DSH_VERSION ?? pkg.kodeNewUi.dsh
const log = (...parts) => console.error('[kode-new-ui]', ...parts)
// Kode shows these while the user waits for the view.
const STEPS = 4
const progress = (step, message) => process.stdout.write(JSON.stringify({ type: 'kode.extension.progress', step, total: STEPS, message }) + '\n')

const [major, minor, patch] = process.versions.node.split('.').map(Number)
const fallbackNode = pkg.kodeNewUi?.fallbackNode
if (major < 18) fail(`dsh launcher needs Node.js >= 18 (or >= 24.9 directly), found ${process.version}`)
if (!fallbackNode && (major < 24 || (major === 24 && minor < 9))) {
  fail(`dsh needs Node.js >= 24.9, found ${process.version}`)
}
if (!process.env.KODE_WORKBENCH_CONNECTION) fail('Kode did not pass KODE_WORKBENCH_CONNECTION')

const runtime = join(data, 'runtime')
const dshHome = join(data, 'dsh-home')
// CI keeps pnpm (driven by `dsh plugin`) from waiting on interactive prompts.
const env = { ...process.env, DSH_HOME: dshHome, CI: '1' }
// @kode/dsh only auto-joins the Kode workbench when it owns no private home.
delete env.KODE_DSH_HOME
delete env.KODE_BRIDGE_TOKEN

const dsh = await withInstallLock(data, async () => {
  await ensureNode()
  await mkdir(runtime, { recursive: true })
  const bin = await ensureDsh()
  await ensureProfile(bin)
  await ensurePlugin(bin)
  return bin
}, { onWait: () => progress(1, '正在等待另一个 Kode 进程完成 dsh 安装') })
serve()

async function readPackageVersion(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf8')).version ?? null
  } catch {
    return null
  }
}

async function ensureNode() {
  // The launcher can run on an older Node (e.g. Node 18/20/22/24.0-24.22.2)
  // than the pinned dsh runtime; download the private Node 24 binary when needed.
  const supportsDshNode = (major === 24 && (minor > 22 || (minor === 22 && patch >= 3)))
    || (major === 26 && (minor > 13 || (minor === 13 && patch >= 1))) || major > 26
  if (fallbackNode && !supportsDshNode) {
    const nodeHome = join(data, 'node-24')
    const nodeBin = join(nodeHome, 'node_modules', 'node', 'bin')
    const nodeManifest = join(nodeHome, 'node_modules', 'node', 'package.json')
    const executable = process.platform === 'win32' ? 'node.exe' : 'node'
    if (!existsSync(join(nodeBin, executable)) || (await readPackageVersion(nodeManifest)) !== fallbackNode) {
      progress(1, `正在安装 dsh 专用 Node.js ${fallbackNode}`)
      log(`current Node.js is ${process.version}; installing private node@${fallbackNode} into ${nodeHome}`)
      await mkdir(nodeHome, { recursive: true })
      run('npm', ['install', '--no-audit', '--no-fund', '--engine-strict=false', '--prefix', nodeHome, `node@${fallbackNode}`])
    }
    env.PATH = [nodeBin, env.PATH].filter(Boolean).join(delimiter)
  } else {
    env.PATH = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter)
  }
}

async function ensureDsh() {
  const bin = join(runtime, 'node_modules/.bin/dsh')
  const installed = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')
  const current = await readPackageVersion(installed)
  if (current !== dshVersion || !existsSync(bin) || !existsSync(join(runtime, 'install.complete'))) {
    await rm(join(runtime, 'install.complete'), { force: true })
    await rm(join(data, 'plugin.stamp'), { force: true })
    progress(1, `正在安装 dsh ${dshVersion} 运行环境（仅首次，约 1–3 分钟）`)
    log(`installing @deepseek-ai/dsh@${dshVersion} (first start can take a few minutes)`)
    if (!existsSync(join(runtime, 'package.json'))) await writeFile(join(runtime, 'package.json'), '{"private":true}\n')
    run('npm', ['install', '--no-audit', '--no-fund', '--engine-strict=false', '--prefix', runtime, `@deepseek-ai/dsh@${dshVersion}`])
    await writeFile(join(runtime, 'install.complete'), dshVersion + '\n')
  }
  return bin
}

async function ensureProfile(dsh) {
  if (existsSync(join(dshHome, 'profiles', PROFILE, 'cordis.yml'))) return
  progress(2, '正在创建 dsh 配置')
  log(`creating dsh profile ${PROFILE}`)
  run(dsh, ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { quiet: true })
}

async function ensurePlugin(dsh) {
  const tgz = join(here, 'vendor/kode-dsh.tgz')
  if (!existsSync(tgz)) fail('vendor/kode-dsh.tgz is missing; run `npm run build:kode-extension (in integrations/dsh)`')
  const stamp = createHash('sha256').update(await readFile(tgz)).digest('hex')
  const stampFile = join(data, 'plugin.stamp')
  const installStamp = `${dshVersion}:${stamp}`
  const pluginManifest = join(dshHome, 'profiles', PROFILE, 'node_modules', '@kode', 'dsh', 'package.json')
  if (existsSync(pluginManifest) && existsSync(stampFile) && (await readFile(stampFile, 'utf8')).trim() === installStamp) return
  await rm(stampFile, { force: true })
  progress(3, '正在安装 Kode 会话整合')
  log('installing the vendored @kode/dsh integration')
  // A new file name per build: pnpm does not reliably re-resolve a changed
  // tarball behind the same `file:` spec.
  const packages = join(data, 'packages')
  await mkdir(packages, { recursive: true })
  const copy = join(packages, `kode-dsh-${stamp.slice(0, 12)}.tgz`)
  await copyFile(tgz, copy)
  try {
    run(dsh, ['plugin', '--profile', PROFILE, 'add', copy])
  } catch (error) {
    const profileLock = join(dshHome, 'profiles', PROFILE, 'package.json.lock')
    if (existsSync(profileLock)) {
      log(`dsh profile 仍有写锁：${profileLock}。请确认其他 dsh 或 pnpm 安装已结束后重试。`)
    }
    throw error
  }
  await writeFile(stampFile + '.tmp', installStamp + '\n')
  await rename(stampFile + '.tmp', stampFile)
}

function serve() {
  progress(4, '正在启动 dsh')
  const child = spawn(dsh, ['--profile', PROFILE, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let ready = false
  let buffer = ''
  child.stdout.on('data', chunk => {
    process.stderr.write(chunk)
    if (ready) return
    buffer += chunk
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(buffer)
    if (!match) return
    ready = true
    buffer = ''
    process.stdout.write(JSON.stringify({ type: 'kode.extension.ready', protocol_version: 1, url: match[1] }) + '\n')
  })
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    child.kill('SIGINT')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  }
  // Kode holds our stdin open for its lifetime.
  process.stdin.on('end', stop)
  process.stdin.on('close', stop)
  process.stdin.resume()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
  child.on('error', error => { log(`dsh 启动失败：${error.message}`); process.exit(1) })
  child.on('exit', (code, signal) => {
    if (!stopping) log(`dsh exited (${signal ?? code})`)
    process.exit(stopping ? 0 : code ?? 1)
  })
}

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { env, stdio: ['ignore', quiet ? 'ignore' : process.stderr, process.stderr] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.signal ?? result.status}`)
}

function fail(message) {
  log(message)
  process.exit(1)
}
