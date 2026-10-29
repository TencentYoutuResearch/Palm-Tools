import { constants } from 'node:fs'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

export function runtimePlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  throw new Error(`Kode backend bundle does not support ${platform}-${arch}`)
}

export function defaultNodeId(name = hostname()) {
  const id = String(name).toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '')
  return (id || 'kode-dsh').slice(0, 96)
}

function isLoopback(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  } catch {
    return false
  }
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return path
  } catch {
    return undefined
  }
}

export async function resolveBundledServer({
  root = pluginRoot,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const target = runtimePlatform(platform, arch)
  const name = platform === 'win32' ? 'kode-session-server.exe' : 'kode-session-server'
  const candidates = [
    join(root, 'assets', 'remote', target, name),
    join(root, '..', '..', 'target', 'release', name),
    join(root, '..', '..', 'target', 'debug', name),
  ]
  for (const candidate of candidates) {
    const found = await executable(candidate)
    if (found) return found
  }
}

async function ensurePrivateFile(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    await chmod(path, 0o600)
  }
}

export async function prepareRuntimeConfig(config = {}, options = {}) {
  const env = options.env ?? process.env
  const url = config.url ?? 'http://127.0.0.1:47870'
  const autoProvision = config.autoProvision !== false
    && isLoopback(url)
    && !config.tokenFile
    && !env.KODE_BRIDGE_TOKEN
  let tokenFile = config.tokenFile
  let serverConfig = config.serverConfig
  let serverCommand = config.serverCommand
  let stateFile = config.stateFile

  if (autoProvision) {
    const home = options.home ?? homedir()
    const dataDirectory = env.KODE_DSH_HOME || options.dataDirectory || join(home, '.config', 'kode', 'dsh')
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
    await chmod(dataDirectory, 0o700)

    tokenFile = join(dataDirectory, 'admin.token')
    await ensurePrivateFile(tokenFile, `${randomBytes(32).toString('hex')}\n`)
    if (!serverConfig) {
      serverConfig = join(dataDirectory, 'messaging.json')
      const value = {
        node_id: defaultNodeId(options.hostname),
        database: join(dataDirectory, 'messaging.sqlite'),
        peers: [],
      }
      await ensurePrivateFile(serverConfig, `${JSON.stringify(value, null, 2)}\n`)
    }
    if (!serverCommand) {
      serverCommand = await resolveBundledServer({
        root: options.root,
        platform: options.platform,
        arch: options.arch,
      })
    }
    if (!stateFile) stateFile = join(dataDirectory, 'owners.json')
  }

  return {
    ...config,
    url,
    tokenFile,
    serverConfig,
    serverCommand,
    stateFile,
  }
}
