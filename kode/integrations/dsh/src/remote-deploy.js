/** Owner-requested SSH deployment. Secrets stay on the Host; progress is public metadata only. */
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
export const DEPLOY_STEPS = ['connect', 'package', 'upload', 'runtime', 'dependencies', 'start', 'health', 'pair', 'save']
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
export function deploymentHost(input) {
  const host = String(input.host ?? '').trim(), name = String(input.name ?? '').trim(), port = Number(input.port || 22)
  if (!host || host.startsWith('-') || /[\s\x00-\x1f]/.test(host) || host.length > 255 || !name || name.length > 100) throw new Error('请输入主机名称和有效 SSH 地址。')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1–65535 之间。')
  const configFile = input.configFile ?? input.config_file
  if (configFile && (typeof configFile !== 'string' || /[\x00-\x1f]/.test(configFile))) throw new Error('无效 SSH 配置路径。')
  return { name, host, port, ...(configFile ? { config_file: configFile } : {}) }
}
export function sshArgs(host) {
  return [...(host.config_file ? ['-F', host.config_file] : []), '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-p', String(host.port), host.host]
}
export function runProcess(command, args, { input, signal, onLine, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    let stdout = '', stderr = '', pending = '', timer, forced, failure
    const stop = () => { failure ??= signal?.reason ?? new Error('部署超时。'); child.kill('SIGTERM'); forced ??= setTimeout(() => child.kill('SIGKILL'), 3000) }
    signal?.addEventListener('abort', stop, { once: true }); timer = setTimeout(stop, timeout)
    child.on('error', error => { failure = error })
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-65536); pending += chunk
      const lines = pending.split('\n'); pending = lines.pop()
      for (const line of lines) onLine?.(line)
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048) })
    child.stdin.on('error', () => {})
    child.on('close', code => {
      if (input?.destroy) input.destroy()
      clearTimeout(timer); clearTimeout(forced); signal?.removeEventListener('abort', stop)
      if (pending) onLine?.(pending)
      if (failure || code !== 0) reject(failure ?? new Error(stderr.trim() || `远端操作失败（${code}）。`))
      else resolve(stdout)
    })
    if (input?.pipe) { input.on('error', error => { failure = error; stop() }); input.pipe(child.stdin) }
    else child.stdin.end(input ?? '')
    if (signal?.aborted) stop()
  })
}

async function contentRevision(directory) {
  const hash = createHash('sha256')
  async function visit(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await visit(join(path, entry.name), name)
      else if (entry.isFile()) { hash.update(name); hash.update('\0'); hash.update(await readFile(join(path, entry.name))) }
      else throw new Error('部署安装包中包含不支持的符号链接。')
    }
  }
  await visit(directory); return hash.digest('hex')
}

async function binaryFor(platform, arch, name, config) {
  const target = `${platform}-${arch}`
  const rustTarget = { 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl', 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin' }[target]
  if (!rustTarget) throw new Error(`暂不支持远端系统 ${target}。`)
  const candidates = [
    ...(config.remoteArtifactsDirectory ? [join(config.remoteArtifactsDirectory, target, name)] : []),
    join(pluginRoot, 'assets/remote', target, name),
    resolve(pluginRoot, '../../target', rustTarget, 'release', name),
    ...(platform === process.platform && arch === process.arch ? [name === 'kode-session-server' ? config.serverCommand : config.sshTunnelCommand, resolve(pluginRoot, '../../target/debug', name)] : []),
  ].filter(path => path?.includes('/'))
  for (const path of candidates) { try { await access(path); return path } catch {} }
  throw new Error(`缺少 ${target} 的 Kode 服务安装包，请在本机运行 npm run build:remote -- --target ${rustTarget} 后重试。`)
}

/** Install only in a private managed directory; do not overwrite system Node or an existing dsh home. */
export function bootstrapScript(jobId, digest, request) {
  if (!/^[a-f0-9-]+$/.test(jobId) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid deployment identity')
  const data = Buffer.from(JSON.stringify(request)).toString('base64')
  return `set -eu
umask 077
base="$HOME/.local/share/kode/dsh-host"
stage="$base/staging/${jobId}"
cd "$stage"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum payload.tar.gz | cut -d' ' -f1); else actual=$(shasum -a 256 payload.tar.gz | cut -d' ' -f1); fi
[ "$actual" = '${digest}' ] || { echo '安装包校验失败。' >&2; exit 1; }
tar -xzf payload.tar.gz
printf '%s\\n' '{"step":"runtime","status":"running","message":"检查 Node.js 运行环境"}'
node_bin=$(command -v node || true)
if [ -z "$node_bin" ] || ! "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||a===24&&b>=9?0:1)' >/dev/null 2>&1; then
  node_bin="$base/node/bin/node"
  if [ ! -x "$node_bin" ]; then
    command -v curl >/dev/null 2>&1 || { echo '远端需要 curl 下载 Node.js。' >&2; exit 1; }
    case $(uname -s) in Linux) os=linux;; Darwin) os=darwin;; *) exit 1;; esac
    case $(uname -m) in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) exit 1;; esac
    name="node-v24.22.1-$os-$arch.tar.gz"
    curl -fsSL --connect-timeout 15 --max-time 300 --retry 2 "https://nodejs.org/dist/v24.22.1/$name" -o node.tar.gz
    curl -fsSL --connect-timeout 15 --max-time 60 --retry 2 https://nodejs.org/dist/v24.22.1/SHASUMS256.txt -o node-sha.txt
    expected=$(awk -v name="$name" '$2==name {print $1}' node-sha.txt)
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum node.tar.gz | cut -d' ' -f1); else actual=$(shasum -a 256 node.tar.gz | cut -d' ' -f1); fi
    [ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo 'Node.js 校验失败。' >&2; exit 1; }
    mkdir -p "$base/node"
    tar -xzf node.tar.gz --strip-components=1 -C "$base/node"
  fi
fi
"$node_bin" -e 'require("fs").writeFileSync("request.json",Buffer.from(process.argv[1],"base64"),{mode:384})' '${data}'
exec "$node_bin" ./install.mjs
`
}

export async function deployRemote(host, config, { signal, progress, run = runProcess } = {}) {
  const args = sshArgs(host), jobId = randomUUID(), local = await mkdtemp(join(tmpdir(), 'kode-host-package-'))
  let ready
  try {
    progress('connect', 'running', '连接 SSH 并检查远端系统')
    const probe = await run('ssh', [...args, 'printf "KODE_PLATFORM=%s:%s\\n" "$(uname -s)" "$(uname -m)"'], { signal, timeout: 20000 })
    const match = /KODE_PLATFORM=(Linux|Darwin):(x86_64|aarch64|arm64)/.exec(probe)
    if (!match) throw new Error('无法识别远端系统；目前支持 Linux 和 macOS。')
    const platform = match[1] === 'Linux' ? 'linux' : 'darwin', arch = match[2] === 'x86_64' ? 'x64' : 'arm64'
    progress('connect', 'done', 'SSH 连接正常')
    const node = await config.backendClient.call('/api/v1/messaging/node')
    if (!node.managed_peers) throw new Error('请先更新本机 Kode 服务，以支持自动配对 SSH 主机。')
    progress('package', 'running', '准备与远端系统匹配的服务和插件')
    const bundle = join(local, 'bundle'); await mkdir(join(bundle, 'bin'), { recursive: true }); await mkdir(join(bundle, 'plugin'))
    for (const name of ['kode-session-server', 'kode-ssh-tunnel']) await copyFile(await binaryFor(platform, arch, name, config), join(bundle, 'bin', name))
    const sourceArchive = join(local, 'plugin.tar.gz')
    await run('tar', ['-czf', sourceArchive, '--exclude=node_modules', '--exclude=assets/remote', '-C', pluginRoot, 'package.json', 'package-lock.json', 'src', 'assets', 'packages', 'scripts/build-remote.js', 'cordis.patch.yml', 'cordis.remote.patch.yml', 'README.md'], { signal })
    await run('tar', ['-xzf', sourceArchive, '-C', join(bundle, 'plugin')], { signal })
    await copyFile(new URL('./remote-install.mjs', import.meta.url), join(bundle, 'install.mjs'))
    const revision = await contentRevision(bundle)
    const payload = join(local, 'payload.tar.gz'); await run('tar', ['-czf', payload, '-C', bundle, '.'], { signal })
    const digest = createHash('sha256').update(await readFile(payload)).digest('hex')
    progress('package', 'done', '安装包已准备')
    progress('upload', 'running', '上传服务安装包')
    const stage = `"$HOME/.local/share/kode/dsh-host/staging/${jobId}"`
    await run('ssh', [...args, `umask 077; mkdir -p ${stage}; cat > ${stage}/payload.tar.gz`], { input: createReadStream(payload), signal })
    progress('upload', 'done', '安装包上传完成')
    const request = { localNode: node.node_id, linkToken: randomBytes(32).toString('hex'), revision, dshVersion: '0.2.1-rc.2' }
    await run('ssh', [...args, 'sh -s'], { input: bootstrapScript(jobId, digest, request), signal, timeout: 900000, onLine(line) {
      try {
        const event = JSON.parse(line)
        if (event.kind === 'ready') ready = event
        else if (DEPLOY_STEPS.includes(event.step) && ['running', 'done', 'failed'].includes(event.status)) progress(event.step, event.status, String(event.message ?? '').slice(0,300))
      } catch {}
    } })
    if (!ready?.token || !Number.isInteger(ready.webPort) || !Number.isInteger(ready.backendPort) || !/^[a-zA-Z0-9_.:-]+$/.test(ready.nodeId)) throw new Error('远端服务未返回有效的连接信息。')
    signal?.throwIfAborted()
    progress('pair', 'running', '配对本机和远端会话服务')
    await config.backendClient.call('/api/v1/messaging/workbench/peers', { node_id: ready.nodeId, link_token: ready.linkToken, url: null, ssh: { host: host.host, port: host.port, remote_port: ready.backendPort, config_file: host.config_file ?? null } }, signal)
    progress('pair', 'done', '会话服务已配对')
    return { ...host, managed: true, node_id: ready.nodeId, remote_port: ready.webPort, token: ready.token }
  } finally { await rm(local, { recursive: true, force: true }) }
}
